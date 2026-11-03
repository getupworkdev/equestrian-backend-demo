import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');

/** A fresh in-process Postgres with every migration applied, in file order. */
export async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  return db;
}

export const uuid = () => crypto.randomUUID();

/**
 * Run `fn` as a signed-in user, the way PostgREST does on Supabase:
 * role `authenticated` plus request.jwt.claims carrying the user id.
 * Everything inside runs under RLS and with the function grants of that role.
 */
export async function as<T>(db: PGlite, userId: string | null, fn: (q: Q) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${userId ? 'authenticated' : 'anon'}`);
    await tx.exec(`select set_config('request.jwt.claims', '${userId ? JSON.stringify({ sub: userId }) : ''}', true)`);
    return fn({
      rows: async (sql, params) => (await tx.query(sql, params)).rows as any[],
      one: async (sql, params) => ((await tx.query(sql, params)).rows as any[])[0],
      run: async (sql, params) => { await tx.query(sql, params); },
    });
  });
}

export type Q = {
  rows: (sql: string, params?: unknown[]) => Promise<any[]>;
  one: (sql: string, params?: unknown[]) => Promise<any>;
  run: (sql: string, params?: unknown[]) => Promise<void>;
};

/** Seed a profile as the service role (what the auth hook would do on sign-up). */
export async function seedUser(db: PGlite, name: string): Promise<string> {
  const id = uuid();
  await db.query('insert into app.profiles (id, display_name) values ($1, $2)', [id, name]);
  return id;
}

/** Assert that `fn` fails with a message containing `needle`. */
export async function rejects(fn: () => Promise<unknown>, needle: string) {
  try {
    await fn();
  } catch (e: any) {
    if (!String(e.message).includes(needle)) throw new Error(`expected error containing "${needle}", got: ${e.message}`);
    return;
  }
  throw new Error(`expected an error containing "${needle}", but the call succeeded`);
}
