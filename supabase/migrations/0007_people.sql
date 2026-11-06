-- 0007_people.sql
-- Who else is on my horse. The app's "People" section needs display names of
-- the other members, which 0001 kept private (profiles: self only). Rule:
-- a profile is visible to anyone who shares a horse or a stable with it.

create or replace function app.shares_context_with(p_user_id uuid)
returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select p_user_id = auth.uid()
      or exists (select 1 from app.horse_members a join app.horse_members b on b.horse_id = a.horse_id
                 where a.user_id = auth.uid() and b.user_id = p_user_id)
      or exists (select 1 from app.stable_members a join app.stable_members b on b.stable_id = a.stable_id
                 where a.user_id = auth.uid() and b.user_id = p_user_id)
$$;
revoke all on function app.shares_context_with(uuid) from public;
grant execute on function app.shares_context_with(uuid) to authenticated;

drop policy profiles_self_read on app.profiles;
create policy profiles_context_read on app.profiles for select to authenticated
  using (app.shares_context_with(id));

-- 0001's stable_members policy looked up stable_members inside itself, which
-- Postgres refuses ("infinite recursion") the first time a user reads
-- api_v1.stables. Same cure as has_horse_role: decide it in a definer function.
create or replace function app.is_stable_manager(p_stable_id uuid)
returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select exists (select 1 from app.stable_members sm
                 where sm.stable_id = p_stable_id and sm.user_id = auth.uid() and sm.role = 'manager')
$$;
revoke all on function app.is_stable_manager(uuid) from public;
grant execute on function app.is_stable_manager(uuid) to authenticated;

drop policy stable_members_read on app.stable_members;
create policy stable_members_read on app.stable_members for select to authenticated
  using (user_id = auth.uid() or app.is_stable_manager(stable_id));

create view api_v1.stable_members with (security_invoker = true) as
  select sm.stable_id, sm.user_id, p.display_name, sm.role
  from app.stable_members sm join app.profiles p on p.id = sm.user_id;
grant select on api_v1.stable_members to authenticated;
comment on view api_v1.stable_members is
  'Members of the caller''s stables: a manager sees everyone at the stable, staff see themselves.';

-- Everyone who may see a horse may see who is on it (0001 allowed only the owner).
drop policy horse_members_read on app.horse_members;
create policy horse_members_read on app.horse_members for select to authenticated
  using (app.can_read_horse(horse_id));

create view api_v1.horse_people with (security_invoker = true) as
  select hm.horse_id, hm.user_id, p.display_name, hm.role, hm.created_at
  from app.horse_members hm
  join app.profiles p on p.id = hm.user_id
  where app.can_read_horse(hm.horse_id);
grant select on api_v1.horse_people to authenticated;

-- People I could invite: everyone who shares a stable with me, plus anyone
-- already on one of my horses. (A real app would search by email; the demo
-- has no email directory.)
create view api_v1.people with (security_invoker = true) as
  select p.id, p.display_name from app.profiles p where p.id <> auth.uid();
grant select on api_v1.people to authenticated;

comment on view api_v1.horse_people is
  'Members of every horse the caller may see, with their display name and role (owner, trainer, caretaker).';
comment on view api_v1.people is
  'People the caller can see and invite: anyone sharing a horse or a stable with them.';
