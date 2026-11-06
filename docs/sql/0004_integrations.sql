-- 0004_integrations.sql
-- Reliable integration patterns for external systems:
--   * transactional outbox: an event is written in the SAME transaction as the
--     change that caused it, so "saved but never announced" cannot happen
--   * inbound webhooks: stored once per (provider, event id), so a provider that
--     re-delivers an event is answered "already processed" instead of acting twice
--   * media: the Edge Function asks the database who may read/write a horse's
--     photos, then signs a short-lived Storage URL (supabase/functions/horse-media-url)
--
-- Nothing here is granted to anon or authenticated: only the service role
-- (used by the Edge Functions) touches the outbox and the webhook log.

-- ---------------------------------------------------------------------------
-- Outbox
-- ---------------------------------------------------------------------------
create table app.outbox (
  id            bigint generated always as identity primary key,  -- also the idempotency key sent downstream
  topic         text not null,                                    -- e.g. product.registered
  payload       jsonb not null,
  created_at    timestamptz not null default now(),
  available_at  timestamptz not null default now(),               -- next attempt not before this
  attempts      int not null default 0,
  last_error    text,
  delivered_at  timestamptz,
  dead_at       timestamptz                                       -- gave up after max attempts; needs a human
);
create index outbox_pending on app.outbox (available_at, id) where delivered_at is null and dead_at is null;
alter table app.outbox enable row level security;   -- no policies: invisible to anon/authenticated

-- Called from api_v1 write functions, inside their transaction.
create or replace function app.enqueue(p_topic text, p_payload jsonb)
returns bigint
language sql security definer set search_path = app, pg_temp as $$
  insert into app.outbox (topic, payload) values (p_topic, p_payload) returning id
$$;

-- The dispatcher (Edge Function on a schedule) claims a batch. Claiming pushes
-- available_at forward, so a crashed dispatcher's batch is retried later, and
-- SKIP LOCKED lets two dispatchers run side by side without double delivery.
create or replace function app.claim_outbox(p_limit int default 50, p_lease interval default '2 minutes')
returns setof app.outbox
language sql security definer set search_path = app, pg_temp as $$
  update app.outbox o
     set attempts = o.attempts + 1,
         available_at = now() + p_lease
   where o.id in (
     select id from app.outbox
      where delivered_at is null and dead_at is null and available_at <= now()
      order by id
      limit p_limit
      for update skip locked)
  returning o.*
$$;

create or replace function app.mark_outbox_delivered(p_id bigint)
returns void
language sql security definer set search_path = app, pg_temp as $$
  update app.outbox set delivered_at = now(), last_error = null where id = p_id and delivered_at is null
$$;

-- Exponential backoff: 30 s, 1 min, 2 min, ... capped at 1 h; dead after 8 attempts.
create or replace function app.mark_outbox_failed(p_id bigint, p_error text, p_max_attempts int default 8)
returns void
language sql security definer set search_path = app, pg_temp as $$
  update app.outbox
     set last_error   = left(p_error, 500),
         available_at = now() + least(interval '1 hour', interval '30 seconds' * power(2, greatest(attempts - 1, 0))),
         dead_at      = case when attempts >= p_max_attempts then now() end
   where id = p_id and delivered_at is null
$$;

-- ---------------------------------------------------------------------------
-- Inbound webhooks: one row per (provider, event id). The Edge Function verifies
-- the signature first, then calls this; false = duplicate delivery, answer 200
-- without acting again.
-- ---------------------------------------------------------------------------
create table app.inbound_webhooks (
  provider      text not null,
  event_id      text not null,
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  primary key (provider, event_id)
);
alter table app.inbound_webhooks enable row level security;

create or replace function app.record_webhook(p_provider text, p_event_id text, p_payload jsonb)
returns boolean
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  insert into app.inbound_webhooks (provider, event_id, payload) values (p_provider, p_event_id, p_payload)
  on conflict do nothing;
  return found;
end $$;

revoke all on app.outbox, app.inbound_webhooks from public, anon, authenticated;
revoke all on function app.enqueue(text, jsonb), app.claim_outbox(int, interval), app.mark_outbox_delivered(bigint),
              app.mark_outbox_failed(bigint, text, int), app.record_webhook(text, text, jsonb) from public;
grant execute on function app.claim_outbox(int, interval), app.mark_outbox_delivered(bigint),
                          app.mark_outbox_failed(bigint, text, int), app.record_webhook(text, text, jsonb) to service_role;
grant select, update on app.outbox to service_role;
grant select, insert, update on app.inbound_webhooks to service_role;
grant usage on schema app to service_role;

-- ---------------------------------------------------------------------------
-- Media: the same permission check decides who may view or upload a horse's
-- photos. Returns the Storage folder the caller may use; the Edge Function
-- signs a URL for a file inside it with the service key.
--   read  : anyone who can read the horse (owner, trainer, caretaker, stable manager)
--   write : owner or trainer
-- ---------------------------------------------------------------------------
create or replace function api_v1.authorize_horse_media(p_horse_id uuid, p_action text)
returns text
language plpgsql stable security definer set search_path = app, pg_temp as $$
begin
  if p_action = 'read' then
    if not app.can_read_horse(p_horse_id) then
      raise exception 'forbidden: cannot view this horse''s media' using errcode = '42501';
    end if;
  elsif p_action = 'write' then
    if not app.has_horse_role(p_horse_id, array['owner','trainer']::app.horse_role[]) then
      raise exception 'forbidden: only an owner or trainer can upload media' using errcode = '42501';
    end if;
  else
    raise exception 'invalid action: use read or write' using errcode = '22023';
  end if;
  return format('horses/%s/', p_horse_id);
end $$;

revoke all on function api_v1.authorize_horse_media(uuid, text) from public;
grant execute on function api_v1.authorize_horse_media(uuid, text) to authenticated;
