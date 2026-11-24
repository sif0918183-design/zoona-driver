-- Require exact vehicle-category matching for limousine drivers.
-- The current instant-ride categories are distinct vehicle types, not a rank ladder.
create or replace function public.limousine_create_request(
  p_passenger_id uuid,p_city_id uuid,p_pickup_area text,p_start_at timestamptz,
  p_duration_days integer,p_requested_category_id uuid,p_passenger_count integer,
  p_usage_purpose text default null,p_notes text default null
) returns jsonb
language plpgsql security definer
set search_path to 'public','pg_temp'
as $function$
declare
  p public.limousine_pricing%rowtype;
  v_id uuid;
  v_total numeric;
  v_start_local timestamp;
  v_category_key text;
begin
  v_start_local:=p_start_at at time zone 'Africa/Khartoum';
  if p_start_at<=now() then raise exception 'start_must_be_future'; end if;
  if v_start_local::time<>time '07:00:00' then raise exception 'invalid_start_time'; end if;
  if p_duration_days is null or p_duration_days<1 or p_duration_days>90 then raise exception 'invalid_duration'; end if;
  if p_passenger_count<1 or p_passenger_count>30
    or length(trim(coalesce(p_pickup_area,''))) not between 2 and 250
    or length(coalesce(p_usage_purpose,''))>250 or length(coalesce(p_notes,''))>1000 then
    raise exception 'invalid_request_details';
  end if;
  if not exists(select 1 from public.customers where id=p_passenger_id) then raise exception 'passenger_not_found'; end if;

  select instant_vehicle_id into v_category_key
    from public.vehicle_categories where id=p_requested_category_id and is_active=true;
  if v_category_key is null or v_category_key not in ('tuktuk','economy','comfort','minibus','pickup') then
    raise exception 'pricing_unavailable';
  end if;
  select * into p from public.limousine_pricing
   where city_id=p_city_id and vehicle_category_id=p_requested_category_id and is_active for share;
  if not found then raise exception 'pricing_unavailable'; end if;
  if p.max_days is not null and p_duration_days>p.max_days then raise exception 'duration_out_of_pricing_range'; end if;
  v_total:=p.daily_price*p_duration_days;

  insert into public.limousine_requests(passenger_id,city_id,pickup_area,start_at,duration_days,requested_category_id,
    passenger_count,usage_purpose,notes,daily_price_snapshot,commission_rate_snapshot,estimated_total,status)
  values(p_passenger_id,p_city_id,trim(p_pickup_area),p_start_at,p_duration_days,p_requested_category_id,
    p_passenger_count,nullif(trim(coalesce(p_usage_purpose,'')),''),nullif(trim(coalesce(p_notes,'')),''),p.daily_price,p.commission_rate,v_total,'open')
  returning id into v_id;

  insert into public.limousine_notifications(request_id,recipient_id,recipient_type,event_code,title,body,payload)
  select v_id,d.id,'driver','LIMO_NEW_REQUEST','طلب تأجير جديد','يوجد طلب تأجير يومي جديد يناسب فئة سيارتك.',
    jsonb_build_object('city_id',p_city_id,'start_at',p_start_at,'vehicle_category',v_category_key)
  from public.drivers d
  where coalesce(d.is_active,false) and coalesce(d.is_approved,false)
    and coalesce(d.is_available,false) and not coalesce(d.is_banned,false)
    and coalesce(nullif(d.car_type,''),d.vehicle_type,'')=v_category_key;

  return jsonb_build_object('ok',true,'request_id',v_id,'daily_price',p.daily_price,
    'estimated_total',v_total,'commission_rate',p.commission_rate);
end;
$function$;

create or replace function public.limousine_accept_request(p_request_id uuid,p_driver_id uuid)
returns jsonb
language plpgsql security definer
set search_path to 'public','pg_temp'
as $function$
declare
  r public.limousine_requests%rowtype;
  d public.drivers%rowtype;
  v_count integer;
  v_category_key text;
  v_driver_key text;
  v_end timestamptz;
begin
  select * into r from public.limousine_requests where id=p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;
  if r.status not in ('open','awaiting_driver_selection') or r.start_at<=now() then raise exception 'request_not_available'; end if;

  select * into d from public.drivers where id=p_driver_id for share;
  if not found or not coalesce(d.is_active,false) or not coalesce(d.is_approved,false)
    or coalesce(d.is_banned,false) or not coalesce(d.is_available,false) or d.status='SUSPENDED' then
    raise exception 'driver_not_eligible';
  end if;

  select instant_vehicle_id into v_category_key
    from public.vehicle_categories where id=r.requested_category_id and is_active=true;
  v_driver_key:=coalesce(nullif(d.car_type,''),d.vehicle_type,'');
  if v_category_key is null or v_driver_key<>v_category_key then
    raise exception 'vehicle_category_not_eligible';
  end if;

  v_end:=(((r.start_at at time zone 'Africa/Khartoum')::date+r.duration_days-1)+time '17:00') at time zone 'Africa/Khartoum';
  if exists(select 1 from public.limousine_contracts c where c.driver_id=p_driver_id
    and c.status in ('confirmed','awaiting_funding','booked','active','completion_requested','awaiting_settlement','disputed')
    and c.start_at<v_end and c.scheduled_end_at>r.start_at) then
    raise exception 'driver_has_overlapping_limo_contract';
  end if;
  if exists(select 1 from public.limousine_acceptances where request_id=p_request_id and driver_id=p_driver_id and status in ('accepted','selected','contracted')) then
    return jsonb_build_object('ok',true,'already_accepted',true);
  end if;
  select count(*) into v_count from public.limousine_acceptances where request_id=p_request_id and status in ('accepted','selected','contracted');
  if v_count>=10 then raise exception 'acceptance_limit_reached'; end if;
  insert into public.limousine_acceptances(request_id,driver_id,status) values(p_request_id,p_driver_id,'accepted');
  insert into public.limousine_notifications(request_id,recipient_id,recipient_type,event_code,title,body)
  values(r.id,r.passenger_id,'passenger','LIMO_DRIVER_ACCEPTED','سائق جديد قبل طلبك','أصبح لديك سائق جديد ضمن قائمة السائقين الذين قبلوا طلب التأجير.');
  return jsonb_build_object('ok',true,'accepted_count',v_count+1);
end;
$function$;

comment on function public.limousine_accept_request(uuid,uuid)
is 'Accepts limousine requests only when the driver vehicle type exactly matches the requested instant-ride category.';
