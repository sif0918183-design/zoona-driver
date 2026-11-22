-- Limousine transactional workflows. Apply only in a staging database after review.
begin;

create or replace function public.limousine_create_request(
  p_passenger_id uuid, p_city_id uuid, p_pickup_area text, p_start_at timestamptz,
  p_duration_days integer, p_requested_category_id uuid, p_passenger_count integer,
  p_usage_purpose text default null, p_notes text default null
) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.limousine_pricing%rowtype; v_id uuid; v_total numeric;
begin
  if p_start_at <= now() then raise exception 'start_must_be_future'; end if;
  if p_duration_days < 1 or p_duration_days > 90 then raise exception 'invalid_duration'; end if;
  if p_passenger_count < 1 or length(trim(coalesce(p_pickup_area,''))) not between 2 and 250 then raise exception 'invalid_request_details'; end if;
  if not exists(select 1 from public.customers where id=p_passenger_id) then raise exception 'passenger_not_found'; end if;
  select * into p from public.limousine_pricing
   where city_id=p_city_id and vehicle_category_id=p_requested_category_id and is_active for share;
  if not found then raise exception 'pricing_unavailable'; end if;
  if p_duration_days < p.min_days or (p.max_days is not null and p_duration_days > p.max_days) then raise exception 'duration_out_of_pricing_range'; end if;
  v_total := p.daily_price * p_duration_days;
  insert into public.limousine_requests(passenger_id,city_id,pickup_area,start_at,duration_days,requested_category_id,
    passenger_count,usage_purpose,notes,daily_price_snapshot,commission_rate_snapshot,estimated_total,status)
  values(p_passenger_id,p_city_id,trim(p_pickup_area),p_start_at,p_duration_days,p_requested_category_id,
    p_passenger_count,nullif(trim(coalesce(p_usage_purpose,'')),''),nullif(trim(coalesce(p_notes,'')), ''),
    p.daily_price,p.commission_rate,v_total,'open')
  returning id into v_id;
  return jsonb_build_object('ok',true,'request_id',v_id,'daily_price',p.daily_price,'estimated_total',v_total,
    'commission_rate',p.commission_rate);
end; $$;

