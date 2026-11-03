import { beforeAll, describe, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { as, freshDb, rejects, seedUser, uuid } from './db.js';

let db: PGlite;
let owner: string, trainer: string, stranger: string;
let horse: string, device: string;

const tick = () => new Promise((r) => setTimeout(r, 5)); // clock resolution: a real device's watermark is the last updated_at it received
const reading = (seq: number, at: string, t = 21.5, h = 55) => ({ seq, measured_at: at, temperature: t, humidity: h });

beforeAll(async () => {
  db = await freshDb();
  [owner, trainer, stranger] = await Promise.all(['Owner', 'Trainer', 'Stranger'].map((n) => seedUser(db, n)));
  horse = (await as(db, owner, (q) => q.one(`select api_v1.create_horse('Comet') as id`))).id;
  await as(db, owner, (q) => q.run(`select api_v1.set_horse_role($1, $2, 'trainer')`, [horse, trainer]));
  device = (await as(db, owner, (q) => q.one(`select api_v1.register_sensor($1, 'BLE-0001') as id`, [horse]))).id;
});

describe('idempotent batch upload of sensor readings', () => {
  const batch = [reading(1, '2026-03-01T08:00:00Z'), reading(2, '2026-03-01T08:10:00Z'), reading(3, '2026-03-01T08:20:00Z')];

  test('first upload stores every reading and returns the watermark', async () => {
    const r = await as(db, trainer, (q) => q.one(`select * from api_v1.upload_readings($1, $2)`, [device, JSON.stringify(batch)]));
    expect(r).toMatchObject({ accepted: 3, duplicates: 0, last_seq: 3 });
  });

  test('re-sending the same batch after a timeout inserts nothing twice', async () => {
    const r = await as(db, trainer, (q) => q.one(`select * from api_v1.upload_readings($1, $2)`, [device, JSON.stringify(batch)]));
    expect(r).toMatchObject({ accepted: 0, duplicates: 3, last_seq: 3 });
    const n = await db.query(`select count(*)::int as n from app.sensor_readings where device_id = $1`, [device]);
    expect(n.rows[0]).toEqual({ n: 3 });
  });

  test('a partially overlapping batch only adds the new readings', async () => {
    const next = [reading(3, '2026-03-01T08:20:00Z'), reading(4, '2026-03-01T08:30:00Z'), reading(5, '2026-04-02T09:00:00Z')];
    const r = await as(db, trainer, (q) => q.one(`select * from api_v1.upload_readings($1, $2)`, [device, JSON.stringify(next)]));
    expect(r).toMatchObject({ accepted: 2, duplicates: 1, last_seq: 5 });
  });

  test('readings land in monthly partitions created on demand', async () => {
    const parts = await db.query(`select relname from pg_class where relname like 'sensor_readings_20%' and relkind = 'r' order by 1`);
    expect(parts.rows.map((p: any) => p.relname)).toEqual(['sensor_readings_2026_03', 'sensor_readings_2026_04']);
  });

  test('a stranger cannot upload for a device they cannot read, and a batch over 5000 is refused', async () => {
    await rejects(() => as(db, stranger, (q) => q.run(`select * from api_v1.upload_readings($1, $2)`, [device, JSON.stringify(batch)])), 'forbidden');
    const big = JSON.stringify(Array.from({ length: 5001 }, (_, i) => reading(100 + i, '2026-05-01T00:00:00Z')));
    await rejects(() => as(db, trainer, (q) => q.run(`select * from api_v1.upload_readings($1, $2)`, [device, big])), 'batch too large');
  });

  test('readers see readings through the view, strangers see none', async () => {
    const mine = await as(db, owner, (q) => q.rows(`select seq from api_v1.sensor_readings where device_id = $1 order by seq`, [device]));
    expect(mine.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(await as(db, stranger, (q) => q.rows(`select * from api_v1.sensor_readings`))).toEqual([]);
  });

  test('a serial cannot be re-registered to a horse the caller owns if it belongs to another horse', async () => {
    const other = (await as(db, stranger, (q) => q.one(`select api_v1.create_horse('Other') as id`))).id;
    await rejects(() => as(db, stranger, (q) => q.run(`select api_v1.register_sensor($1, 'BLE-0001')`, [other])), 'another horse');
  });
});

describe('delta sync with tombstones', () => {
  test('a device that went offline gets creates, updates and deletions since its watermark', async () => {
    const t0 = (await db.query(`select now() as t`)).rows[0] as any;
    await tick();
    const logId = uuid();
    await as(db, trainer, (q) => q.run(`select api_v1.upsert_training_log($1, $2, '2026-03-02', 40, 'lunging')`, [logId, horse]));
    await as(db, trainer, (q) => q.run(`select api_v1.upsert_training_log($1, $2, '2026-03-02', 45, 'lunging, longer')`, [logId, horse]));

    let changes = await as(db, owner, (q) => q.rows(`select entity, id, deleted, data from api_v1.changes_since($1)`, [t0.t]));
    expect(changes).toEqual([{ entity: 'training_log', id: logId, deleted: false, data: { horse_id: horse, logged_on: '2026-03-02', minutes: 45, notes: 'lunging, longer' } }]);

    const t1 = (await db.query(`select now() as t`)).rows[0] as any;
    await tick();
    await as(db, trainer, (q) => q.run(`select api_v1.delete_training_log($1)`, [logId]));
    await as(db, trainer, (q) => q.run(`select api_v1.delete_training_log($1)`, [logId])); // deleting twice is fine

    changes = await as(db, owner, (q) => q.rows(`select entity, id, deleted, data from api_v1.changes_since($1)`, [t1.t]));
    expect(changes).toEqual([{ entity: 'training_log', id: logId, deleted: true, data: null }]);

    // the view never shows the tombstone
    expect(await as(db, owner, (q) => q.rows(`select id from api_v1.training_logs where id = $1`, [logId]))).toEqual([]);
  });

  test('changes_since only returns what the caller may read', async () => {
    const all = await as(db, owner, (q) => q.rows(`select entity from api_v1.changes_since('2000-01-01')`));
    expect(all.map((c) => c.entity)).toEqual(expect.arrayContaining(['horse', 'sensor_device', 'training_log']));
    const theirs = await as(db, stranger, (q) => q.rows(`select entity, data from api_v1.changes_since('2000-01-01')`));
    expect(theirs).toEqual([{ entity: 'horse', data: { name: 'Other', stable_id: null } }]);
  });
});
