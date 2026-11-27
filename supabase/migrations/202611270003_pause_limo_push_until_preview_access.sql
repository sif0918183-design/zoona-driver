-- Pause limousine push trigger until the protected Vercel preview can be reached by pg_net.
-- Re-enable trg_limo_notification_push after the deployment's authorized bypass is configured and tested.
alter table public.limousine_notifications disable trigger trg_limo_notification_push;
