-- The API's own database role (docs/VERCEL_SUPABASE.md).
--
-- opengym_api is what DATABASE_URL signs in as: it can read and write the openGym tables and
-- nothing else of the project — not auth, not storage, not the vault. Its password is set apart
-- from this file (a SCRAM verifier, scripts/vercel/db-password.mjs), so no secret is in the
-- repository. RLS stays on: the only policies are for this one role, none for anon or
-- authenticated.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'opengym_api') then
    create role opengym_api login noinherit;
  end if;
end $$;

grant usage on schema public to opengym_api;

-- What the API writes for pg_cron to read: where the tick is, and the Bearer it wants. Written by
-- the API itself from its own CRON_SECRET and ORIGIN (pg-store.js registerCron), so the secret
-- never has to be copied anywhere by hand.
create table if not exists cron_config (
  id          int primary key default 1 check (id = 1),
  tick_url    text not null,
  secret      text not null,
  updated_at  timestamptz not null default now()
);
alter table cron_config enable row level security;

do $$
declare t text;
begin
  foreach t in array array['users','credentials','push_subs','invites','device_links','user_state',
                           'audit_log','challenges','pairings','rate_limits','presence','rest_timers','cron_config']
  loop
    execute format('grant select, insert, update, delete on public.%I to opengym_api', t);
    execute format('drop policy if exists opengym_api_all on public.%I', t);
    execute format('create policy opengym_api_all on public.%I for all to opengym_api using (true) with check (true)', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;
-- truncate is for the tests and the import, which run as the owner; the API never empties a table.
grant usage, select on all sequences in schema public to opengym_api;
