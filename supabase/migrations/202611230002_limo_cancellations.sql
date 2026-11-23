-- Limousine cancellation workflows: pre-booking unilateral withdrawal and post-booking dual approval.
-- Apply only after the feature branch is deployed to an isolated preview database.
begin;

create table if not exists public.limousine_cancellation_requests (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.limousine_contracts(id) on delete restrict,
  request_id uuid not null references public.limousine_requests(id) on delete restrict,
  requested_by_id uuid not null,
  requested_by_role text not null check (requested_by_role in ('passenger','driver')),
  other_party_id uuid not null,
  other_party_role text not null check (other_party_role in ('passenger','driver')),
  reason text not null check (length(trim(reason)) between 2 and 1000),
  status text not null default 'pending_counterparty'
    check (status in ('pending_counterparty','awaiting_admin','rejected','approved')),
  counterparty_responded_at timestamptz,
  admin_id text,
  admin_resolution text check (admin_resolution in ('no_penalty','penalty')),
  penalty_days integer not null default 0 check (penalty_days >= 0),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_limo_cancellation_contract
  on public.limousine_cancellation_requests(contract_id, created_at desc);
create index if not exists idx_limo_cancellation_admin
  on public.limousine_cancellation_requests(status, created_at)
  where status='awaiting_admin';
create unique index if not exists idx_limo_one_pending_cancellation
  on public.limousine_cancellation_requests(contract_id)
  where status in ('pending_counterparty','awaiting_admin');

alter table public.limousine_cancellation_requests enable row level security;
revoke all on public.limousine_cancellation_requests from anon, authenticated;
grant all on public.limousine_cancellation_requests to service_role;

-- Keep the same request -> contract lock order used by cancellation and funding-expiry flows.
create or replace function public.limousine_hold_commission(p_contract_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  c public.limousine_contracts%rowtype;
  d public.drivers%rowtype;
  v_now timestamptz := now();
  v_request_id uuid;
begin
  select request_id into v_request_id from public.limousine_contracts where id=p_contract_id;
  if not found then raise exception 'contract_not_found'; end if;
  perform 1 from public.limousine_requests where id=v_request_id for update;
  select * into c from public.limousine_contracts where id=p_contract_id for update;
  if not found then raise exception 'contract_not_found'; end if;
  if c.status not in ('confirmed','awaiting_funding') then
    return jsonb_build_object('ok',false,'reason','invalid_contract_state','status',c.status);
  end if;
  if exists(select 1 from public.limousine_ledger where contract_id=c.id and entry_type='commission_hold') then
    return jsonb_build_object('ok',true,'already_held',true,'held',c.commission_held);
  end if;
  if v_now < c.hold_due_at then
    return jsonb_build_object('ok',false,'reason','hold_not_due','hold_due_at',c.hold_due_at);
  end if;
  select * into d from public.drivers where id=c.driver_id for update;
  if not found then raise exception 'driver_not_found'; end if;
  if coalesce(d.balance,0) < c.commission_due then
    update public.limousine_contracts set status='awaiting_funding',funding_attempted_at=v_now,
      funding_deadline=least(v_now + interval '4 hours',start_at),updated_at=v_now where id=c.id;
    insert into public.limousine_notifications(request_id,contract_id,recipient_id,recipient_type,event_code,title,body,payload)
    values(c.request_id,c.id,c.driver_id,'driver','LIMO_COMMISSION_FUNDING_REQUIRED',
      'استكمال رصيد العمولة','رصيدك غير كافٍ لتأمين عمولة عقد التأجير. يرجى شحن الرصيد قبل انتهاء المهلة.',
      jsonb_build_object('required_amount',c.commission_due,'deadline',least(v_now + interval '4 hours',c.start_at)));
    insert into public.limousine_notifications(request_id,contract_id,recipient_id,recipient_type,event_code,title,body)
    values(c.request_id,c.id,c.passenger_id,'passenger','LIMO_FUNDING_PENDING','بانتظار تأمين العمولة','تم اختيار السائق، ويجري استكمال تأمين العمولة قبل تأكيد الحجز.');
    return jsonb_build_object('ok',false,'reason','insufficient_balance','required',c.commission_due,
      'available',coalesce(d.balance,0),'deadline',least(v_now + interval '4 hours',c.start_at));
  end if;
  update public.drivers set balance=coalesce(balance,0)-c.commission_due where id=d.id;
  insert into public.balance_transactions(driver_id,amount,type,description)
  values(d.id,-c.commission_due,'commission_hold','LIMO contract '||c.id::text||' commission hold');
  insert into public.limousine_ledger(contract_id,request_id,driver_id,entry_type,amount,idempotency_key,metadata)
  values(c.id,c.request_id,c.driver_id,'commission_hold',-c.commission_due,'limo:hold:'||c.id::text,
    jsonb_build_object('balance_before',coalesce(d.balance,0),'balance_after',coalesce(d.balance,0)-c.commission_due));
  update public.limousine_contracts set status='booked',commission_held=c.commission_due,
    funding_deadline=null,booked_at=v_now,updated_at=v_now where id=c.id;
  update public.limousine_requests set status='booked',updated_at=v_now where id=c.request_id;
  insert into public.limousine_notifications(request_id,contract_id,recipient_id,recipient_type,event_code,title,body)
  values(c.request_id,c.id,c.passenger_id,'passenger','LIMO_COMMISSION_RESERVED','تم تأمين الحجز','تم تأمين عمولة التأجير وأصبح الحجز مؤكداً مالياً.'),
        (c.request_id,c.id,c.driver_id,'driver','LIMO_BOOKING_CONFIRMED','تم تأكيد عقد التأجير','تم تأمين العمولة وأصبح عقد التأجير مؤكداً مالياً.');
  return jsonb_build_object('ok',true,'held',c.commission_due,'status','booked');
end; $$;

create or replace function public.limousine_cancel_request(p_request_id uuid,p_passenger_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.limousine_requests%rowtype; c public.limousine_contracts%rowtype;
begin
  select * into r from public.limousine_requests where id=p_request_id for update;
  if not found or r.passenger_id<>p_passenger_id then raise exception 'request_not_found_or_forbidden'; end if;
  if r.status not in ('open','awaiting_driver_selection','driver_selected') then
    raise exception 'cancellation_requires_mutual_approval';
  end if;
  select * into c from public.limousine_contracts where request_id=r.id
    and status in ('confirmed','awaiting_funding') order by created_at desc limit 1 for update;
  if found then
    if c.commission_held>0 or exists(select 1 from public.limousine_ledger where contract_id=c.id and entry_type='commission_hold') then
      raise exception 'cancellation_requires_mutual_approval';
    end if;
    update public.limousine_contracts set status='cancelled',updated_at=now() where id=c.id;
  end if;
  if exists(select 1 from public.limousine_contracts where request_id=r.id
      and status in ('booked','active','completion_requested','awaiting_settlement','disputed')) then
    raise exception 'cancellation_requires_mutual_approval';
  end if;
  update public.limousine_acceptances set status='withdrawn',updated_at=now()
    where request_id=r.id and status in ('accepted','selected','contracted');
  update public.limousine_requests set status='cancelled',selected_driver_id=null,updated_at=now() where id=r.id;
  insert into public.limousine_notifications(request_id,recipient_id,recipient_type,event_code,title,body)
  select r.id,a.driver_id,'driver','LIMO_REQUEST_CANCELLED','ألغى الراكب طلب التأجير','تم إلغاء طلب التأجير من الراكب قبل تأمين العمولة.'
    from public.limousine_acceptances a where a.request_id=r.id;
  insert into public.limousine_notifications(request_id,recipient_id,recipient_type,event_code,title,body)
  values(r.id,r.passenger_id,'passenger','LIMO_REQUEST_CANCELLED','تم إلغاء الطلب','تم إلغاء طلب التأجير دون حجز أو خصم عمولة.');
  return jsonb_build_object('ok',true,'status','cancelled');
end; $$;

create or replace function public.limousine_withdraw_acceptance(p_request_id uuid,p_driver_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.limousine_requests%rowtype; a public.limousine_acceptances%rowtype; c public.limousine_contracts%rowtype;
begin
  select * into r from public.limousine_requests where id=p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;
  select * into a from public.limousine_acceptances where request_id=r.id and driver_id=p_driver_id for update;
  if not found or a.status not in ('accepted','selected') then raise exception 'acceptance_not_withdrawable'; end if;
  if r.status not in ('open','awaiting_driver_selection','driver_selected') then
    raise exception 'withdrawal_not_allowed_after_booking';
  end if;
  if a.status='selected' then
    select * into c from public.limousine_contracts where request_id=r.id and driver_id=p_driver_id
      and status in ('confirmed','awaiting_funding') order by created_at desc limit 1 for update;
    if found then
      if c.commission_held>0 or exists(select 1 from public.limousine_ledger where contract_id=c.id and entry_type='commission_hold') then
        raise exception 'withdrawal_not_allowed_after_booking';
      end if;
      update public.limousine_contracts set status='cancelled',updated_at=now() where id=c.id;
    end if;
    update public.limousine_requests set status='awaiting_driver_selection',selected_driver_id=null,updated_at=now()
      where id=r.id and status='driver_selected';
  end if;
  update public.limousine_acceptances set status='withdrawn',updated_at=now() where id=a.id;
  insert into public.limousine_notifications(request_id,recipient_id,recipient_type,event_code,title,body)
  values(r.id,r.passenger_id,'passenger','LIMO_DRIVER_WITHDREW','سحب سائق قبوله','سحب السائق قبوله لهذا الطلب قبل تأمين العمولة. يمكنك اختيار سائق آخر من القائمة.');
  insert into public.limousine_notifications(request_id,recipient_id,recipient_type,event_code,title,body)
  values(r.id,p_driver_id,'driver','LIMO_ACCEPTANCE_WITHDRAWN','تم سحب قبولك','تم سحب قبولك لهذا الطلب دون خصم أو حجز عمولة.');
  return jsonb_build_object('ok',true,'request_status',case when a.status='selected' then 'awaiting_driver_selection' else r.status end);
end; $$;

create or replace function public.limousine_request_cancellation(
  p_contract_id uuid,p_user_id uuid,p_user_role text,p_reason text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.limousine_contracts%rowtype; v_other_id uuid; v_other_role text; v_id uuid;
begin
  select * into c from public.limousine_contracts where id=p_contract_id for update;
  if not found then raise exception 'contract_not_found'; end if;
  if (p_user_role='passenger' and c.passenger_id<>p_user_id) or
     (p_user_role='driver' and c.driver_id<>p_user_id) or p_user_role not in ('passenger','driver') then
    raise exception 'contract_not_owned';
  end if;
  if c.status not in ('booked','active') or c.commission_held<=0 then
    raise exception 'contract_not_cancellable';
  end if;
  if length(trim(coalesce(p_reason,''))) not between 2 and 1000 then raise exception 'invalid_cancellation_reason'; end if;
  if exists(select 1 from public.limousine_cancellation_requests where contract_id=c.id
    and status in ('pending_counterparty','awaiting_admin')) then raise exception 'cancellation_already_pending'; end if;
  v_other_id:=case when p_user_role='passenger' then c.driver_id else c.passenger_id end;
  v_other_role:=case when p_user_role='passenger' then 'driver' else 'passenger' end;
  insert into public.limousine_cancellation_requests(contract_id,request_id,requested_by_id,requested_by_role,
    other_party_id,other_party_role,reason)
  values(c.id,c.request_id,p_user_id,p_user_role,v_other_id,v_other_role,trim(p_reason)) returning id into v_id;
  insert into public.limousine_notifications(request_id,contract_id,recipient_id,recipient_type,event_code,title,body,payload)
  values(c.request_id,c.id,v_other_id,v_other_role,'LIMO_CANCELLATION_CONFIRMATION_REQUIRED',
    'طلب إلغاء عقد التأجير','يرجى مراجعة سبب طلب الإلغاء والموافقة عليه أو رفضه.',
    jsonb_build_object('cancellation_request_id',v_id,'reason',trim(p_reason)));
  return jsonb_build_object('ok',true,'status','pending_counterparty','cancellation_request_id',v_id);
end; $$;

create or replace function public.limousine_respond_cancellation(
  p_contract_id uuid,p_user_id uuid,p_user_role text,p_decision text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.limousine_contracts%rowtype; x public.limousine_cancellation_requests%rowtype;
  v_status text;
begin
  select * into c from public.limousine_contracts where id=p_contract_id for update;
  if not found then raise exception 'contract_not_found'; end if;
  if (p_user_role='passenger' and c.passenger_id<>p_user_id) or
     (p_user_role='driver' and c.driver_id<>p_user_id) or p_user_role not in ('passenger','driver') then
    raise exception 'contract_not_owned';
  end if;
  if p_decision not in ('approve','reject') then raise exception 'invalid_cancellation_decision'; end if;
  select * into x from public.limousine_cancellation_requests where contract_id=c.id
    and status='pending_counterparty' order by created_at desc limit 1 for update;
  if not found or x.other_party_id<>p_user_id or x.other_party_role<>p_user_role then
    raise exception 'no_cancellation_confirmation_pending';
  end if;
  v_status:=case when p_decision='approve' then 'awaiting_admin' else 'rejected' end;
  update public.limousine_cancellation_requests set status=v_status,counterparty_responded_at=now(),updated_at=now()
    where id=x.id;
  insert into public.limousine_notifications(request_id,contract_id,recipient_id,recipient_type,event_code,title,body)
  values(c.request_id,c.id,x.requested_by_id,x.requested_by_role,
    case when p_decision='approve' then 'LIMO_CANCELLATION_ACCEPTED' else 'LIMO_CANCELLATION_REJECTED' end,
    case when p_decision='approve' then 'وافق الطرف الآخر على الإلغاء' else 'رفض الطرف الآخر طلب الإلغاء' end,
    case when p_decision='approve' then 'وافق الطرف الآخر. ينتظر العقد الآن اعتماد إدارة تراكا.' else 'رفض الطرف الآخر طلب الإلغاء، ويظل العقد قائماً.' end);
  return jsonb_build_object('ok',true,'status',v_status);
end; $$;

create or replace function public.limousine_admin_resolve_cancellation(
  p_contract_id uuid,p_admin_id text,p_resolution text,p_penalty_days integer default 0
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.limousine_contracts%rowtype; x public.limousine_cancellation_requests%rowtype;
  v_end timestamptz; v_result jsonb;
begin
  select * into x from public.limousine_cancellation_requests where contract_id=p_contract_id
    and status='awaiting_admin' order by created_at desc limit 1 for update;
  if not found then raise exception 'cancellation_not_awaiting_admin'; end if;
  select * into c from public.limousine_contracts where id=p_contract_id for update;
  if not found or c.status not in ('booked','active') or c.commission_held<=0 then
    raise exception 'contract_not_cancellable';
  end if;
  if p_resolution not in ('no_penalty','penalty') then raise exception 'invalid_resolution'; end if;
  if coalesce(p_penalty_days,0)<0 then raise exception 'invalid_penalty_days'; end if;
  v_end:=least(greatest(now(),c.start_at),c.scheduled_end_at);
  v_result:=public.limousine_settle_contract(c.id,v_end,
    case when p_resolution='penalty' then p_penalty_days else 0 end,p_resolution);
  update public.limousine_contracts set status='cancelled',updated_at=now() where id=c.id;
  update public.limousine_requests set status='cancelled',updated_at=now() where id=c.request_id;
  update public.limousine_cancellation_requests set status='approved',admin_id=p_admin_id,
    admin_resolution=p_resolution,penalty_days=coalesce((v_result->>'penalty_days')::integer,0),
    resolved_at=now(),updated_at=now() where id=x.id;
  insert into public.limousine_notifications(request_id,contract_id,recipient_id,recipient_type,event_code,title,body,payload)
  values(c.request_id,c.id,c.passenger_id,'passenger','LIMO_CANCELLATION_APPROVED','اعتمدت الإدارة إلغاء العقد',
    'اعتمدت إدارة تراكا إلغاء العقد وإجراء التسوية المالية.',jsonb_build_object('resolution',p_resolution,'penalty_days',p_penalty_days)),
        (c.request_id,c.id,c.driver_id,'driver','LIMO_CANCELLATION_APPROVED','اعتمدت الإدارة إلغاء العقد',
    'اعتمدت إدارة تراكا إلغاء العقد وإجراء التسوية المالية.',jsonb_build_object('resolution',p_resolution,'penalty_days',p_penalty_days));
  return jsonb_build_object('ok',true,'status','cancelled','settlement',v_result);
end; $$;

revoke all on function public.limousine_cancel_request(uuid,uuid) from public,anon,authenticated;
revoke all on function public.limousine_withdraw_acceptance(uuid,uuid) from public,anon,authenticated;
revoke all on function public.limousine_request_cancellation(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.limousine_respond_cancellation(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.limousine_admin_resolve_cancellation(uuid,text,text,integer) from public,anon,authenticated;
grant execute on function public.limousine_cancel_request(uuid,uuid) to service_role;
grant execute on function public.limousine_withdraw_acceptance(uuid,uuid) to service_role;
grant execute on function public.limousine_request_cancellation(uuid,uuid,text,text) to service_role;
grant execute on function public.limousine_respond_cancellation(uuid,uuid,text,text) to service_role;
grant execute on function public.limousine_admin_resolve_cancellation(uuid,uuid,text,integer) to service_role;

commit;
