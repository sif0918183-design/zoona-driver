-- Limousine FCM push delivery, reusing the existing Vercel API route.
-- Uses the existing CRON_SECRET mirrored in Supabase Vault as tracka_limo_cron_secret.
-- No new api/*.js function is created (Vercel Hobby function limit).
begin;

create extension if not exists pg_net with schema extensions;

create or replace function public.limousine_enqueue_notification_push()
returns trigger
language plpgsql
security definer
set search_path = public, vault, net, pg_temp
as $$
declare
  v_secret text;
begin
  if new.recipient_type not in ('passenger','driver') then
    return new;
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'tracka_limo_cron_secret'
  limit 1;

  if v_secret is null or length(v_secret) < 16 then
    raise warning '[LIMO_PUSH] Vault secret tracka_limo_cron_secret is unavailable; push was not queued.';
    return new;
  end if;

  perform net.http_post(
    url := 'https://tracka-git-feature-limousine-platform-wdkush995-9294.vercel.app/api/travel-platform?module=limousine',
    body := jsonb_build_object('action','dispatch_notification','notification_id',new.id),
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer ' || v_secret
    ),
    timeout_milliseconds := 10000
  );
  return new;
exception when others then
  raise warning '[LIMO_PUSH] Could not queue notification %: %', new.id, sqlerrm;
  return new;
end;
$;

revoke all on function public.limousine_enqueue_notification_push() from public, anon, authenticated;

drop trigger if exists trg_limo_notification_push on public.limousine_notifications;
create trigger trg_limo_notification_push
after insert on public.limousine_notifications
for each row execute function public.limousine_enqueue_notification_push();


commit;
