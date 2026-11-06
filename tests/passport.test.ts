import { beforeAll, describe, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { as, freshDb, rejects, seedUser } from './db.js';

/**
 * QR product passport. Anna owns Storm and trains Luna (Ben's horse). Carl is
 * Storm's caretaker. Eve has no roles. A rug and a pair of boots leave the
 * factory with QR codes; nobody has registered them yet.
 */
let db: PGlite;
let anna: string, ben: string, carl: string, eve: string;
let storm: string, luna: string;
const RUG = 'EQ-7K4Q29XD3M';
const BOOTS = 'EQ-B00T5X21QA';

beforeAll(async () => {
  db = await freshDb();
  [anna, ben, carl, eve] = await Promise.all(['Anna', 'Ben', 'Carl', 'Eve'].map((n) => seedUser(db, n)));
  storm = (await as(db, anna, (q) => q.one(`select api_v1.create_horse('Storm') as id`))).id;
  luna = (await as(db, ben, (q) => q.one(`select api_v1.create_horse('Luna') as id`))).id;
  await as(db, ben, (q) => q.run(`select api_v1.set_horse_role($1, $2, 'trainer')`, [luna, anna]));
  await as(db, anna, (q) => q.run(`select api_v1.set_horse_role($1, $2, 'caretaker')`, [storm, carl]));
  // The manufacturer's catalogue is loaded by the service role (an import job or admin tool).
  await db.query(
    `insert into app.products (qr_code, product_type, model, batch, manufactured_on, materials, care) values
       ($1, 'rug', 'Thermo Turnout 200g', 'B-2026-031', '2026-03-12', '["recycled polyester","merino lining"]', 'Wash cold, air dry'),
       ($2, 'boots', 'Brushing Boot Pro', 'B-2026-044', '2026-04-02', '["neoprene","TPU shell"]', 'Rinse after use')`,
    [RUG, BOOTS],
  );
});

const passport = (user: string | null, code: string) => as(db, user, (q) => q.one(`select api_v1.passport($1) as p`, [code])).then((r) => r.p);

describe('scanning a QR code', () => {
  test('anyone can scan without an account and sees the public passport only', async () => {
    const p = await passport(null, RUG);
    expect(p.public).toMatchObject({ product_type: 'rug', model: 'Thermo Turnout 200g', registered: false });
    expect(p.owner).toBeUndefined();
  });

  test('scanning tolerates lower case and spaces from a manual entry', async () => {
    expect((await passport(null, ' eq-7k4q29xd3m ')).public.qr_code).toBe(RUG);
  });

  test('an unknown code is a clear not_found, not an empty result', async () => {
    await rejects(() => passport(null, 'EQ-0000000000'), 'not_found');
  });

  test('anonymous visitors cannot list products or call write functions', async () => {
    await rejects(() => as(db, null, (q) => q.rows(`select * from api_v1.my_products`)), 'permission denied');
    await rejects(() => as(db, null, (q) => q.run(`select api_v1.register_product($1)`, [RUG])), 'permission denied');
  });
});

describe('registering and owning a product', () => {
  test('Anna registers the rug to Storm and sees the full passport', async () => {
    await as(db, anna, (q) => q.run(`select api_v1.register_product($1, $2)`, [RUG, storm]));
    const p = await passport(anna, RUG);
    expect(p.public.registered).toBe(true);
    expect(p.owner.horse).toMatchObject({ name: 'Storm' });
    expect(p.owner.history).toEqual([expect.objectContaining({ from: null, to: 'Anna' })]);
  });

  test('a stranger scanning the same code learns it is registered, but not by whom', async () => {
    const p = await passport(eve, RUG);
    expect(p.public.registered).toBe(true);
    expect(p.owner).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain('Anna');
  });

  test('registering again after a dropped connection is a safe retry', async () => {
    const first = (await as(db, anna, (q) => q.one(`select api_v1.register_product($1, $2) as id`, [RUG, storm]))).id;
    const again = (await as(db, anna, (q) => q.one(`select api_v1.register_product($1, $2) as id`, [RUG, storm]))).id;
    expect(again).toBe(first);
    const events = await db.query(`select count(*)::int as n from app.product_ownership_events`);
    expect(events.rows[0]).toEqual({ n: 1 });
  });

  test('someone else cannot take over a registered product', async () => {
    await rejects(() => as(db, eve, (q) => q.run(`select api_v1.register_product($1)`, [RUG])), 'registered to someone else');
  });

  test('caretaker Carl cannot attach a product to Storm; trainer Anna can attach one to Luna', async () => {
    await rejects(() => as(db, carl, (q) => q.run(`select api_v1.register_product($1, $2)`, [BOOTS, storm])), 'only an owner or trainer');
    await as(db, anna, (q) => q.run(`select api_v1.register_product($1, $2)`, [BOOTS, luna]));
  });

  test('my_products shows each user only what they own', async () => {
    expect((await as(db, anna, (q) => q.rows(`select qr_code from api_v1.my_products order by qr_code`))).map((r) => r.qr_code)).toEqual([RUG, BOOTS]);
    expect(await as(db, eve, (q) => q.rows(`select * from api_v1.my_products`))).toEqual([]);
  });
});

describe('transferring ownership', () => {
  test('only the current owner can transfer', async () => {
    const rug = (await db.query<{ id: string }>(`select id from app.products where qr_code = $1`, [RUG])).rows[0].id;
    await rejects(() => as(db, eve, (q) => q.run(`select api_v1.transfer_product($1, $2)`, [rug, eve])), 'only the registered owner');
  });

  test('Anna sells the rug to Ben: Ben sees it with the history, Anna no longer does', async () => {
    const rug = (await db.query<{ id: string }>(`select id from app.products where qr_code = $1`, [RUG])).rows[0].id;
    await as(db, anna, (q) => q.run(`select api_v1.transfer_product($1, $2)`, [rug, ben]));
    const p = await passport(ben, RUG);
    expect(p.owner.horse).toBeNull();
    expect(p.owner.history.map((e: any) => [e.from, e.to])).toEqual([[null, 'Anna'], ['Anna', 'Ben']]);
    expect((await passport(anna, RUG)).owner).toBeUndefined();
    await rejects(() => as(db, anna, (q) => q.run(`select api_v1.transfer_product($1, $2)`, [rug, anna])), 'only the registered owner');
  });

  test('each registration and transfer wrote exactly one outbox event, in the same transaction', async () => {
    const topics = await db.query<{ topic: string }>(`select topic from app.outbox order by id`);
    expect(topics.rows.map((r) => r.topic)).toEqual(['product.registered', 'product.registered', 'product.transferred']);
  });

  test('a write that fails leaves no outbox event behind', async () => {
    const before = (await db.query<{ n: number }>(`select count(*)::int as n from app.outbox`)).rows[0].n;
    await rejects(() => as(db, eve, (q) => q.run(`select api_v1.register_product($1)`, [BOOTS])), 'registered to someone else');
    expect((await db.query<{ n: number }>(`select count(*)::int as n from app.outbox`)).rows[0].n).toBe(before);
  });
});
