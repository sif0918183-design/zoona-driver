-- Also block direct RPC/database assignment of immediate and travel rides to a driver with an active limousine contract.
create or replace function public.limousine_guard_instant_ride()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_passenger uuid; v_driver uuid;
begin
  v_passenger:=nullif(to_jsonb(new)->>'passenger_id','')::uuid;
  v_driver:=nullif(to_jsonb(new)->>'driver_id','')::uuid;
  if tg_op='INSERT' and v_passenger is not null
     and public.limousine_user_has_active_contract(v_passenger,'passenger') then
    raise exception 'active_limousine_contract: لا يمكنك طلب رحلة داخلية أثناء سريان عقد الليموزين';
  end if;
  if v_driver is not null and (tg_op='INSERT' or v_driver is distinct from nullif(to_jsonb(old)->>'driver_id','')::uuid)
     and public.limousine_user_has_active_contract(v_driver,'driver') then
    raise exception 'active_limousine_contract: السائق لديه عقد ليموزين سارٍ';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_limo_guard_rides on public.rides;
create trigger trg_limo_guard_rides before insert or update of driver_id on public.rides
for each row execute function public.limousine_guard_instant_ride();

create or replace function public.limousine_guard_travel_request()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_passenger uuid; v_driver uuid;
begin
  v_passenger:=nullif(to_jsonb(new)->>'customer_id','')::uuid;
  v_driver:=nullif(to_jsonb(new)->>'driver_id','')::uuid;
  if tg_op='INSERT' and v_passenger is not null
     and public.limousine_user_has_active_contract(v_passenger,'passenger') then
    raise exception 'active_limousine_contract: لا يمكنك إنشاء رحلة سفرية أثناء سريان عقد الليموزين';
  end if;
  if v_driver is not null and (tg_op='INSERT' or v_driver is distinct from nullif(to_jsonb(old)->>'driver_id','')::uuid)
     and public.limousine_user_has_active_contract(v_driver,'driver') then
    raise exception 'active_limousine_contract: السائق لديه عقد ليموزين سارٍ';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_limo_guard_ride_requests on public.ride_requests;
create trigger trg_limo_guard_ride_requests before insert or update of driver_id on public.ride_requests
for each row execute function public.limousine_guard_travel_request();
