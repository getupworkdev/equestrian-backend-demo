-- 0005_product_passport.sql
-- QR-based product registration with a digital product passport.
--
--   * Every physical product carries a QR code with an unguessable code.
--   * Anyone who scans it (no account needed) sees the PUBLIC passport: what the
--     product is, materials, care, batch, and whether it is registered, never by whom.
--   * A signed-in user registers it to themselves, optionally to one of their horses.
--   * The registered owner sees the FULL passport: horse, registration date, ownership history.
--   * Ownership moves only by an explicit transfer from the current owner.
--   * Registration and transfer each write an outbox event in the same transaction (0004).
--
-- Open question for the Product Owner, kept in one place: which passport fields
-- are public. Today: everything in app.products. Change api_v1.passport if not.

create table app.products (
  id               uuid primary key default gen_random_uuid(),
  qr_code          text not null unique check (qr_code ~ '^EQ-[0-9A-Z]{10}$'),
  product_type     text not null,            -- e.g. rug, boots, saddle pad, sensor
  model            text not null,
  batch            text not null,
  manufactured_on  date not null,
  materials        jsonb not null default '[]',
  care             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger touch before update on app.products for each row execute function app.touch_updated_at();

create table app.product_registrations (
  product_id     uuid primary key references app.products(id),  -- one current owner per product
  owner_id       uuid not null references app.profiles(id),
  horse_id       uuid references app.horses(id),
  registered_at  timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index on app.product_registrations (owner_id);
create trigger touch before update on app.product_registrations for each row execute function app.touch_updated_at();

create table app.product_ownership_events (
  id          bigint generated always as identity primary key,
  product_id  uuid not null references app.products(id),
  from_user   uuid references app.profiles(id),   -- null = first registration
  to_user     uuid not null references app.profiles(id),
  at          timestamptz not null default now()
);

alter table app.products                 enable row level security;
alter table app.product_registrations    enable row level security;
alter table app.product_ownership_events enable row level security;

-- Signed-in users see only their own registrations through the view; the
-- catalogue itself is reached only through api_v1.passport (by QR code), so
-- nobody can list every product.
create policy registrations_owner_read on app.product_registrations for select to authenticated
  using (owner_id = auth.uid());
create policy products_owner_read on app.products for select to authenticated
  using (exists (select 1 from app.product_registrations r where r.product_id = products.id and r.owner_id = auth.uid()));

grant select on app.products, app.product_registrations to authenticated;

create view api_v1.my_products with (security_invoker = true) as
  select p.id, p.qr_code, p.product_type, p.model, r.horse_id, r.registered_at
  from app.product_registrations r
  join app.products p on p.id = r.product_id;
grant select on api_v1.my_products to authenticated;

-- ---------------------------------------------------------------------------
-- Scan. Callable by anon (a QR scan from the phone camera, no account) and by
-- signed-in users. Returns the public passport, plus the private part when the
-- caller is the registered owner.
-- ---------------------------------------------------------------------------
create or replace function api_v1.passport(p_qr_code text)
returns jsonb
language plpgsql stable security definer set search_path = app, pg_temp as $$
declare
  p app.products;
  r app.product_registrations;
  v jsonb;
begin
  select * into p from app.products where qr_code = upper(trim(p_qr_code));
  if p.id is null then raise exception 'not_found: unknown product code' using errcode = 'P0002'; end if;
  select * into r from app.product_registrations where product_id = p.id;

  v := jsonb_build_object(
    'public', jsonb_build_object(
      'qr_code', p.qr_code, 'product_type', p.product_type, 'model', p.model, 'batch', p.batch,
      'manufactured_on', p.manufactured_on, 'materials', p.materials, 'care', p.care,
      'registered', r.product_id is not null));

  if r.owner_id is not null and r.owner_id = auth.uid() then
    v := v || jsonb_build_object('owner', jsonb_build_object(
      'registered_at', r.registered_at,
      'horse', (select jsonb_build_object('id', h.id, 'name', h.name) from app.horses h where h.id = r.horse_id),
      'history', (select coalesce(jsonb_agg(jsonb_build_object(
                     'from', (select display_name from app.profiles where id = e.from_user),
                     'to',   (select display_name from app.profiles where id = e.to_user),
                     'at', e.at) order by e.id), '[]')
                  from app.product_ownership_events e where e.product_id = p.id)));
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- Register. Retry-safe: the same owner registering again (offline retry) gets
-- the same answer. Attaching to a horse needs owner or trainer on that horse.
-- ---------------------------------------------------------------------------
create or replace function api_v1.register_product(p_qr_code text, p_horse_id uuid default null)
returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_product uuid;
  v_owner uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select id into v_product from app.products where qr_code = upper(trim(p_qr_code));
  if v_product is null then raise exception 'not_found: unknown product code' using errcode = 'P0002'; end if;
  if p_horse_id is not null and not app.has_horse_role(p_horse_id, array['owner','trainer']::app.horse_role[]) then
    raise exception 'forbidden: only an owner or trainer can attach a product to this horse' using errcode = '42501';
  end if;

  select owner_id into v_owner from app.product_registrations where product_id = v_product for update;
  if v_owner = auth.uid() then
    update app.product_registrations set horse_id = coalesce(p_horse_id, horse_id) where product_id = v_product;
    return v_product;                                            -- idempotent retry
  elsif v_owner is not null then
    raise exception 'conflict: product is registered to someone else; ask them to transfer it' using errcode = '23505';
  end if;

  insert into app.product_registrations (product_id, owner_id, horse_id) values (v_product, auth.uid(), p_horse_id);
  insert into app.product_ownership_events (product_id, from_user, to_user) values (v_product, null, auth.uid());
  perform app.enqueue('product.registered', jsonb_build_object('product_id', v_product, 'horse_id', p_horse_id));
  return v_product;
end $$;

-- ---------------------------------------------------------------------------
-- Transfer: only the current owner. The new owner's horse link is cleared.
-- ---------------------------------------------------------------------------
create or replace function api_v1.transfer_product(p_product_id uuid, p_to_user uuid)
returns void
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  if not exists (select 1 from app.product_registrations where product_id = p_product_id and owner_id = auth.uid()) then
    raise exception 'forbidden: only the registered owner can transfer this product' using errcode = '42501';
  end if;
  if not exists (select 1 from app.profiles where id = p_to_user) then
    raise exception 'not_found: unknown user' using errcode = 'P0002';
  end if;
  if p_to_user = auth.uid() then return; end if;
  update app.product_registrations set owner_id = p_to_user, horse_id = null, registered_at = now()
   where product_id = p_product_id;
  insert into app.product_ownership_events (product_id, from_user, to_user) values (p_product_id, auth.uid(), p_to_user);
  perform app.enqueue('product.transferred', jsonb_build_object('product_id', p_product_id));
end $$;

revoke all on function api_v1.passport(text), api_v1.register_product(text, uuid), api_v1.transfer_product(uuid, uuid) from public;
grant execute on function api_v1.passport(text) to anon, authenticated;
grant execute on function api_v1.register_product(text, uuid), api_v1.transfer_product(uuid, uuid) to authenticated;
