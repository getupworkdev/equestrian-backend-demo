// Prepares the GitHub Pages site in docs/: copies the browser build of PGlite
// and the real migrations next to the explorer page. The page runs exactly the
// SQL that CI tests (tests/pages.test.ts fails if the copies drift).
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const pgliteDist = join(root, 'node_modules', '@electric-sql', 'pglite', 'dist');
const vendor = join(root, 'docs', 'vendor', 'pglite');
const sqlOut = join(root, 'docs', 'sql');

rmSync(vendor, { recursive: true, force: true });
mkdirSync(vendor, { recursive: true });
for (const f of readdirSync(pgliteDist)) {
  if (/^(index\.js|chunk-[A-Z0-9]+\.js)$/.test(f) || /\.(wasm|data)$/.test(f)) copyFileSync(join(pgliteDist, f), join(vendor, f));
}

rmSync(sqlOut, { recursive: true, force: true });
mkdirSync(sqlOut, { recursive: true });
const migrations = readdirSync(join(root, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
for (const f of migrations) copyFileSync(join(root, 'supabase', 'migrations', f), join(sqlOut, f));
writeFileSync(join(sqlOut, 'index.json'), JSON.stringify(migrations) + '\n');
writeFileSync(join(root, 'docs', '.nojekyll'), '');
console.log(`docs/: ${readdirSync(vendor).length} PGlite files, ${migrations.length} migrations`);
