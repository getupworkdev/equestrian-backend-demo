import { beforeAll, describe, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { as, freshDb, seedUser } from './db.js';

/** Anna owns Storm (Carl caretaker). Ben owns Luna at Willow Farm, Dana manages the farm. Eve is nobody. */
let db: PGlite;
let anna: string, ben: string, carl: string, dana: string, eve: string, storm: string, luna: string;

beforeAll(async () => {
  db = await freshDb();
  [anna, ben, carl, dana, eve] = await Promise.all(['Anna', 'Ben', 'Carl', 'Dana', 'Eve'].map((n) => seedUser(db, n)));
  const stable = (await as(db, dana, (q) => q.one(`select api_v1.create_stable('Willow Farm') as id`))).id;
  await db.query(`insert into app.stable_members (stable_id, user_id, role) values ($1, $2, 'staff')`, [stable, ben]);
  storm = (await as(db, anna, (q) => q.one(`select api_v1.create_horse('Storm') as id`))).id;
  luna = (await as(db, ben, (q) => q.one(`select api_v1.create_horse('Luna', $1) as id`, [stable]))).id;
  await as(db, anna, (q) => q.run(`select api_v1.set_horse_role($1, $2, 'caretaker')`, [storm, carl]));
});

const names = (user: string, horse: string) =>
  as(db, user, (q) => q.rows(`select display_name, role from api_v1.horse_people where horse_id = $1 order by display_name`, [horse]));

describe('who can see whom', () => {
  test('caretaker Carl sees everyone on Storm, by name', async () => {
    expect(await names(carl, storm)).toEqual([{ display_name: 'Anna', role: 'owner' }, { display_name: 'Carl', role: 'caretaker' }]);
  });

  test('Carl cannot see who is on Luna: he has nothing to do with it', async () => {
    expect(await names(carl, luna)).toEqual([]);
  });

  test('stable manager Dana sees the people on horses boarded with her', async () => {
    expect(await names(dana, luna)).toEqual([{ display_name: 'Ben', role: 'owner' }]);
  });

  test('reading stables and their members works for manager and staff (no policy recursion)', async () => {
    expect((await as(db, dana, (q) => q.rows(`select name from api_v1.stables`))).map((r) => r.name)).toEqual(['Willow Farm']);
    expect((await as(db, ben, (q) => q.rows(`select name from api_v1.stables`))).map((r) => r.name)).toEqual(['Willow Farm']);
    expect((await as(db, dana, (q) => q.rows(`select display_name, role from api_v1.stable_members order by 1`)))).toEqual([{ display_name: 'Ben', role: 'staff' }, { display_name: 'Dana', role: 'manager' }]);
    expect((await as(db, ben, (q) => q.rows(`select display_name from api_v1.stable_members`)))).toEqual([{ display_name: 'Ben' }]);
    expect(await as(db, eve, (q) => q.rows(`select * from api_v1.stables`))).toEqual([]);
  });

  test('a name is visible only through a shared horse or stable', async () => {
    const seenByEve = await as(db, eve, (q) => q.rows(`select display_name from api_v1.people`));
    expect(seenByEve).toEqual([]);
    const seenByBen = await as(db, ben, (q) => q.rows(`select display_name from api_v1.people order by 1`));
    expect(seenByBen.map((r) => r.display_name)).toEqual(['Dana']);   // shares the stable; not Anna, Carl or Eve
  });
});
