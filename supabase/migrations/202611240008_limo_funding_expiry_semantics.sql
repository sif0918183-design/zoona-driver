-- Distinguish an expired funding attempt from a genuinely cancelled contract.
begin;

alter table public.limousine_contracts
  drop constraint if exists limousine_contracts_status_check;

alter table public.limousine_contracts
  add constraint limousine_contracts_status_check
  check (status = any (array[
    'confirmed','awaiting_funding','funding_expired','booked','active',
    'completion_requested','awaiting_settlement','settled','disputed','cancelled'
  ]::text[]));

-- Repair only rows that can be positively identified as funding-expiry attempts.
-- Genuine cancellations remain unchanged.
update public.limousine_contracts c
set status='funding_expired', updated_at=now()
where c.status='cancelled'
  and c.commission_held=0
  and c.commission_earned=0
  and c.commission_released=0
  and c.funding_deadline is not null
  and exists (
    select 1 from public.limousine_acceptances a
    where a.request_id=c.request_id
      and a.driver_id=c.driver_id
      and a.status='funding_expired'
  );

create or replace function public.limousine_expire_funding(p_contract_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.limousine_contracts%rowtype;
  r public.limousine_requests%rowtype;
  v_request_id uuid;
  v_request_status text;
begin
  select request_id into v_request_id
  from public.limousine_contracts where id=p_contract_id;
  if not found then raise exception 'contract_not_found'; end if;

  select * into r from public.limousine_requests where id=v_request_id for update;
  select * into c from public.limousine_contracts where id=p_contract_id for update;
  if not found then raise exception 'contract_not_found'; end if;

  if c.status <> 'awaiting_funding' or c.funding_deadline is null or now() < c.funding_deadline then
    return jsonb_build_object('ok',false,'reason','not_expired');
  end if;

  update public.limousine_acceptances
    set status='funding_expired',updated_at=now()
    where request_id=c.request_id and driver_id=c.driver_id
      and status in ('accepted','selected');

  -- This is an incomplete funding attempt, not a cancelled contract.
  update public.limousine_contracts
    set status='funding_expired',updated_at=now()
    where id=c.id;

  v_request_status := case
    when r.start_at <= now() then 'expired'
    else 'awaiting_driver_selection'
  end;

  update public.limousine_requests
    set status=v_request_status,selected_driver_id=null,updated_at=now()
    where id=c.request_id;

  if v_request_status='expired' then
    update public.limousine_acceptances
      set status='withdrawn',updated_at=now()
      where request_id=c.request_id and status='accepted';
    insert into public.limousine_notifications(
      request_id,contract_id,recipient_id,recipient_type,event_code,title,body
    ) values (
      c.request_id,c.id,c.passenger_id,'passenger','LIMO_REQUEST_EXPIRED',
      'فات وقت طلب التأجير',
      'انتهى موعد بداية التأجير دون تأمين العمولة، ولذلك أُغلق الطلب تلقائياً.'
    );
  else
    insert into public.limousine_notifications(
      request_id,contract_id,recipient_id,recipient_type,event_code,title,body
    ) values (
      c.request_id,c.id,c.passenger_id,'passenger','LIMO_DRIVER_FUNDING_EXPIRED',
      'يرجى اختيار سائق بديل',
      'لم يستكمل السائق تأمين العمولة خلال المهلة. يمكنك اختيار أحد السائقين الآخرين الذين قبلوا الطلب.'
    );
  end if;

  insert into public.limousine_notifications(
    request_id,contract_id,recipient_id,recipient_type,event_code,title,body
  ) values (
    c.request_id,c.id,c.driver_id,'driver','LIMO_DRIVER_FUNDING_EXPIRED',
    'انتهت مهلة تأمين العمولة',
    'لم يتم تأمين العمولة خلال المهلة المحددة، وانتهى اختيارك لهذا الطلب.'
  );

  return jsonb_build_object('ok',true,'request_status',v_request_status);
end;
$$;

commit;
