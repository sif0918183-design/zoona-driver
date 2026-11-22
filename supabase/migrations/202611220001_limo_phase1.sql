-- Tracka Limousine Platform — Phase 1 isolated schema
-- Target: Supabase PostgreSQL 17.6
-- IMPORTANT: Review and apply only after staging validation. This file is NOT auto-applied.
begin;

create extension if not exists pgcrypto;

create table if not exists public.limousine_pricing (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references public.cities(id) on delete restrict,
  vehicle_category_id uuid not null references public.vehicle_categories(id) on delete restrict,
  daily_price numeric(14,2) not null check (daily_price > 0),
  commission_rate numeric(7,4) not null check (commission_rate > 0 and commission_rate <= 100),
  is_active boolean not null default true,
  min_days integer not null default 1 check (min_days > 0),
  max_days integer check (max_days is null or max_days >= min_days),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(city_id, vehicle_category_id)
);

create table if not exists public.limousine_requests (
  id uuid primary key default gen_random_uuid(),
  passenger_id uuid not null,
  city_id uuid not null references public.cities(id) on delete restrict,
  pickup_area text not null,
  start_at timestamptz not null,
  duration_days integer not null check (duration_days between 1 and 90),
  requested_category_id uuid not null references public.vehicle_categories(id) on delete restrict,
  passenger_count integer not null default 1 check (passenger_count > 0),
  usage_purpose text,
  notes text,
  daily_price_snapshot numeric(14,2) not null check (daily_price_snapshot > 0),
  commission_rate_snapshot numeric(7,4) not null check (commission_rate_snapshot between 0 and 100),
  estimated_total numeric(14,2) not null check (estimated_total > 0),
  status text not null default 'open' check (status in
    ('open','awaiting_driver_selection','driver_selected','booked','active','completion_pending','settled','disputed','cancelled','suspended')),
  selected_driver_id uuid references public.drivers(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- start_at is validated in the transactional request RPC; now() is not immutable in CHECK.
);

create index if not exists idx_limo_requests_dispatch
  on public.limousine_requests(status, city_id, start_at);
create index if not exists idx_limo_requests_passenger
  on public.limousine_requests(passenger_id, created_at desc);

create table if not exists public.limousine_acceptances (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.limousine_requests(id) on delete restrict,
  driver_id uuid not null references public.drivers(id) on delete restrict,
  status text not null default 'accepted' check (status in
    ('accepted','selected','not_selected','funding_expired','withdrawn','contracted')),
  accepted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(request_id, driver_id)
);
create index if not exists idx_limo_acceptances_request on public.limousine_acceptances(request_id, status);

create table if not exists public.limousine_contracts (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.limousine_requests(id) on delete restrict,
  passenger_id uuid not null,
  driver_id uuid not null references public.drivers(id) on delete restrict,
  status text not null check (status in
    ('confirmed','awaiting_funding','booked','active','completion_requested','awaiting_settlement','settled','disputed','cancelled')),
  start_at timestamptz not null,
  scheduled_end_at timestamptz not null,
  duration_days integer not null check (duration_days > 0),
  daily_price_snapshot numeric(14,2) not null check (daily_price_snapshot > 0),
  commission_rate_snapshot numeric(7,4) not null check (commission_rate_snapshot between 0 and 100),
  contract_value_snapshot numeric(14,2) not null check (contract_value_snapshot > 0),
  commission_due numeric(14,2) not null check (commission_due >= 0),
  commission_held numeric(14,2) not null default 0 check (commission_held >= 0),
  commission_earned numeric(14,2) not null default 0 check (commission_earned >= 0),
  commission_released numeric(14,2) not null default 0 check (commission_released >= 0),
  hold_due_at timestamptz not null,
  funding_deadline timestamptz,
  funding_attempted_at timestamptz,
  booked_at timestamptz,
  actual_started_at timestamptz,
  actual_ended_at timestamptz,
  end_requested_by text check (end_requested_by in ('driver','passenger')),
  end_confirmed_at timestamptz,
  admin_resolution text check (admin_resolution in ('no_penalty','penalty','disputed')),
  penalty_days integer not null default 0 check (penalty_days >= 0),
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (scheduled_end_at > start_at),
  check (commission_earned + commission_released <= commission_held)
);
create unique index if not exists idx_limo_one_live_contract_per_request
  on public.limousine_contracts(request_id)
  where status in ('confirmed','awaiting_funding','booked','active','completion_requested','awaiting_settlement','disputed');
create index if not exists idx_limo_contracts_due
  on public.limousine_contracts(status, hold_due_at, funding_deadline);

create table if not exists public.limousine_ledger (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.limousine_contracts(id) on delete restrict,
  request_id uuid not null references public.limousine_requests(id) on delete restrict,
  driver_id uuid not null references public.drivers(id) on delete restrict,
  entry_type text not null check (entry_type in ('commission_hold','commission_earned','hold_release','penalty','reversal')),
  amount numeric(14,2) not null check (amount <> 0),
  idempotency_key text not null unique,
  reverses_entry_id uuid references public.limousine_ledger(id) on delete restrict,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_limo_ledger_contract on public.limousine_ledger(contract_id, created_at);

create table if not exists public.limousine_notifications (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references public.limousine_requests(id) on delete restrict,
  contract_id uuid references public.limousine_contracts(id) on delete restrict,
  recipient_id uuid not null,
  recipient_type text not null check (recipient_type in ('passenger','driver','admin')),
  event_code text not null,
  title text not null,
  body text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists idx_limo_notifications_recipient on public.limousine_notifications(recipient_type, recipient_id, created_at desc);

create table if not exists public.limousine_chats (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.limousine_requests(id) on delete restrict,
  contract_id uuid not null references public.limousine_contracts(id) on delete restrict,
  passenger_id uuid not null,
  driver_id uuid not null references public.drivers(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique(contract_id)
);
create table if not exists public.limousine_chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.limousine_chats(id) on delete restrict,
  sender_id uuid not null,
  sender_type text not null check (sender_type in ('passenger','driver','admin')),
  message text not null check (length(trim(message)) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index if not exists idx_limo_chat_messages_chat on public.limousine_chat_messages(chat_id, created_at);

-- Append-only financial journal: corrections must be represented by reversal entries.
create or replace function public.limousine_prevent_ledger_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'limousine_ledger is append-only; use a reversal entry';
end;
$$;
drop trigger if exists trg_limo_ledger_immutable on public.limousine_ledger;
create trigger trg_limo_ledger_immutable
before update or delete on public.limousine_ledger
for each row execute function public.limousine_prevent_ledger_mutation();

-- Hold the complete contract commission. Existing drivers.balance is the available balance;
-- the hold decreases it, and the unused amount is returned only at settlement.
create or replace function public.limousine_hold_commission(p_contract_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.limousine_contracts%rowtype;
  d public.drivers%rowtype;
  v_now timestamptz := now();
begin
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
    update public.limousine_contracts
       set status='awaiting_funding',
           funding_attempted_at=v_now,
           funding_deadline=least(v_now + interval '4 hours', start_at),
           updated_at=v_now
     where id=c.id;
    insert into public.limousine_notifications(request_id,contract_id,recipient_id,recipient_type,event_code,title,body,payload)
    values(c.request_id,c.id,c.driver_id,'driver','LIMO_COMMISSION_FUNDING_REQUIRED',
      'استكمال رصيد العمولة','رصيدك غير كافٍ لتأمين عمولة عقد التأجير. يرجى شحن الرصيد قبل انتهاء المهلة.',
      jsonb_build_object('required_amount',c.commission_due,'deadline',least(v_now + interval '4 hours',c.start_at)));
    return jsonb_build_object('ok',false,'reason','insufficient_balance','required',c.commission_due,'available',coalesce(d.balance,0),'deadline',least(v_now + interval '4 hours',c.start_at));
  end if;

  update public.drivers set balance=coalesce(balance,0)-c.commission_due where id=d.id;
  insert into public.balance_transactions(driver_id,amount,type,description)
  values(d.id,-c.commission_due,'commission_hold','LIMO contract '||c.id::text||' commission hold');
  insert into public.limousine_ledger(contract_id,request_id,driver_id,entry_type,amount,idempotency_key,metadata)
  values(c.id,c.request_id,c.driver_id,'commission_hold',-c.commission_due,'limo:hold:'||c.id::text,
    jsonb_build_object('balance_before',coalesce(d.balance,0),'balance_after',coalesce(d.balance,0)-c.commission_due));
  update public.limousine_contracts
     set status='booked',commission_held=c.commission_due,funding_deadline=null,booked_at=v_now,updated_at=v_now
   where id=c.id;
  update public.limousine_requests set status='booked',updated_at=v_now where id=c.request_id;
  insert into public.limousine_notifications(request_id,contract_id,recipient_id,recipient_type,event_code,title,body)
  values(c.request_id,c.id,c.passenger_id,'passenger','LIMO_COMMISSION_RESERVED','تم تأمين الحجز','تم تأمين عمولة التأجير وأصبح الحجز مؤكداً مالياً.');
  return jsonb_build_object('ok',true,'held',c.commission_due,'status','booked');
end;
$$;

-- Scheduled worker calls this function. It expires an underfunded selection without deleting
-- other acceptances, and returns the request to driver selection.
create or replace function public.limousine_expire_funding(p_contract_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.limousine_contracts%rowtype;
begin
  select * into c from public.limousine_contracts where id=p_contract_id for update;
  if not found then raise exception 'contract_not_found'; end if;
  if c.status <> 'awaiting_funding' or c.funding_deadline is null or now() < c.funding_deadline then
    return jsonb_build_object('ok',false,'reason','not_expired');
  end if;
  update public.limousine_acceptances set status='funding_expired',updated_at=now()
   where request_id=c.request_id and driver_id=c.driver_id and status in ('accepted','selected');
  update public.limousine_contracts set status='cancelled',updated_at=now() where id=c.id;
  update public.limousine_requests set status='awaiting_driver_selection',selected_driver_id=null,updated_at=now()
   where id=c.request_id;
  insert into public.limousine_notifications(request_id,contract_id,recipient_id,recipient_type,event_code,title,body)
  values(c.request_id,c.id,c.passenger_id,'passenger','LIMO_DRIVER_FUNDING_EXPIRED',
    'يرجى اختيار سائق بديل','لم يستكمل السائق تأمين العمولة خلال المهلة. يمكنك اختيار أحد السائقين الآخرين الذين قبلوا الطلب.');
  return jsonb_build_object('ok',true,'request_status','awaiting_driver_selection');
end;
$$;

-- Security boundary: clients do not write to platform tables directly. Backend APIs use service_role.
do $$
declare t text;
begin
  foreach t in array array['limousine_pricing','limousine_requests','limousine_acceptances','limousine_contracts',
    'limousine_ledger','limousine_notifications','limousine_chats','limousine_chat_messages']
  loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
end $$;

revoke all on function public.limousine_hold_commission(uuid) from public, anon, authenticated;
revoke all on function public.limousine_expire_funding(uuid) from public, anon, authenticated;
grant execute on function public.limousine_hold_commission(uuid) to service_role;
grant execute on function public.limousine_expire_funding(uuid) to service_role;

commit;
