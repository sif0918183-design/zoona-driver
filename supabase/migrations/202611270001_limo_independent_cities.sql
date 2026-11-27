-- Keep limousine city management independent from travel-platform cities.
begin;

create table if not exists public.limousine_cities (
  id uuid primary key default gen_random_uuid(),
  name_ar text not null check (length(btrim(name_ar)) between 2 and 80),
  created_at timestamptz not null default now()
);

insert into public.limousine_cities (id, name_ar)
select id, name_ar from public.cities
on conflict (id) do nothing;

alter table public.limousine_cities enable row level security;

create unique index if not exists limousine_cities_name_ar_lower_uidx
  on public.limousine_cities (lower(name_ar));

alter table public.limousine_pricing
  drop constraint if exists limousine_pricing_city_id_fkey;
alter table public.limousine_pricing
  add constraint limousine_pricing_city_id_fkey
  foreign key (city_id) references public.limousine_cities(id) on delete restrict;

alter table public.limousine_requests
  drop constraint if exists limousine_requests_city_id_fkey;
alter table public.limousine_requests
  add constraint limousine_requests_city_id_fkey
  foreign key (city_id) references public.limousine_cities(id) on delete restrict;

commit;