create or replace function public.limousine_accept_request(p_request_id uuid,p_driver_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.limousine_requests%rowtype; d public.drivers%rowtype; cat public.vehicle_categories%rowtype;
  v_count integer; v_driver_rank integer; v_required_rank integer;
begin
  select * into r from public.limousine_requests where id=p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;
  if r.status not in ('open','awaiting_driver_selection') or r.start_at <= now() then raise exception 'request_not_available'; end if;
  select * into d from public.drivers where id=p_driver_id for share;
  if not found or not coalesce(d.is_active,false) or not coalesce(d.is_approved,false)
     or coalesce(d.is_banned,false) or d.status='SUSPENDED' then raise exception 'driver_not_eligible'; end if;
  select * into cat from public.vehicle_categories where id=r.requested_category_id;
  v_required_rank := case when cat.name_ar ilike '%اقتصادي%' then 1 when cat.name_ar ilike '%مريح%' then 2
    when cat.name_ar ilike '%SUV%' or cat.name_ar ilike '%عالي%' then 3 else 99 end;
  v_driver_rank := case when coalesce(d.car_type,d.vehicle_type,'') ilike '%economy%' or coalesce(d.car_type,d.vehicle_type,'') ilike '%اقتصادي%' then 1
    when coalesce(d.car_type,d.vehicle_type,'') ilike '%comfort%' or coalesce(d.car_type,d.vehicle_type,'') ilike '%مريح%' then 2
    when coalesce(d.car_type,d.vehicle_type,'') ilike '%vip%' or coalesce(d.car_type,d.vehicle_type,'') ilike '%suv%' or coalesce(d.car_type,d.vehicle_type,'') ilike '%عالي%' then 3
    else 0 end;
  if v_driver_rank < v_required_rank then raise exception 'vehicle_category_not_eligible'; end if;
  if exists(select 1 from public.limousine_acceptances where request_id=p_request_id and driver_id=p_driver_id and status in ('accepted','selected','contracted')) then
    return jsonb_build_object('ok',true,'already_accepted',true);
  end if;
  select count(*) into v_count from public.limousine_acceptances where request_id=p_request_id and status in ('accepted','selected','contracted');
  if v_count >= 10 then raise exception 'acceptance_limit_reached'; end if;
  insert into public.limousine_acceptances(request_id,driver_id,status) values(p_request_id,p_driver_id,'accepted');
  return jsonb_build_object('ok',true,'accepted_count',v_count+1);
end; $$;

create or replace function public.limousine_select_driver(p_request_id uuid,p_driver_id uuid,p_passenger_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.limousine_requests%rowtype; a public.limousine_acceptances%rowtype; c_id uuid;
  v_end timestamptz; v_hold timestamptz; v_hold_result jsonb;
begin
  select * into r from public.limousine_requests where id=p_request_id for update;
  if not found or r.passenger_id<>p_passenger_id then raise exception 'request_not_found_or_forbidden'; end if;
  if r.status not in ('open','awaiting_driver_selection') then raise exception 'request_not_selectable'; end if;
  select * into a from public.limousine_acceptances where request_id=p_request_id and driver_id=p_driver_id and status='accepted' for update;
  if not found then raise exception 'driver_has_not_accepted'; end if;
  if exists(select 1 from public.limousine_contracts where request_id=p_request_id and status in ('confirmed','awaiting_funding','booked','active','completion_requested','awaiting_settlement','disputed')) then
    raise exception 'live_contract_exists';
  end if;
  v_end := (((r.start_at at time zone 'Africa/Khartoum')::date + r.duration_days - 1) + time '17:00') at time zone 'Africa/Khartoum';
  v_hold := r.start_at - interval '20 hours';
  insert into public.limousine_contracts(request_id,passenger_id,driver_id,status,start_at,scheduled_end_at,duration_days,
    daily_price_snapshot,commission_rate_snapshot,contract_value_snapshot,commission_due,hold_due_at)
  values(r.id,r.passenger_id,p_driver_id,'confirmed',r.start_at,v_end,r.duration_days,r.daily_price_snapshot,
    r.commission_rate_snapshot,r.estimated_total,round(r.estimated_total*r.commission_rate_snapshot/100,2),v_hold)
  returning id into c_id;
  update public.limousine_acceptances set status='selected',updated_at=now() where id=a.id;
  -- Other accepted drivers remain eligible if this selection expires for insufficient balance.
  update public.limousine_requests set selected_driver_id=p_driver_id,status='driver_selected',updated_at=now() where id=r.id;
  insert into public.limousine_chats(request_id,contract_id,passenger_id,driver_id)
  values(r.id,c_id,r.passenger_id,p_driver_id);
  if now() >= v_hold then
    v_hold_result := public.limousine_hold_commission(c_id);
  else
    insert into public.limousine_notifications(request_id,contract_id,recipient_id,recipient_type,event_code,title,body)
    values(r.id,c_id,p_driver_id,'driver','LIMO_DRIVER_SELECTED','تم اختيارك للتأجير','تم اختيارك من الراكب. سيتم تأمين العمولة قبل موعد البداية بـ20 ساعة.');
    v_hold_result := jsonb_build_object('ok',true,'awaiting_hold_window',true,'hold_due_at',v_hold);
  end if;
  return jsonb_build_object('ok',true,'contract_id',c_id,'financial',v_hold_result);
end; $$;

create or replace function public.limousine_settle_contract(p_contract_id uuid,p_end_at timestamptz default now(),
  p_penalty_days integer default 0,p_resolution text default 'no_penalty')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.limousine_contracts%rowtype; v_end_local timestamp; v_start_date date; v_end_date date;
  v_used numeric; v_remaining integer; v_penalty integer; v_earned numeric; v_release numeric; v_driver public.drivers%rowtype;
begin
  select * into c from public.limousine_contracts where id=p_contract_id for update;
  if not found then raise exception 'contract_not_found'; end if;
  if c.status not in ('booked','active','awaiting_settlement','completion_requested') then
    if c.status='settled' then return jsonb_build_object('ok',true,'already_settled',true); end if;
    raise exception 'contract_not_settleable';
  end if;
  if c.commission_held <= 0 then raise exception 'commission_not_held'; end if;
  if p_resolution not in ('no_penalty','penalty') then raise exception 'invalid_resolution'; end if;
  v_end_local := least(p_end_at,c.scheduled_end_at) at time zone 'Africa/Khartoum';
  v_start_date := (c.start_at at time zone 'Africa/Khartoum')::date;
  v_end_date := v_end_local::date;
  if v_end_local < (c.start_at at time zone 'Africa/Khartoum') then raise exception 'end_before_start'; end if;
  v_used := greatest(0,(v_end_date-v_start_date)::numeric);
  if v_end_date >= v_start_date then
    if extract(hour from v_end_local) >= 12 then v_used := v_used + 1;
    else v_used := v_used + greatest(0,least(1,(extract(epoch from (v_end_local::time-time '07:00'))/36000)));
    end if;
  end if;
  v_used := least(v_used,c.duration_days);
  v_remaining := greatest(0,c.duration_days-ceil(v_used)::integer);
  v_penalty := case when p_resolution='penalty' then least(greatest(coalesce(p_penalty_days,0),0),v_remaining) else 0 end;
  v_earned := least(c.commission_held,round(c.daily_price_snapshot*(c.commission_rate_snapshot/100)*(v_used+v_penalty),2));
  v_release := greatest(0,c.commission_held-v_earned);
  select * into v_driver from public.drivers where id=c.driver_id for update;
  if v_release > 0 then
    update public.drivers set balance=coalesce(balance,0)+v_release where id=c.driver_id;
    insert into public.balance_transactions(driver_id,amount,type,description)
    values(c.driver_id,v_release,'commission_refund','LIMO contract '||c.id::text||' unused commission release');
    insert into public.limousine_ledger(contract_id,request_id,driver_id,entry_type,amount,idempotency_key,metadata)
    values(c.id,c.request_id,c.driver_id,'hold_release',v_release,'limo:release:'||c.id::text,
      jsonb_build_object('used_days',v_used,'penalty_days',v_penalty));
  end if;
  if v_earned > 0 then
    insert into public.limousine_ledger(contract_id,request_id,driver_id,entry_type,amount,idempotency_key,metadata)
    values(c.id,c.request_id,c.driver_id,'commission_earned',v_earned,'limo:earned:'||c.id::text,
      jsonb_build_object('used_days',v_used,'penalty_days',v_penalty));
  end if;
  update public.limousine_contracts set status='settled',commission_earned=v_earned,commission_released=v_release,
    actual_ended_at=p_end_at,settled_at=now(),admin_resolution=p_resolution,penalty_days=v_penalty,updated_at=now()
    where id=c.id;
  update public.limousine_requests set status='settled',updated_at=now() where id=c.request_id;
  insert into public.limousine_notifications(request_id,contract_id,recipient_id,recipient_type,event_code,title,body)
  values(c.request_id,c.id,c.driver_id,'driver','LIMO_SETTLEMENT_DONE','تمت تسوية عقد التأجير','تم احتساب العمولة عن المدة المنفذة وإعادة الرصيد غير المستحق.');
  return jsonb_build_object('ok',true,'earned',v_earned,'released',v_release,'used_days',v_used,'penalty_days',v_penalty);
end; $$;

create or replace function public.limousine_process_due()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r record; v_hold_count integer:=0; v_expired_count integer:=0; v_closed_count integer:=0;
begin
  for r in select id from public.limousine_contracts where status='confirmed' and hold_due_at<=now() order by hold_due_at limit 100 loop
    perform public.limousine_hold_commission(r.id); v_hold_count:=v_hold_count+1;
  end loop;
  for r in select id from public.limousine_contracts where status='awaiting_funding' and funding_deadline<=now() order by funding_deadline limit 100 loop
    perform public.limousine_expire_funding(r.id); v_expired_count:=v_expired_count+1;
  end loop;
  update public.limousine_contracts set status='active',actual_started_at=coalesce(actual_started_at,start_at),updated_at=now()
    where status='booked' and start_at<=now();
  for r in select id,scheduled_end_at from public.limousine_contracts where status in ('booked','active') and scheduled_end_at<=now() order by scheduled_end_at limit 100 loop
    perform public.limousine_settle_contract(r.id,r.scheduled_end_at,0,'no_penalty'); v_closed_count:=v_closed_count+1;
  end loop;
  return jsonb_build_object('holds_processed',v_hold_count,'funding_expired',v_expired_count,'auto_settled',v_closed_count);
end; $$;

revoke all on function public.limousine_create_request(uuid,uuid,text,timestamptz,integer,uuid,integer,text,text) from public,anon,authenticated;
revoke all on function public.limousine_accept_request(uuid,uuid) from public,anon,authenticated;
revoke all on function public.limousine_select_driver(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.limousine_settle_contract(uuid,timestamptz,integer,text) from public,anon,authenticated;
revoke all on function public.limousine_process_due() from public,anon,authenticated;
grant execute on function public.limousine_create_request(uuid,uuid,text,timestamptz,integer,uuid,integer,text,text) to service_role;
grant execute on function public.limousine_accept_request(uuid,uuid) to service_role;
grant execute on function public.limousine_select_driver(uuid,uuid,uuid) to service_role;
grant execute on function public.limousine_settle_contract(uuid,timestamptz,integer,text) to service_role;
grant execute on function public.limousine_process_due() to service_role;
commit;
