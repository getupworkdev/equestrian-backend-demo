-- 0003_sensors_and_sync.sql
-- Bluetooth sensor readings (time series) and the offline-first sync contract:
--   * idempotent batch write: client ids + per-device sequence, retries never duplicate
--   * delta pull: everything changed since a watermark, including deletions (tombstones)

-- ---------------------------------------------------------------------------
-- Devices and readings
-- ---------------------------------------------------------------------------
create table app.sensor_devices (
  id          uuid primary key default gen_random_uuid(),
  horse_id    uuid not null references app.horses(id),
  serial      text not null unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index on app.sensor_devices (horse_id);
create trigger touch before update on app.sensor_devices for each row execute function app.touch_updated_at();

-- Partitioned by month: readings arrive forever, queries are "last N days for one device".
create table app.sensor_readings (
  device_id    uuid not null references app.sensor_devices(id),
  seq          bigint not null,                 -- per-device sequence assigned by the phone
  measured_at  timestamptz not null,
  temperature  numeric(5,2),
  humidity     numeric(5,2) check (humidity between 0 and 100),
  received_at  timestamptz not null default now(),
  primary key (device_id, seq, measured_at)     -- partition key must be in the PK
) partition by range (measured_at);

create index on app.sensor_readings (device_id, measured_at desc);

-- Partitions are created ahead by this function; a scheduled job (pg_cron on Supabase)
-- calls it monthly. The tests call it directly.
create or replace function app.ensure_reading_partition(p_month date)
returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (v_start + interval '1 month')::date;
  v_name  text := format('sensor_readings_%s', to_char(v_start, 'YYYY_MM'));
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'app' and c.relname = v_name) then
    execute format('create table app.%I partition of app.sensor_readings for values from (%L) to (%L)',
                   v_name, v_start, v_end);
    execute format('alter table app.%I enable row level security', v_name);
  end if;
end $$;

alter table app.sensor_devices  enable row level security;
alter table app.sensor_readings enable row level security;

create policy sensor_devices_read on app.sensor_devices for select to authenticated
  using (deleted_at is null and app.can_read_horse(horse_id));

create policy sensor_readings_read on app.sensor_readings for select to authenticated
  using (exists (select 1 from app.sensor_devices d where d.id = sensor_readings.device_id
                 and d.deleted_at is null and app.can_read_horse(d.horse_id)));

grant select on app.sensor_devices, app.sensor_readings to authenticated;

create view api_v1.sensor_devices with (security_invoker = true) as
  select id, horse_id, serial, created_at, updated_at from app.sensor_devices where deleted_at is null;

create view api_v1.sensor_readings with (security_invoker = true) as
  select device_id, seq, measured_at, temperature, humidity from app.sensor_readings;

grant select on api_v1.sensor_devices, api_v1.sensor_readings to authenticated;

create or replace function api_v1.register_sensor(p_horse_id uuid, p_serial text)
returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_id uuid;
begin
  if not app.has_horse_role(p_horse_id, array['owner']::app.horse_role[]) then
    raise exception 'forbidden: only an owner can register a sensor' using errcode = '42501';
  end if;
  insert into app.sensor_devices (horse_id, serial) values (p_horse_id, p_serial)
  on conflict (serial) do update set updated_at = now()
    where app.sensor_devices.horse_id = excluded.horse_id   -- a serial can't be re-registered to another horse
  returning id into v_id;
  if v_id is null then raise exception 'conflict: serial registered to another horse' using errcode = '23505'; end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Idempotent batch write.
-- The phone buffers readings offline and uploads them in batches. Each reading
-- carries the device's own sequence number, so re-sending a batch after a
-- network timeout inserts nothing twice. Returns the highest seq stored, which
-- the phone uses as its upload watermark.
-- ---------------------------------------------------------------------------
create or replace function api_v1.upload_readings(p_device_id uuid, p_readings jsonb)
returns table (accepted int, duplicates int, last_seq bigint)
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_horse uuid;
  v_total int;
  v_inserted int;
begin
  select horse_id into v_horse from app.sensor_devices where id = p_device_id and deleted_at is null;
  if v_horse is null or not app.has_horse_role(v_horse, array['owner','trainer','caretaker']::app.horse_role[]) then
    raise exception 'forbidden: cannot upload for this device' using errcode = '42501';
  end if;
  if jsonb_typeof(p_readings) <> 'array' then raise exception 'readings must be an array' using errcode = '22023'; end if;
  if jsonb_array_length(p_readings) > 5000 then raise exception 'batch too large (max 5000)' using errcode = '22023'; end if;

  -- make sure partitions exist for every month in the batch
  perform app.ensure_reading_partition(d::date)
  from (select distinct date_trunc('month', (r->>'measured_at')::timestamptz) as d
        from jsonb_array_elements(p_readings) r) m;

  with rows as (
    select p_device_id as device_id,
           (r->>'seq')::bigint as seq,
           (r->>'measured_at')::timestamptz as measured_at,
           (r->>'temperature')::numeric as temperature,
           (r->>'humidity')::numeric as humidity
    from jsonb_array_elements(p_readings) r
  ), ins as (
    insert into app.sensor_readings (device_id, seq, measured_at, temperature, humidity)
    select device_id, seq, measured_at, temperature, humidity from rows
    on conflict do nothing
    returning 1
  )
  select (select count(*) from rows), (select count(*) from ins) into v_total, v_inserted;

  accepted := v_inserted;
  duplicates := v_total - v_inserted;
  select coalesce(max(seq), 0) into last_seq from app.sensor_readings where device_id = p_device_id;
  return next;
end $$;

-- ---------------------------------------------------------------------------
-- Delta sync.
-- Tombstones: soft deletes keep the row with deleted_at set, so a device that
-- was offline learns about the deletion. The function returns everything the
-- caller may see that changed after p_since, plus a new watermark.
-- ---------------------------------------------------------------------------
create or replace function api_v1.changes_since(p_since timestamptz)
returns table (entity text, id uuid, updated_at timestamptz, deleted boolean, data jsonb)
-- security definer on purpose: RLS hides tombstones (deleted_at is not null), but a
-- syncing device must learn about them. Visibility is still decided by can_read_horse.
language sql stable security definer set search_path = app, api_v1, pg_temp as $$
  select 'horse', h.id, h.updated_at, h.deleted_at is not null,
         case when h.deleted_at is null then jsonb_build_object('name', h.name, 'stable_id', h.stable_id) end
  from app.horses h
  where h.updated_at > p_since and app.can_read_horse(h.id)
  union all
  select 'training_log', t.id, t.updated_at, t.deleted_at is not null,
         case when t.deleted_at is null then jsonb_build_object('horse_id', t.horse_id, 'logged_on', t.logged_on,
                                                                'minutes', t.minutes, 'notes', t.notes) end
  from app.training_logs t
  where t.updated_at > p_since and app.can_read_horse(t.horse_id)
  union all
  select 'sensor_device', d.id, d.updated_at, d.deleted_at is not null,
         case when d.deleted_at is null then jsonb_build_object('horse_id', d.horse_id, 'serial', d.serial) end
  from app.sensor_devices d
  where d.updated_at > p_since and app.can_read_horse(d.horse_id)
  order by 3, 2
$$;

revoke all on all functions in schema api_v1 from public;
grant execute on all functions in schema api_v1 to authenticated;
