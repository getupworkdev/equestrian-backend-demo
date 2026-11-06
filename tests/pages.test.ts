import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('live explorer page', () => {
  test('docs/sql holds exactly the migrations CI tests (run `npm run pages` after changing them)', () => {
    const src = join(process.cwd(), 'supabase', 'migrations');
    const out = join(process.cwd(), 'docs', 'sql');
    const migrations = readdirSync(src).filter((f) => f.endsWith('.sql')).sort();
    expect(JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'))).toEqual(migrations);
    for (const f of migrations) expect(readFileSync(join(out, f), 'utf8'), f).toBe(readFileSync(join(src, f), 'utf8'));
  });
});
