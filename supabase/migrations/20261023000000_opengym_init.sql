-- openGym on Postgres (Vercel + Supabase mode, api/pg-store.js).
--
-- Every table is reached by the API alone, through DATABASE_URL (the Supabase pooler), as its own
-- role (opengym_api, next migration). Nothing here is meant for the browser: RLS is on, the only
-- policies are that role's, and the PostgREST roles get no grants, so the anon and authenticated
-- keys can read and write nothing even if they leak.
--
-- `json`, not `jsonb`: the text is kept exactly as the API wrote it, key order included, the way
-- the files kept it. Nothing here is queried by what is inside a record.
--
-- The records keep the shape db.json gives them: a few key columns the API looks rows up by, and
-- the whole record in `data`. A field upstream adds to a user, a passkey or an invite lands in
-- `data` without a migration. `seq` keeps the order db.json had (the owner fallback reads the
-- first admin), since rows are only ever appended or removed, never reordered.

create table if not exists users (
  id          text primary key,
  seq         bigint generated always as identity,
  data        json not null,
  updated_at  timestamptz not null default now()
);

create table if not exists credentials (
  id          text primary key,
  seq         bigint generated always as identity,
  user_id     text not null references users(id) on delete cascade,
  data        json not null
);
create index if not exists credentials_user_idx on credentials(user_id);

create table if not exists push_subs (
  endpoint    text primary key,
  seq         bigint generated always as identity,
  user_id     text not null references users(id) on delete cascade,
  data        json not null
);
create index if not exists push_subs_user_idx on push_subs(user_id);

create table if not exists invites (
  code        text primary key,
  seq         bigint generated always as identity,
  data        json not null
);

create table if not exists device_links (
  h           text primary key,
  seq         bigint generated always as identity,
  user_id     text not null,
  data        json not null
);

-- One synced document per profile. `revision` is the document's own `_rev`, kept beside it so a
-- write can be made conditional on it (UPDATE ... WHERE revision = $n) and a poll of the revision
-- does not read a document that can be megabytes.
create table if not exists user_state (
  user_id     text primary key references users(id) on delete cascade,
  doc         json not null,
  revision    bigint not null default 0,
  updated_at  timestamptz not null default now()
);

create table if not exists audit_log (
  id          bigserial primary key,
  ts          bigint not null,
  data        json not null
);
create index if not exists audit_log_ts_idx on audit_log(ts);

-- WebAuthn challenges, phone pairing codes: one-shot, short-lived. Taken with DELETE ... RETURNING
-- and refused past expires_at; the cron tick purges what nobody came back for.
create table if not exists challenges (
  cid         text primary key,
  data        json not null,
  expires_at  timestamptz not null
);
create index if not exists challenges_exp_idx on challenges(expires_at);

create table if not exists pairings (
  code        text primary key,
  user_id     text not null,
  data        json not null,
  expires_at  timestamptz not null
);

-- The counters of api/rate-limit.js, one row per limiter and key, as the limiter keeps them.
create table if not exists rate_limits (
  name        text not null,
  key         text not null,
  data        json not null,
  updated_at  timestamptz not null default now(),
  primary key (name, key)
);

-- "Training now" in the admin dashboard.
create table if not exists presence (
  user_id     text primary key,
  data        json not null,
  updated_at  timestamptz not null default now()
);

-- Rest-timer pushes that a long-lived server keeps as setTimeout. Sent by the cron tick once due.
create table if not exists rest_timers (
  user_id     text not null,
  device_id   text not null default '',
  due_at      timestamptz not null,
  lang        text,
  primary key (user_id, device_id)
);
create index if not exists rest_timers_due_idx on rest_timers(due_at);

do $$
declare t text;
begin
  foreach t in array array['users','credentials','push_subs','invites','device_links','user_state',
                           'audit_log','challenges','pairings','rate_limits','presence','rest_timers']
  loop
    execute format('alter table public.%I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon, authenticated', t);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all sequences in schema public from anon, authenticated;
  end if;
end $$;
-- Not FORCE: the owner (migrations, the import script) is let through; opengym_api gets policies.
