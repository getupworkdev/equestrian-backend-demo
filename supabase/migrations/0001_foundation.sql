-- 0001_foundation.sql
-- Domain schema, roles and the single permission check every policy and write function uses.
--
-- Conventions
--   app.*     private domain tables. Never exposed to clients directly.
--   api_v1.*  the versioned contract: read-only views + SQL functions for every write.
--   auth.uid() the caller, as in Supabase. In tests it is stubbed from request.jwt.claims.

create schema if not exists app;
create schema if not exists api_v1;

-- ---------------------------------------------------------------------------
-- Roles (Supabase provides anon / authenticated / service_role; created here
-- so the migrations also run on a plain Postgres).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

-- Minimal auth shim so the same SQL runs on Supabase and on plain Postgres.
create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Domain tables
-- ---------------------------------------------------------------------------
create table app.profiles (
  id          uuid primary key,                    -- = auth.users.id
  display_name text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table app.stables (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_by  uuid not null references app.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create type app.stable_role as enum ('manager', 'staff');

create table app.stable_members (
  stable_id   uuid not null references app.stables(id),
  user_id     uuid not null references app.profiles(id),
  role        app.stable_role not null,
  created_at  timestamptz not null default now(),
  primary key (stable_id, user_id)
);

create table app.horses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  stable_id   uuid references app.stables(id),       -- where the horse is boarded, optional
  created_by  uuid not null references app.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- Context-based roles: the same user can be owner of one horse and trainer of another.
create type app.horse_role as enum ('owner', 'trainer', 'caretaker');

create table app.horse_members (
  horse_id    uuid not null references app.horses(id),
  user_id     uuid not null references app.profiles(id),
  role        app.horse_role not null,
  granted_by  uuid references app.profiles(id),
  created_at  timestamptz not null default now(),
  primary key (horse_id, user_id)
);

create table app.training_logs (
  id          uuid primary key,                     -- client-generated, see 0003 (offline-first)
  horse_id    uuid not null references app.horses(id),
  author_id   uuid not null references app.profiles(id),
  logged_on   date not null,
  minutes     int  not null check (minutes between 1 and 600),
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index on app.horse_members (user_id);
create index on app.stable_members (user_id);
create index on app.horses (stable_id);
create index on app.training_logs (horse_id, logged_on desc);

-- updated_at maintenance (delta sync in 0003 depends on it)
create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger touch before update on app.profiles      for each row execute function app.touch_updated_at();
create trigger touch before update on app.stables       for each row execute function app.touch_updated_at();
create trigger touch before update on app.horses        for each row execute function app.touch_updated_at();
create trigger touch before update on app.training_logs for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- THE permission check. One function, used by every RLS policy and every
-- write function. If the rules change, they change here.
--
-- Rules (v1):
--   owner     : full control of the horse, can grant/revoke roles
--   trainer   : can read the horse and write training logs
--   caretaker : can read the horse, cannot write training logs
--   stable manager: can read every horse boarded at the stable (not write)
-- ---------------------------------------------------------------------------
create or replace function app.has_horse_role(p_horse_id uuid, p_roles app.horse_role[])
returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select exists (
    select 1 from app.horse_members hm
    where hm.horse_id = p_horse_id
      and hm.user_id  = auth.uid()
      and hm.role     = any (p_roles)
  )
$$;

create or replace function app.can_read_horse(p_horse_id uuid)
returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select app.has_horse_role(p_horse_id, array['owner','trainer','caretaker']::app.horse_role[])
      or exists (
        select 1
        from app.horses h
        join app.stable_members sm on sm.stable_id = h.stable_id
        where h.id = p_horse_id
          and sm.user_id = auth.uid()
          and sm.role = 'manager'
      )
$$;

revoke all on function app.has_horse_role(uuid, app.horse_role[]) from public;
revoke all on function app.can_read_horse(uuid) from public;
grant execute on function app.has_horse_role(uuid, app.horse_role[]) to authenticated;
grant execute on function app.can_read_horse(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS on every table. Policies only call the functions above.
-- Clients never get INSERT/UPDATE/DELETE on app.* : writes go through api_v1 functions.
-- ---------------------------------------------------------------------------
alter table app.profiles       enable row level security;
alter table app.stables        enable row level security;
alter table app.stable_members enable row level security;
alter table app.horses         enable row level security;
alter table app.horse_members  enable row level security;
alter table app.training_logs  enable row level security;

create policy profiles_self_read on app.profiles for select to authenticated
  using (id = auth.uid());

create policy stables_member_read on app.stables for select to authenticated
  using (deleted_at is null and exists (
    select 1 from app.stable_members sm where sm.stable_id = stables.id and sm.user_id = auth.uid()));

create policy stable_members_read on app.stable_members for select to authenticated
  using (user_id = auth.uid() or exists (
    select 1 from app.stable_members me where me.stable_id = stable_members.stable_id
      and me.user_id = auth.uid() and me.role = 'manager'));

create policy horses_read on app.horses for select to authenticated
  using (deleted_at is null and app.can_read_horse(id));

create policy horse_members_read on app.horse_members for select to authenticated
  using (user_id = auth.uid() or app.has_horse_role(horse_id, array['owner']::app.horse_role[]));

create policy training_logs_read on app.training_logs for select to authenticated
  using (deleted_at is null and app.can_read_horse(horse_id));

-- Least privilege: app.* is readable only through api_v1 views (0002), so no
-- direct grants to anon/authenticated on the tables at all.
revoke all on schema app from public;
grant usage on schema app to authenticated;   -- needed for the views to resolve, RLS still applies
grant usage on schema api_v1 to anon, authenticated;
