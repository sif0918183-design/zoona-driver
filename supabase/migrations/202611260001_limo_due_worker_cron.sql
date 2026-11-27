-- Ensure limousine commission holds and funding retries run independently of
-- Vercel Hobby cron limits. Supabase pg_cron executes the existing idempotent
-- worker every minute; it checks hold_due_at and retries awaiting_funding
-- contracts whose driver balance has become sufficient.
begin;

create extension if not exists pg_cron;

do $$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid from cron.job
    where jobname = 'limo-process-due-every-minute'
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'limo-process-due-every-minute',
    '* * * * *',
    'select public.limousine_process_due();'
  );
end;
$$;

commit;
