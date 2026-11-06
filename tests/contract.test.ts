import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb } from './db.js';
import { buildContract } from '../scripts/contract.ts';

const FILE = join(process.cwd(), 'docs', 'API_CONTRACT.md');

describe('API contract', () => {
  test('docs/API_CONTRACT.md matches the migrations (run `npm run contract` after changing the API)', async () => {
    const generated = await buildContract(await freshDb());
    if (process.env.UPDATE_CONTRACT) writeFileSync(FILE, generated);
    expect(existsSync(FILE) ? readFileSync(FILE, 'utf8') : '').toBe(generated);
  });

  test('every api_v1 view and function is documented', async () => {
    const db = await freshDb();
    const missing = (await db.query<{ name: string }>(`
      select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'api_v1' and c.relkind = 'v' and obj_description(c.oid, 'pg_class') is null
      union all
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'api_v1' and obj_description(p.oid, 'pg_proc') is null`)).rows;
    expect(missing).toEqual([]);
  });
});
