-- Add a terminal request state for limousine requests that pass their start time
-- without a funded booking. Apply after 202611220001 and 202611220002.
begin;

alter table public.limousine_requests
  drop constraint if exists limousine_requests_status_check;

alter table public.limousine_requests
  add constraint limousine_requests_status_check
  check (status in ('open','awaiting_driver_selection','driver_selected','booked','active',
    'completion_pending','settled','disputed','cancelled','expired','suspended'));

create or replace function public.limousine_expire_funding(p_contract_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.limousine_contracts%rowtype;
  r public.limousine_requests%rowtype;
  v_request_status text;
begin
  select request_id into c.request_id from public.limousine_contracts where id=p_contract_id;
  if not found then raise exception 'contract_not_found'; end if;
  select * into r from public.limousine_requests where id=c.request_id for update;
  select * into c from public.limousine_contracts where id=p_contract_id for update;
  if not found then raise exception 'contract_not_found'; end if;
  if c.status <> 'awaiting_funding' or c.funding_deadline is null or now() < c.funding_deadline then
    return jsonb_build_object('ok',false,'reason','not_expired');
  end if;

  update public.limousine_acceptances set status='funding_expired',updated_at=now()
   where request_id=c.request_id and driver_id=c.driver_id and status in ('accepted','selected');
  update public.limousine_contracts set status='cancelled',updated_at=now() where id=c.id;

  v_request_status := case when r.start_at <= now() then 'expired' else 'awaiting_driver_selection' end;
  update public.limousine_requests
     set status=v_request_status,selected_driver_id=null,updated_at=now()
   where id=c.request_id;

  if v_request_status='expired' then
    update public.limousine_acceptances set status='withdrawn',updated_at=now()
     where request_id=c.request_id and status='accepted';
    insert into public.limousine_notifications(request_id,contract_id,recipient_id,recipient_type,event_code,title,body)
    values(c.request_id,c.id,c.passenger_id,'passenger','LIMO_REQUEST_EXPIRED','فات وقت طلب التأجير',
      'انتهى موعد بداية التأجير دون تأمين العمولة، ولذلك أُغلق الطلب تلقائياً.');
  else
    insert into public.limousine_notifications(request_id,contract_id,recipient_id,recipient_type,event_code,title,body)
    values(c.request_id,c.id,c.passenger_id,'passenger','LIMO_DRIVER_FUNDING_EXPIRED',
      'يرجى اختيار سائق بديل','لم يستكمل السائق تأمين العمولة خلال المهلة. يمكنك اختيار أحد السائقين الآخرين الذين قبلوا الطلب.');
  end if;

  insert into public.limousine_notifications(request_id,contract_id,recipient_id,recipient_type,event_code,title,body)
  values(c.request_id,c.id,c.driver_id,'driver','LIMO_DRIVER_FUNDING_EXPIRED',
    'انتهت مهلة تأمين العمولة','لم يتم تأمين العمولة خلال المهلة المحددة، وانتهى اختيارك لهذا الطلب.');

  return jsonb_build_object('ok',true,'request_status',v_request_status);
end;
$$;

create or replace function public.limousine_process_due()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  r record;
  v_hold_count integer:=0;
  v_expired_count integer:=0;
  v_closed_count integer:=0;
  v_request_expired_count integer:=0;
begin
  for r in select id from public.limousine_contracts
    where status='confirmed' and hold_due_at<=now()
    order by hold_due_at limit 100
  loop
    perform public.limousine_hold_commission(r.id);
    v_hold_count:=v_hold_count+1;
  end loop;

  -- Retry funding during the grace period; a top-up must be captured before the deadline.
  for r in select c.id from public.limousine_contracts c
    join public.drivers d on d.id=c.driver_id
    where c.status='awaiting_funding' and c.funding_deadline>now()
      and coalesce(d.balance,0)>=c.commission_due
    order by c.funding_deadline limit 100
  loop
    perform public.limousine_hold_commission(r.id);
    v_hold_count:=v_hold_count+1;
  end loop;

  for r in select id from public.limousine_contracts
    where status='awaiting_funding' and funding_deadline<=now()
    order by funding_deadline limit 100
  loop
    perform public.limousine_expire_funding(r.id);
    v_expired_count:=v_expired_count+1;
  end loop;

  for r in select id,request_id,passenger_id,driver_id from public.limousine_contracts
    where status='booked' and start_at<=now()
    order by start_at limit 100
  loop
    update public.limousine_contracts
       set status='active',actual_started_at=coalesce(actual_started_at,start_at),updated_at=now()
     where id=r.id and status='booked';
    insert into public.limousine_notifications(request_id,contract_id,recipient_id,recipient_type,event_code,title,body)
    values(r.request_id,r.id,r.passenger_id,'passenger','LIMO_RENTAL_STARTED','بدأ عقد التأجير','بدأت فترة التأجير وفق الموعد المحدد.'),
          (r.request_id,r.id,r.driver_id,'driver','LIMO_RENTAL_STARTED','بدأ عقد التأجير','بدأت فترة التأجير وفق الموعد المحدد.');
  end loop;

  for r in select id,scheduled_end_at from public.limousine_contracts
    where status in ('booked','active') and scheduled_end_at<=now()
    order by scheduled_end_at limit 100
  loop
    perform public.limousine_settle_contract(r.id,r.scheduled_end_at,0,'no_penalty');
    v_closed_count:=v_closed_count+1;
  end loop;

  -- A request is expired only when no selected/funded/live contract remains.
  for r in select q.id,q.passenger_id from public.limousine_requests q
    where q.status in ('open','awaiting_driver_selection','driver_selected')
      and q.start_at<=now()
      and not exists (
        select 1 from public.limousine_contracts c
        where c.request_id=q.id
          and c.status in ('confirmed','awaiting_funding','booked','active',
            'completion_requested','awaiting_settlement','disputed')
      )
    order by q.start_at limit 100
  loop
    update public.limousine_requests set status='expired',selected_driver_id=null,updated_at=now()
      where id=r.id and status in ('open','awaiting_driver_selection','driver_selected');
    update public.limousine_acceptances set status='withdrawn',updated_at=now()
      where request_id=r.id and status='accepted';
    insert into public.limousine_notifications(request_id,recipient_id,recipient_type,event_code,title,body)
    values(r.id,r.passenger_id,'passenger','LIMO_REQUEST_EXPIRED','فات وقت طلب التأجير',
      'انتهى موعد بداية التأجير دون اختيار سائق وتأمين العمولة، ولذلك أُغلق الطلب تلقائياً.');
    v_request_expired_count:=v_request_expired_count+1;
  end loop;

  return jsonb_build_object('holds_processed',v_hold_count,'funding_expired',v_expired_count,
    'auto_settled',v_closed_count,'requests_expired',v_request_expired_count);
end; $$;

revoke all on function public.limousine_process_due() from public,anon,authenticated;
grant execute on function public.limousine_process_due() to service_role;
revoke all on function public.limousine_expire_funding(uuid) from public,anon,authenticated;
grant execute on function public.limousine_expire_funding(uuid) to service_role;

commit;
