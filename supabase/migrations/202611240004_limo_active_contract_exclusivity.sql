-- Prevent passenger/driver ride activity while a financially secured limousine contract is active.
create or replace function public.limousine_user_has_active_contract(p_user_id uuid,p_role text)
returns boolean
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  select exists(
    select 1 from public.limousine_contracts c
    where case when p_role='driver' then c.driver_id=p_user_id else c.passenger_id=p_user_id end
      and c.status in ('booked','active')
      and coalesce(c.commission_held,0)>0
      and c.scheduled_end_at>now()
  );
$$;
revoke all on function public.limousine_user_has_active_contract(uuid,text) from public,anon,authenticated;

revoke all on function public.limousine_guard_driver_location() from public,anon,authenticated;

create or replace function public.limousine_guard_driver_location()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
begin
  if (coalesce((to_jsonb(new)->>'is_online')::boolean,false)
      or coalesce((to_jsonb(new)->>'is_available')::boolean,false))
     and public.limousine_user_has_active_contract(new.driver_id,'driver') then
    raise exception 'active_limousine_contract: لا يمكنك تفعيل وضع العمل أثناء سريان عقد الليموزين';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_limo_guard_driver_location on public.driver_locations;
create trigger trg_limo_guard_driver_location before insert or update of is_online,is_available
on public.driver_locations for each row execute function public.limousine_guard_driver_location();

revoke all on function public.limousine_guard_instant_ride() from public,anon,authenticated;

create or replace function public.limousine_guard_instant_ride()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_passenger uuid;
begin
  v_passenger:=nullif(to_jsonb(new)->>'passenger_id','')::uuid;
  if v_passenger is not null and public.limousine_user_has_active_contract(v_passenger,'passenger') then
    raise exception 'active_limousine_contract: لا يمكنك طلب رحلة داخلية أثناء سريان عقد الليموزين';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_limo_guard_rides on public.rides;
create trigger trg_limo_guard_rides before insert on public.rides
for each row execute function public.limousine_guard_instant_ride();

revoke all on function public.limousine_guard_travel_request() from public,anon,authenticated;

create or replace function public.limousine_guard_travel_request()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_passenger uuid;
begin
  v_passenger:=nullif(to_jsonb(new)->>'customer_id','')::uuid;
  if v_passenger is not null and public.limousine_user_has_active_contract(v_passenger,'passenger') then
    raise exception 'active_limousine_contract: لا يمكنك إنشاء رحلة سفرية أثناء سريان عقد الليموزين';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_limo_guard_ride_requests on public.ride_requests;
create trigger trg_limo_guard_ride_requests before insert on public.ride_requests
for each row execute function public.limousine_guard_travel_request();

revoke all on function public.limousine_guard_travel_trip() from public,anon,authenticated;

create or replace function public.limousine_guard_travel_trip()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_passenger uuid; v_driver uuid;
begin
  v_passenger:=nullif(to_jsonb(new)->>'passenger_id','')::uuid;
  v_driver:=nullif(to_jsonb(new)->>'driver_id','')::uuid;
  if v_passenger is not null and public.limousine_user_has_active_contract(v_passenger,'passenger') then
    raise exception 'active_limousine_contract: الراكب لديه عقد ليموزين سارٍ';
  end if;
  if v_driver is not null and public.limousine_user_has_active_contract(v_driver,'driver') then
    raise exception 'active_limousine_contract: السائق لديه عقد ليموزين سارٍ';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_limo_guard_travel_trips on public.travel_trips;
create trigger trg_limo_guard_travel_trips before insert or update of driver_id,passenger_id
on public.travel_trips for each row execute function public.limousine_guard_travel_trip();

-- A contract may have become booked while the driver was online.
update public.driver_locations dl
set is_online=false,is_available=false,updated_at=now()
where (dl.is_online or dl.is_available)
and exists(select 1 from public.limousine_contracts c
  where c.driver_id=dl.driver_id and c.status in ('booked','active')
    and coalesce(c.commission_held,0)>0 and c.start_at<=now() and c.scheduled_end_at>now());

comment on function public.limousine_user_has_active_contract(uuid,text)
is 'Internal predicate used by ride-creation and driver-location triggers to enforce active limousine contract exclusivity.';
