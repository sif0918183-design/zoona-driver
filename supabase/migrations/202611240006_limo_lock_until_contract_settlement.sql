create or replace function public.limousine_user_has_active_contract(p_user_id uuid,p_role text)
returns boolean
language sql stable security definer set search_path=public,pg_temp
as $$
  select exists(
    select 1 from public.limousine_contracts c
    where case when p_role='driver' then c.driver_id=p_user_id else c.passenger_id=p_user_id end
      and c.status in ('booked','active','completion_requested','awaiting_settlement','disputed')
      and coalesce(c.commission_held,0)>0
      and c.scheduled_end_at>now()
  );
$$;
revoke all on function public.limousine_user_has_active_contract(uuid,text) from public,anon,authenticated;
