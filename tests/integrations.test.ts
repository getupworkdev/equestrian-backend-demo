import { beforeAll, describe, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { as, asService, freshDb, rejects, seedUser } from './db.js';
import { signatureHeader, verifySignature } from '../supabase/functions/_shared/signature.ts';
import { deliverAll, idempotencyKey, type OutboxRow } from '../supabase/functions/_shared/dispatch.ts';

let db: PGlite;
let anna: string, ben: string, carl: string, eve: string, storm: string;

beforeAll(async () => {
  db = await freshDb();
  [anna, ben, carl, eve] = await Promise.all(['Anna', 'Ben', 'Carl', 'Eve'].map((n) => seedUser(db, n)));
  storm = (await as(db, anna, (q) => q.one(`select api_v1.create_horse('Storm') as id`))).id;
  await as(db, anna, (q) => q.run(`select api_v1.set_horse_role($1, $2, 'trainer')`, [storm, ben]));
  await as(db, anna, (q) => q.run(`select api_v1.set_horse_role($1, $2, 'caretaker')`, [storm, carl]));
});

describe('webhook signatures (shared by the receiver and the dispatcher)', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ id: 'evt_1', type: 'order.paid' });
  const now = 1_793_900_000;

  test('a correctly signed request is accepted', async () => {
    const header = await signatureHeader(secret, body, now);
    expect(await verifySignature({ secret, header, rawBody: body, nowSeconds: now + 10 })).toEqual({ ok: true });
  });

  test('a body changed by one character is rejected', async () => {
    const header = await signatureHeader(secret, body, now);
    expect(await verifySignature({ secret, header, rawBody: body.replace('paid', 'pain'), nowSeconds: now })).toEqual({ ok: false, reason: 'mismatch' });
  });

  test('a signature made with another secret is rejected', async () => {
    const header = await signatureHeader('someone-else', body, now);
    expect(await verifySignature({ secret, header, rawBody: body, nowSeconds: now })).toEqual({ ok: false, reason: 'mismatch' });
  });

  test('a captured request replayed later than 5 minutes is rejected', async () => {
    const header = await signatureHeader(secret, body, now);
    expect(await verifySignature({ secret, header, rawBody: body, nowSeconds: now + 301 })).toEqual({ ok: false, reason: 'expired' });
  });

  test('missing and malformed headers are rejected before any crypto runs', async () => {
    expect(await verifySignature({ secret, header: null, rawBody: body, nowSeconds: now })).toEqual({ ok: false, reason: 'missing' });
    expect(await verifySignature({ secret, header: 't=abc,v1=zz', rawBody: body, nowSeconds: now })).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('inbound webhooks are processed once', () => {
  test('the same event delivered twice is recorded once; the second delivery is reported as a duplicate', async () => {
    const first = await asService(db, (q) => q.one(`select app.record_webhook('shop', 'evt_42', '{"id":"evt_42"}') as is_new`));
    const again = await asService(db, (q) => q.one(`select app.record_webhook('shop', 'evt_42', '{"id":"evt_42"}') as is_new`));
    expect([first.is_new, again.is_new]).toEqual([true, false]);
  });

  test('the same event id from a different provider is a different event', async () => {
    expect((await asService(db, (q) => q.one(`select app.record_webhook('erp', 'evt_42', '{}') as is_new`))).is_new).toBe(true);
  });

  test('app users cannot read or write the webhook log or call the service functions', async () => {
    await rejects(() => as(db, anna, (q) => q.rows(`select * from app.inbound_webhooks`)), 'permission denied');
    await rejects(() => as(db, anna, (q) => q.run(`select app.record_webhook('shop', 'x', '{}')`)), 'permission denied');
  });
});

describe('transactional outbox', () => {
  test('claiming leases a batch: a second dispatcher running at the same time gets nothing', async () => {
    await db.query(`select app.enqueue('horse.created', '{"n":1}'), app.enqueue('horse.created', '{"n":2}')`);
    const first = await asService(db, (q) => q.rows(`select id, attempts from app.claim_outbox(10)`));
    const second = await asService(db, (q) => q.rows(`select id from app.claim_outbox(10)`));
    expect(first).toHaveLength(2);
    expect(first.every((r) => r.attempts === 1)).toBe(true);
    expect(second).toEqual([]);
  });

  test('delivered events are never claimed again', async () => {
    const id = (await db.query<{ id: number }>(`select app.enqueue('t', '{}') as id`)).rows[0].id;
    await asService(db, (q) => q.rows(`select * from app.claim_outbox(10)`));
    await asService(db, (q) => q.run(`select app.mark_outbox_delivered($1)`, [id]));
    await db.query(`update app.outbox set available_at = now() - interval '1 day' where id = $1`, [id]);
    const again = await asService(db, (q) => q.rows(`select id from app.claim_outbox(10)`));
    expect(again.map((r) => Number(r.id))).not.toContain(Number(id));
  });

  test('a failure backs off exponentially and the event becomes dead after 8 attempts', async () => {
    const id = Number((await db.query<{ id: number }>(`select app.enqueue('flaky', '{}') as id`)).rows[0].id);
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      await db.query(`update app.outbox set available_at = now() - interval '1 second' where id = $1`, [id]);
      const claimed = await asService(db, (q) => q.rows(`select id from app.claim_outbox(100)`));
      expect(claimed.map((r) => Number(r.id))).toContain(id);
      await asService(db, (q) => q.run(`select app.mark_outbox_failed($1, 'http 503')`, [id]));
      const row = (await db.query<any>(`select extract(epoch from available_at - now())::int as wait, dead_at from app.outbox where id = $1`, [id])).rows[0];
      waits.push(row.wait);
      expect(row.dead_at === null).toBe(i < 7);
    }
    expect(waits.slice(0, 4)).toEqual([30, 60, 120, 240]);
    await db.query(`update app.outbox set available_at = now() - interval '1 second' where id = $1`, [id]);
    expect((await asService(db, (q) => q.rows(`select id from app.claim_outbox(100)`))).map((r) => Number(r.id))).not.toContain(id);
  });

  test('app users cannot see the outbox', async () => {
    await rejects(() => as(db, anna, (q) => q.rows(`select * from app.outbox`)), 'permission denied');
  });

  test('the dispatcher delivers in order, sends an idempotency key, and treats 409 "already have it" as delivered', async () => {
    const rows: OutboxRow[] = [
      { id: 3, topic: 'b', payload: {}, attempts: 1 },
      { id: 1, topic: 'a', payload: {}, attempts: 1 },
      { id: 2, topic: 'c', payload: {}, attempts: 1 },
      { id: 4, topic: 'd', payload: {}, attempts: 1 },
    ];
    const seen: string[] = [];
    const statuses: Record<number, number | Error> = { 1: 200, 2: 409, 3: 503, 4: new Error('timeout') };
    const out = await deliverAll(rows, async (row) => {
      seen.push(idempotencyKey(row));
      const s = statuses[row.id];
      if (s instanceof Error) throw s;
      return { status: s };
    });
    expect(seen).toEqual(['outbox-1', 'outbox-2', 'outbox-3', 'outbox-4']);
    expect(out).toEqual([
      { id: 1, result: 'delivered' },
      { id: 2, result: 'delivered' },
      { id: 3, result: 'failed', error: 'http 503' },
      { id: 4, result: 'failed', error: 'network: timeout' },
    ]);
  });
});

describe('signed media URLs: the database decides who may view or upload', () => {
  const media = (user: string, action: string) =>
    as(db, user, (q) => q.one(`select api_v1.authorize_horse_media($1, $2) as folder`, [storm, action])).then((r) => r.folder);

  test('owner and trainer may upload; they get the horse folder to sign a URL in', async () => {
    expect(await media(anna, 'write')).toBe(`horses/${storm}/`);
    expect(await media(ben, 'write')).toBe(`horses/${storm}/`);
  });

  test('caretaker Carl may view but not upload', async () => {
    expect(await media(carl, 'read')).toBe(`horses/${storm}/`);
    await rejects(() => media(carl, 'write'), 'only an owner or trainer can upload');
  });

  test('Eve, with no role on Storm, may do neither', async () => {
    await rejects(() => media(eve, 'read'), 'cannot view');
    await rejects(() => media(eve, 'write'), 'only an owner or trainer');
  });

  test('anything other than read or write is refused', async () => {
    await rejects(() => media(anna, 'delete'), 'invalid action');
  });
});
