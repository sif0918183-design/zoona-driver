-- Permanent short human-readable numbers for limousine contracts.
-- UUID IDs remain unchanged for all internal relations and accounting.
begin;
create sequence if not exists public.limousine_contract_number_seq;
alter table public.limousine_contracts add column if not exists contract_number text;
update public.limousine_contracts
set contract_number = 'TRK-L-' || lpad(nextval('public.limousine_contract_number_seq')::text, 6, '0')
where contract_number is null or btrim(contract_number) = '';
select setval('public.limousine_contract_number_seq',
  coalesce((select max(substring(contract_number from 7)::bigint)
    from public.limousine_contracts where contract_number ~ '^TRK-L-[0-9]+$'),0)+1,false);
alter table public.limousine_contracts
  alter column contract_number set not null,
  alter column contract_number set default ('TRK-L-' || lpad(nextval('public.limousine_contract_number_seq')::text,6,'0'));
create unique index if not exists limousine_contracts_contract_number_uidx on public.limousine_contracts(contract_number);
grant usage, select on sequence public.limousine_contract_number_seq to service_role;
commit;
