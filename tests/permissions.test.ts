import { beforeAll, describe, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { as, freshDb, rejects, seedUser, uuid } from './db.js';

/**
 * The scenario from the brief: Anna owns Storm and is the trainer of Luna.
 * Ben owns Luna. Carl is caretaker of Storm. Dana manages the stable where
 * Luna is boarded, and has no horse roles at all. Eve is nobody.
 */
let db: PGlite;
let anna: string, ben: string, carl: string, dana: string, eve: string;
let storm: string, luna: string, stable: string;

beforeAll(async () => {
  db = await freshDb();
  [anna, ben, carl, dana, eve] = await Promise.all(['Anna', 'Ben', 'Carl', 'Dana', 'Eve'].map((n) => seedUser(db, n)));

  stable = await as(db, dana, (q) => q.one(`select api_v1.create_stable('Willow Farm') as id`)).then((r) => r.id);
  await db.query(`insert into app.stable_members (stable_id, user_id, role) values ($1, $2, 'staff')`, [stable, ben]);

  storm = await as(db, anna, (q) => q.one(`select api_v1.create_horse('Storm') as id`)).then((r) => r.id);
  luna = await as(db, ben, (q) => q.one(`select api_v1.create_horse('Luna', $1) as id`, [stable])).then((r) => r.id);

  await as(db, ben, (q) => q.run(`select api_v1.set_horse_role($1, $2, 'trainer')`, [luna, anna]));
  await as(db, anna, (q) => q.run(`select api_v1.set_horse_role($1, $2, 'caretaker')`, [storm, carl]));
});

describe('context-based roles: one user, different roles on different horses', () => {
  test('Anna sees both horses, with the right role on each', async () => {
    const rows = await as(db, anna, (q) => q.rows(`select name, my_role from api_v1.horses order by name`));
    expect(rows).toEqual([{ name: 'Luna', my_role: 'trainer' }, { name: 'Storm', my_role: 'owner' }]);
  });

  test('Anna can log training on Luna (trainer) and on Storm (owner)', async () => {
    await as(db, anna, (q) => q.run(`select api_v1.upsert_training_log($1, $2, current_date, 45, 'flatwork')`, [uuid(), luna]));
    await as(db, anna, (q) => q.run(`select api_v1.upsert_training_log($1, $2, current_date, 30, 'hacking')`, [uuid(), storm]));
    const n = await as(db, anna, (q) => q.one(`select count(*)::int as n from api_v1.training_logs`));
    expect(n.n).toBe(2);
  });

  test('Anna cannot grant roles on Luna: she is a trainer there, not an owner', async () => {
    await rejects(() => as(db, anna, (q) => q.run(`select api_v1.set_horse_role($1, $2, 'trainer')`, [luna, eve])), 'only an owner');
  });

  test('Anna can grant roles on Storm, where she is the owner', async () => {
    await as(db, anna, (q) => q.run(`select api_v1.set_horse_role($1, $2, 'trainer')`, [storm, eve]));
    await as(db, anna, (q) => q.run(`select api_v1.revoke_horse_role($1, $2)`, [storm, eve]));
  });
});

describe('what each role can and cannot do', () => {
  test('caretaker Carl can read Storm but cannot log training', async () => {
    const horses = await as(db, carl, (q) => q.rows(`select name from api_v1.horses`));
    expect(horses.map((h) => h.name)).toEqual(['Storm']);
    await rejects(() => as(db, carl, (q) => q.run(`select api_v1.upsert_training_log($1, $2, current_date, 20)`, [uuid(), storm])), 'only an owner or trainer');
  });

  test('stable manager Dana sees Luna (boarded at her stable) but not Storm, and cannot write', async () => {
    const horses = await as(db, dana, (q) => q.rows(`select name from api_v1.horses`));
    expect(horses.map((h) => h.name)).toEqual(['Luna']);
    const logs = await as(db, dana, (q) => q.rows(`select horse_id from api_v1.training_logs`));
    expect(logs.every((l) => l.horse_id === luna)).toBe(true);
    await rejects(() => as(db, dana, (q) => q.run(`select api_v1.upsert_training_log($1, $2, current_date, 20)`, [uuid(), luna])), 'only an owner or trainer');
  });

  test('stable staff Ben does not get manager visibility through the stable; he sees Luna because he owns it', async () => {
    const horses = await as(db, ben, (q) => q.rows(`select name, my_role from api_v1.horses`));
    expect(horses).toEqual([{ name: 'Luna', my_role: 'owner' }]);
  });

  test('Eve, with no roles, sees nothing and cannot write anything', async () => {
    expect(await as(db, eve, (q) => q.rows(`select * from api_v1.horses`))).toEqual([]);
    expect(await as(db, eve, (q) => q.rows(`select * from api_v1.training_logs`))).toEqual([]);
    await rejects(() => as(db, eve, (q) => q.run(`select api_v1.upsert_training_log($1, $2, current_date, 20)`, [uuid(), storm])), 'forbidden');
    await rejects(() => as(db, eve, (q) => q.run(`select api_v1.set_horse_role($1, $2, 'owner')`, [storm, eve])), 'only an owner');
  });

  test('anonymous callers cannot read the views or call write functions', async () => {
    await rejects(() => as(db, null, (q) => q.rows(`select * from api_v1.horses`)), 'permission denied');
    await rejects(() => as(db, null, (q) => q.run(`select api_v1.create_horse('x')`)), 'permission denied');
  });
});

describe('the policies cannot be bypassed from the client side', () => {
  test('authenticated users have no direct write access to app.* tables', async () => {
    await rejects(() => as(db, anna, (q) => q.run(`insert into app.horse_members (horse_id, user_id, role) values ($1, $2, 'owner')`, [luna, anna])), 'permission denied');
    await rejects(() => as(db, anna, (q) => q.run(`update app.horses set name = 'Mine' where id = $1`, [luna])), 'permission denied');
    await rejects(() => as(db, anna, (q) => q.run(`delete from app.training_logs`)), 'permission denied');
  });

  test('reading app.* directly still goes through RLS', async () => {
    const rows = await as(db, eve, (q) => q.rows(`select * from app.horses`));
    expect(rows).toEqual([]);
  });

  test('a training log id cannot be re-pointed at a horse the caller does not control', async () => {
    const id = uuid();
    await as(db, ben, (q) => q.run(`select api_v1.upsert_training_log($1, $2, current_date, 10)`, [id, luna]));
    // Carl is caretaker on Storm (read only) and nothing on Luna: both paths are refused.
    await rejects(() => as(db, carl, (q) => q.run(`select api_v1.upsert_training_log($1, $2, current_date, 99)`, [id, storm])), 'only an owner or trainer');
    const row = await db.query(`select horse_id, minutes from app.training_logs where id = $1`, [id]);
    expect(row.rows[0]).toEqual({ horse_id: luna, minutes: 10 });
  });

  test('the last owner cannot remove themselves', async () => {
    await rejects(() => as(db, anna, (q) => q.run(`select api_v1.revoke_horse_role($1, $2)`, [storm, anna])), 'at least one owner');
  });
});
