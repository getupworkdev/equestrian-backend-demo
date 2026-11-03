-- 0002_api_v1.sql
-- The versioned contract the apps code against: read-only views + one SQL
-- function per write. The app developers can build against this file.

-- Views run as the caller (security_invoker), so RLS from 0001 applies.
grant select on all tables in schema app to authenticated;

create view api_v1.horses with (security_invoker = true) as
  select h.id, h.name, h.stable_id, h.created_at, h.updated_at,
         (select hm.role from app.horse_members hm where hm.horse_id = h.id and hm.user_id = auth.uid()) as my_role
  from app.horses h
  where h.deleted_at is null;

create view api_v1.stables with (security_invoker = true) as
  select s.id, s.name, s.created_at, s.updated_at
  from app.stables s
  where s.deleted_at is null;

create view api_v1.training_logs with (security_invoker = true) as
  select t.id, t.horse_id, t.author_id, t.logged_on, t.minutes, t.notes, t.created_at, t.updated_at
  from app.training_logs t
  where t.deleted_at is null;

grant select on api_v1.horses, api_v1.stables, api_v1.training_logs to authenticated;

-- ---------------------------------------------------------------------------
-- Writes. Every function:
--   * runs as definer (so it can write app.*),
--   * checks app.has_horse_role / can_read_horse itself (never trusts the caller),
--   * raises a named error the apps can map to a message.
-- ---------------------------------------------------------------------------

create or replace function api_v1.create_stable(p_name text)
returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  insert into app.stables (name, created_by) values (p_name, auth.uid()) returning id into v_id;
  insert into app.stable_members (stable_id, user_id, role) values (v_id, auth.uid(), 'manager');
  return v_id;
end $$;

create or replace function api_v1.create_horse(p_name text, p_stable_id uuid default null)
returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_stable_id is not null and not exists (
      select 1 from app.stable_members where stable_id = p_stable_id and user_id = auth.uid()) then
    raise exception 'forbidden: not a member of that stable' using errcode = '42501';
  end if;
  insert into app.horses (name, stable_id, created_by) values (p_name, p_stable_id, auth.uid()) returning id into v_id;
  insert into app.horse_members (horse_id, user_id, role, granted_by) values (v_id, auth.uid(), 'owner', auth.uid());
  return v_id;
end $$;

-- Only an owner can grant or change roles on a horse.
create or replace function api_v1.set_horse_role(p_horse_id uuid, p_user_id uuid, p_role app.horse_role)
returns void
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  if not app.has_horse_role(p_horse_id, array['owner']::app.horse_role[]) then
    raise exception 'forbidden: only an owner can set roles' using errcode = '42501';
  end if;
  insert into app.horse_members (horse_id, user_id, role, granted_by)
  values (p_horse_id, p_user_id, p_role, auth.uid())
  on conflict (horse_id, user_id) do update set role = excluded.role, granted_by = excluded.granted_by;
end $$;

create or replace function api_v1.revoke_horse_role(p_horse_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  if not app.has_horse_role(p_horse_id, array['owner']::app.horse_role[]) then
    raise exception 'forbidden: only an owner can revoke roles' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() and (select count(*) from app.horse_members where horse_id = p_horse_id and role = 'owner') = 1 then
    raise exception 'conflict: a horse must keep at least one owner' using errcode = '23514';
  end if;
  delete from app.horse_members where horse_id = p_horse_id and user_id = p_user_id;
end $$;

-- Training logs: owner or trainer may write; caretaker and stable manager may only read.
-- p_id is client-generated so an offline app can retry the call safely (see 0003).
create or replace function api_v1.upsert_training_log(
  p_id uuid, p_horse_id uuid, p_logged_on date, p_minutes int, p_notes text default null)
returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  if not app.has_horse_role(p_horse_id, array['owner','trainer']::app.horse_role[]) then
    raise exception 'forbidden: only an owner or trainer can log training' using errcode = '42501';
  end if;
  insert into app.training_logs (id, horse_id, author_id, logged_on, minutes, notes)
  values (p_id, p_horse_id, auth.uid(), p_logged_on, p_minutes, p_notes)
  on conflict (id) do update
    set logged_on = excluded.logged_on, minutes = excluded.minutes, notes = excluded.notes
    where app.training_logs.horse_id = excluded.horse_id      -- an id can never move to another horse
      and app.training_logs.deleted_at is null;
  return p_id;
end $$;

create or replace function api_v1.delete_training_log(p_id uuid)
returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_horse uuid;
begin
  select horse_id into v_horse from app.training_logs where id = p_id;
  if v_horse is null then return; end if;   -- idempotent: deleting twice is fine
  if not app.has_horse_role(v_horse, array['owner','trainer']::app.horse_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update app.training_logs set deleted_at = now() where id = p_id and deleted_at is null;
end $$;

revoke all on all functions in schema api_v1 from public;
grant execute on all functions in schema api_v1 to authenticated;
