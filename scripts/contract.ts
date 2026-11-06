import type { PGlite } from '@electric-sql/pglite';

/**
 * Builds docs/API_CONTRACT.md from the database itself: every api_v1 view and
 * function, its comment, columns or arguments, who may call it, and the errors
 * it can raise (read from the function body). Deterministic, so CI can diff it.
 */
export async function buildContract(db: PGlite): Promise<string> {
  const views = (await db.query<any>(`
    select c.oid, c.relname as name, obj_description(c.oid, 'pg_class') as doc,
           has_table_privilege('anon', c.oid, 'SELECT') as anon,
           has_table_privilege('authenticated', c.oid, 'SELECT') as authed
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'api_v1' and c.relkind = 'v'
    order by c.relname`)).rows;

  const fns = (await db.query<any>(`
    select p.oid, p.proname as name, pg_get_function_arguments(p.oid) as args,
           pg_get_function_result(p.oid) as result, obj_description(p.oid, 'pg_proc') as doc,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed,
           p.prosrc as src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'api_v1'
    order by p.proname`)).rows;

  const who = (anon: boolean, authed: boolean) =>
    anon && authed ? 'anyone (signed in or not)' : authed ? 'signed-in users' : anon ? 'anonymous only' : 'nobody (service role only)';

  const out: string[] = [];
  out.push('# API contract: `api_v1`');
  out.push('');
  out.push('Generated from the database by `npm run contract` (comments in `supabase/migrations/0006_api_docs.sql`, everything else from the catalogue). CI fails when this file and the migrations disagree, so the contract the app developers read is always the one that runs.');
  out.push('');
  out.push('Reads are views queried through the Supabase Data API (`/rest/v1/<view>` with `Accept-Profile: api_v1`); every row is filtered by Row Level Security. Writes are SQL functions (`/rest/v1/rpc/<name>` with `Content-Profile: api_v1`). Errors are raised with a readable message and a SQLSTATE code the apps can switch on.');
  out.push('');
  out.push(`${views.length} views, ${fns.length} functions.`);
  out.push('');
  out.push('## Reads (views)');
  for (const v of views) {
    const cols = (await db.query<any>(`
      select a.attname as name, format_type(a.atttypid, a.atttypmod) as type
      from pg_attribute a where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped order by a.attnum`, [v.oid])).rows;
    out.push('');
    out.push(`### \`${v.name}\``);
    out.push('');
    out.push(v.doc ?? '_No description._');
    out.push('');
    out.push(`Readable by: ${who(v.anon, v.authed)}.`);
    out.push('');
    out.push('| Column | Type |');
    out.push('| --- | --- |');
    for (const c of cols) out.push(`| \`${c.name}\` | ${c.type} |`);
  }
  out.push('');
  out.push('## Writes and calls (functions)');
  for (const f of fns) {
    out.push('');
    out.push(`### \`${f.name}(${f.args})\``);
    out.push('');
    out.push(`Returns: \`${f.result}\`. Callable by: ${who(f.anon, f.authed)}.`);
    out.push('');
    out.push(f.doc ?? '_No description._');
    const errors = [...String(f.src).matchAll(/raise exception '((?:[^']|'')*)'(?:\s+using\s+errcode\s*=\s*'(\w+)')?/gi)]
      .map((m) => ({ message: m[1].replaceAll("''", "'"), code: m[2] ?? 'P0001' }));
    const unique = [...new Map(errors.map((e) => [e.message, e])).values()];
    if (unique.length) {
      out.push('');
      out.push('| Error message | SQLSTATE |');
      out.push('| --- | --- |');
      for (const e of unique) out.push(`| ${e.message} | ${e.code} |`);
    }
  }
  out.push('');
  return out.join('\n');
}
