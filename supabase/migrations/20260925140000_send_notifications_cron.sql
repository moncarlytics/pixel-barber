-- Queue SMS notifications: call the send-notifications Edge Function every 30 seconds. The function
-- URL and the service role key come from Supabase Vault (secrets 'project_url' and
-- 'notifications_dispatch_key', created once at deploy time -- never written in a migration). Until
-- both exist the call simply fails and is retried on the next tick; nothing else depends on it.
select cron.schedule(
  'send-notifications',
  '30 seconds',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/send-notifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'notifications_dispatch_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
