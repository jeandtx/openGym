-- The timers on Supabase: pg_cron calls POST /api/cron/tick through pg_net (docs/VERCEL_SUPABASE.md).
-- Supabase only (both extensions ship there); the local tests leave this file out.
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Owned by the migration's role, run by pg_cron as that role; nobody else may call them.
create or replace function public.opengym_tick() returns void
language plpgsql security definer set search_path = '' as $$
declare c record;
begin
  select tick_url, secret into c from public.cron_config where id = 1;
  if c is null then return; end if;      -- the API has not been reached once yet
  perform net.http_post(
    url := c.tick_url,
    headers := jsonb_build_object('Authorization', 'Bearer ' || c.secret, 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
end $$;

-- Every ten seconds, but a request only goes out while a rest timer is actually due.
create or replace function public.opengym_rest_due() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.rest_timers where due_at <= now()) then
    perform public.opengym_tick();
  end if;
end $$;

revoke all on function public.opengym_tick() from public;
revoke all on function public.opengym_rest_due() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.opengym_tick() from anon, authenticated;
    revoke all on function public.opengym_rest_due() from anon, authenticated;
  end if;
end $$;

-- cron.schedule replaces a job of the same name, so this file can run again.
select cron.schedule('opengym-tick', '* * * * *', 'select public.opengym_tick()');
select cron.schedule('opengym-rest-due', '10 seconds', 'select public.opengym_rest_due()');

-- pg_net keeps every response it got; a week of them is plenty to debug with.
select cron.schedule('opengym-net-cleanup', '17 3 * * *',
  $$delete from net._http_response where created < now() - interval '7 days'$$);
