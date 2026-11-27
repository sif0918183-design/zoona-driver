-- Enforce full-day limousine rentals: start at 07:00 and minimum one day.
update public.limousine_pricing set min_days=1 where min_days is distinct from 1;

create or replace function public.limousine_create_request(
  p_passenger_id uuid,p_city_id uuid,p_pickup_area text,p_start_at timestamptz,
  p_duration_days integer,p_requested_category_id uuid,p_passenger_count integer,
  p_usage_purpose text default null,p_notes text default null
) returns jsonb
language plpgsql security definer
set search_path to 'public','pg_temp'
as $function$
declare p public.limousine_pricing%rowtype; v_id uuid; v_total numeric; v_start_local timestamp;
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
  select * into p from public.limousine_pricing
   where city_id=p_city_id and vehicle_category_id=p_requested_category_id and is_active for share;
  if not found then raise exception 'pricing_unavailable'; end if;
  if p.max_days is not null and p_duration_days>p.max_days then raise exception 'duration_out_of_pricing_range'; end if;
  v_total:=p.daily_price*p_duration_days;
  insert into public.limousine_requests(passenger_id,city_id,pickup_area,start_at,duration_days,requested_category_id,
    passenger_count,usage_purpose,notes,daily_price_snapshot,commission_rate_snapshot,estimated_total,status)
  values(p_passenger_id,p_city_id,trim(p_pickup_area),p_start_at,p_duration_days,p_requested_category_id,
    p_passenger_count,nullif(trim(coalesce(p_usage_purpose,'')),''),nullif(trim(coalesce(p_notes,'')),''),
    p.daily_price,p.commission_rate,v_total,'open') returning id into v_id;
  insert into public.limousine_notifications(request_id,recipient_id,recipient_type,event_code,title,body,payload)
  select v_id,d.id,'driver','LIMO_NEW_REQUEST','طلب تأجير جديد','يوجد طلب تأجير يومي جديد يناسب فئة سيارتك.',
    jsonb_build_object('city_id',p_city_id,'start_at',p_start_at)
  from public.drivers d where coalesce(d.is_active,false) and coalesce(d.is_approved,false)
    and coalesce(d.is_available,false) and not coalesce(d.is_banned,false)
    and (case when d.car_type='vip' then 3 when d.car_type='comfort' then 2 when d.car_type='economy' then 1 else 0 end)
      >= (select case when name_ar ilike '%SUV%' or name_ar ilike '%عالي%' then 3
        when name_ar ilike '%مريح%' then 2 when name_ar ilike '%اقتصادي%' then 1 else 99 end
        from public.vehicle_categories where id=p_requested_category_id);
  return jsonb_build_object('ok',true,'request_id',v_id,'daily_price',p.daily_price,
    'estimated_total',v_total,'commission_rate',p.commission_rate);
end;
$function$;

comment on function public.limousine_create_request(uuid,uuid,text,timestamp with time zone,integer,uuid,integer,text,text)
is 'Creates full-day limousine requests at 07:00 Africa/Khartoum, minimum one day.';
