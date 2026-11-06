// A working equestrian app on the repository's real migrations. The database
// (PostgreSQL compiled to WebAssembly) lives in this browser's IndexedDB, so
// data survives reloads and the app opens with no signal. Every screen is
// drawn from api_v1.* views, every write goes through api_v1.* functions, and
// every refusal shown is the database's own.
import { PGlite } from '../vendor/pglite/index.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// Demo people. Fixed ids so the story is the same on every device.
const PEOPLE = {
  anna: { id: '0a000000-0000-4000-8000-000000000001', name: 'Anna', blurb: 'Owns Storm, trains Luna' },
  ben: { id: '0b000000-0000-4000-8000-000000000002', name: 'Ben', blurb: 'Owns Luna, works at Willow Farm' },
  carl: { id: '0c000000-0000-4000-8000-000000000003', name: 'Carl', blurb: 'Looks after Storm' },
  dana: { id: '0d000000-0000-4000-8000-000000000004', name: 'Dana', blurb: 'Manages Willow Farm' },
  eve: { id: '0e000000-0000-4000-8000-000000000005', name: 'Eve', blurb: 'New here, no horses yet' },
};
const PRODUCTS = [
  { code: 'EQ-7K4Q29XD3M', label: 'Rug label' },
  { code: 'EQ-B00T5X21QA', label: 'Boot label' },
  { code: 'EQ-SENS0R0007', label: 'Sensor box' },
];

let db;
let me = store.get('stable.me', null);            // key into PEOPLE, or 'visitor', or null
let offline = store.get('stable.offline', false); // simulated: the database is local, so this governs the queue only
let queue = store.get('stable.queue', []);        // writes made with no signal, replayed on sync

// ---------------------------------------------------------------------------
// Database: open, migrate once, seed once
// ---------------------------------------------------------------------------
const resetDb = () => new Promise((r) => { const q = indexedDB.deleteDatabase('/pglite/stable-app'); q.onsuccess = q.onerror = q.onblocked = () => r(); });

async function openDb(setText, retry = false) {
  const files = await (await fetch('../sql/index.json')).json();
  const stamp = files.join('|');
  db = new PGlite('idb://stable-app');
  await db.waitReady;
  // Which migrations this database was built from is recorded in the database
  // itself (localStorage and IndexedDB are cleared independently on some phones).
  await db.exec(`create table if not exists public.demo_meta (k text primary key, v text not null)`);
  const prev = (await db.query(`select v from public.demo_meta where k = 'schema'`)).rows[0]?.v ?? null;
  const half = !prev && (await db.query(`select 1 from information_schema.schemata where schema_name = 'api_v1'`)).rows.length;
  if ((prev && prev !== stamp) || half) {   // other migrations, or a first run that was interrupted
    setText('Updating the database…');
    await db.close().catch(() => {});
    await resetDb();
    if (retry) throw new Error('could not reset the database');
    return openDb(setText, true);
  }
  if (!prev) {
    for (const f of files) {
      setText(`Applying ${f}`);
      await db.exec(await (await fetch(`../sql/${f}`)).text());
    }
    await db.query(`insert into public.demo_meta (k, v) values ('schema', $1) on conflict (k) do update set v = excluded.v`, [stamp]);
  }
  store.set('stable.schema', stamp);
  // Decide "already seeded" from the database itself, not from localStorage:
  // some browsers keep IndexedDB but drop localStorage (or the reverse), and a
  // half-finished first run must not be mistaken for a finished one.
  const seeded = await db.query(`select 1 from app.stables where name = 'Willow Farm' limit 1`);
  if (!seeded.rows.length) {
    setText('Loading the stable');
    try {
      await seed();
    } catch (e) {
      // A partial seed can't be continued; start the database over once.
      setText('Resetting the stable');
      await db.close().catch(() => {});
      await resetDb();
      if (retry) throw e;
      return openDb(setText, true);
    }
  }
  store.set('stable.seeded', true);
}

// One call as one person, the way PostgREST runs it on Supabase.
let chain = Promise.resolve();
function call(sql, params = [], who = me) {
  const uid = who && who !== 'visitor' ? PEOPLE[who].id : null;
  const run = async () => {
    await db.exec('begin');
    try {
      await db.exec(`set local role ${uid ? 'authenticated' : 'anon'}`);
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [uid ? JSON.stringify({ sub: uid }) : '']);
      const res = await db.query(sql, params);
      await db.exec('commit');
      return { ok: true, rows: res.rows };
    } catch (e) {
      await db.exec('rollback');
      return { ok: false, error: String(e.message || e).replace(/^error:\s*/i, ''), code: e.code };
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}
const must = async (sql, params, who) => { const r = await call(sql, params, who); if (!r.ok) throw new Error(r.error); return r.rows; };
const admin = async (sql, params = []) => { await chain; return (await db.query(sql, params)).rows; };

async function seed() {
  for (const p of Object.values(PEOPLE)) await admin(`insert into app.profiles (id, display_name) values ($1, $2) on conflict do nothing`, [p.id, p.name]);
  const stable = (await must(`select api_v1.create_stable('Willow Farm') as id`, [], 'dana'))[0].id;
  await admin(`insert into app.stable_members (stable_id, user_id, role) values ($1, $2, 'staff')`, [stable, PEOPLE.ben.id]);
  const storm = (await must(`select api_v1.create_horse('Storm') as id`, [], 'anna'))[0].id;
  const luna = (await must(`select api_v1.create_horse('Luna', $1) as id`, [stable], 'ben'))[0].id;
  const comet = (await must(`select api_v1.create_horse('Comet', $1) as id`, [stable], 'dana'))[0].id;
  await must(`select api_v1.set_horse_role($1, $2, 'trainer')`, [luna, PEOPLE.anna.id], 'ben');
  await must(`select api_v1.set_horse_role($1, $2, 'caretaker')`, [storm, PEOPLE.carl.id], 'anna');
  const d1 = (await must(`select api_v1.register_sensor($1, 'BLE-STORM-01') as id`, [storm], 'anna'))[0].id;
  const d2 = (await must(`select api_v1.register_sensor($1, 'BLE-LUNA-01') as id`, [luna], 'ben'))[0].id;
  const day = 864e5, now = Date.now();
  const readings = (base, seed) => Array.from({ length: 24 }, (_, i) => ({
    seq: i + 1, measured_at: new Date(now - (24 - i) * 3600e3).toISOString(),
    temperature: +(base + 2.2 * Math.sin((i + seed) / 3.8) + (i % 3) * 0.2).toFixed(1),
    humidity: Math.round(74 + 6 * Math.cos((i + seed) / 4.1)),
  }));
  await must(`select * from api_v1.upload_readings($1, $2)`, [d1, JSON.stringify(readings(7.4, 1))], 'anna');
  await must(`select * from api_v1.upload_readings($1, $2)`, [d2, JSON.stringify(readings(8.1, 5))], 'ben');
  const log = (who, horse, daysAgo, minutes, notes) =>
    must(`select api_v1.upsert_training_log(gen_random_uuid(), $1, current_date - $2::int, $3, $4)`, [horse, daysAgo, minutes, notes], who);
  await log('anna', storm, 0, 30, 'Hacking in the forest');
  await log('anna', storm, 2, 40, 'Flatwork, transitions');
  await log('anna', storm, 3, 25, 'Lunging');
  await log('ben', luna, 1, 40, 'Lunging, 3 x 10 min');
  await log('anna', luna, 0, 45, 'Flatwork, trot sets');
  await admin(
    `insert into app.products (qr_code, product_type, model, batch, manufactured_on, materials, care) values
       ('EQ-7K4Q29XD3M', 'rug', 'Thermo Turnout 200g', 'B-2026-031', '2026-03-12', '["recycled polyester","merino lining"]', 'Wash cold, air dry'),
       ('EQ-B00T5X21QA', 'boots', 'Brushing Boot Pro', 'B-2026-044', '2026-04-02', '["neoprene","TPU shell"]', 'Rinse after use'),
       ('EQ-SENS0R0007', 'sensor', 'Stall Climate Sensor', 'B-2026-051', '2026-05-20', '["ABS housing","CR2477 cell"]', 'Wipe clean, keep away from water')
     on conflict do nothing`);
  void day; void comet;
}

// ---------------------------------------------------------------------------
// Offline queue: writes made with no signal wait here and replay through the
// same idempotent API functions. Ids come from the phone, so a replayed write
// never creates a second row.
// ---------------------------------------------------------------------------
function enqueue(item) { queue.push({ ...item, at: new Date().toISOString() }); store.set('stable.queue', queue); }
async function sync() {
  const results = [];
  for (const item of [...queue]) {
    const r = await call(item.sql, item.params, item.who);
    results.push({ item, r });
    if (r.ok || (r.code && r.code !== '08000')) queue = queue.filter((q) => q !== item); // keep only on connection-type failures
  }
  store.set('stable.queue', queue);
  return results;
}

function toast(text, bad = false) {
  const t = $('#toast');
  t.textContent = text; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------
const screen = $('#screen');
let nav = 0;
function render(html, { tab = null, compact = false } = {}, tok = nav) {
  if (tok !== nav) return;   // the user already moved on; don't paint a stale screen
  screen.innerHTML = html;
  screen.scrollTop = 0;
  $('#tabs').hidden = !me;
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  void compact;
}
const syncPill = () => queue.length
  ? `<button class="pill pending" data-go="#/profile">${queue.length} waiting to sync</button>`
  : offline ? `<span class="pill">No signal</span>`
  : `<span class="pill"><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>All synced</span>`;
const roleBadge = (role) => role ? `<span class="badge ${esc(role)}">${esc(role[0].toUpperCase() + role.slice(1))}</span>` : `<span class="badge manager">Stable manager</span>`;
const fmtDate = (d) => { const t = d instanceof Date ? d : new Date(String(d).slice(0, 10) + 'T00:00:00'); const diff = Math.round((new Date().setHours(0, 0, 0, 0) - t.setHours(0, 0, 0, 0)) / 864e5); return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : t.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }); };
const spark = (vals, color, dashed = false) => {
  if (vals.length < 2) return '';
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1) * 356).toFixed(1)} ${(48 - (v - min) / span * 40).toFixed(1)}`).join(' L');
  return `<path d="M${pts}" fill="none" stroke="${color}" stroke-width="2"${dashed ? ' stroke-dasharray="4 3"' : ''}/>`;
};
async function can(sql, params) { const r = await call(sql, params); return r.ok ? { ok: true } : { ok: false, why: cap(r.error.replace(/^forbidden: /, '')) }; }
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const whyLine = (c) => c.ok ? '' : `<p class="why">${esc(c.why)}</p>`;

// Latest reading and 24h series per horse the caller may see
async function climate(horseId) {
  const rows = await call(`select r.measured_at, r.temperature, r.humidity from api_v1.sensor_readings r
    join api_v1.sensor_devices d on d.id = r.device_id where d.horse_id = $1 and r.measured_at > now() - interval '24 hours'
    order by r.measured_at`, [horseId]);
  if (!rows.ok || !rows.rows.length) return null;
  const last = rows.rows[rows.rows.length - 1];
  return { t: Number(last.temperature), h: Number(last.humidity), temps: rows.rows.map((r) => Number(r.temperature)), hums: rows.rows.map((r) => Number(r.humidity)), at: last.measured_at };
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------
function signIn() {
  render(`<div class="signin">
    <h1>Stable</h1>
    <p>Horses, training, stall climate and your equipment. Everything you see follows the same permission rules the backend enforces.</p>
    <p class="small" style="color:rgba(255,255,255,.75)">Demo: pick who you are. A real app would sign you in by email.</p>
    <div class="people">
      ${Object.entries(PEOPLE).map(([k, p]) => `<button data-me="${k}"><b>${esc(p.name)}</b><span>${esc(p.blurb)}</span></button>`).join('')}
      <button class="ghost" data-me="visitor"><b>Continue without an account</b><span>You can scan a product and read its passport</span></button>
    </div>
  </div>`);
}

async function home(tok) {
  if (me === 'visitor') { location.hash = '#/scan'; return; }
  const horses = await must(`select id, name, my_role, stable_id from api_v1.horses order by name`);
  const cards = [];
  for (const h of horses) {
    const c = await climate(h.id);
    const last = (await call(`select logged_on, minutes, notes from api_v1.training_logs where horse_id = $1 order by logged_on desc, created_at desc limit 1`, [h.id])).rows?.[0];
    const stable = h.stable_id ? (await call(`select name from api_v1.stables where id = $1`, [h.stable_id])).rows?.[0]?.name : null;
    cards.push(`<a class="card tap" href="#/horse/${h.id}">
      <header><h2>${esc(h.name)}</h2>${roleBadge(h.my_role)}</header>
      <div class="chips">${c ? `<span class="chip">Stall ${c.t} °C</span><span class="chip">${c.h}% humidity</span>` : '<span class="chip">No sensor</span>'}${stable ? `<span class="muted" style="padding:5px 0">${esc(stable)}</span>` : ''}</div>
      <p class="muted">${last ? `Last training: ${esc(last.notes || 'training')}, ${last.minutes} min, ${fmtDate(last.logged_on).toLowerCase()}` : 'No training logged yet'}</p>
    </a>`);
  }
  const hour = new Date().getHours();
  render(`<header class="top">
      <div class="row"><p class="greet">Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}, ${esc(PEOPLE[me].name)}</p>${syncPill()}</div>
      <h1>My horses</h1>
    </header>
    ${offline ? `<p class="banner"><svg viewBox="0 0 24 24"><path d="M5 12.6a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01M3 3l18 18"/></svg>No signal. You can keep working; changes sync later.</p>` : ''}
    <main>
      ${cards.join('') || `<div class="card"><p>No horses yet.</p><p class="muted">An owner can add you as trainer or caretaker. Or scan a product to register your equipment.</p></div>`}
      ${me === 'eve' ? '' : `<a class="btn ghost" href="#/new-horse">Add a horse</a>`}
    </main>`, { tab: 'home' }, tok);
}

async function horse(tok, id) {
  const h = (await call(`select id, name, my_role, stable_id from api_v1.horses where id = $1`, [id])).rows?.[0];
  if (!h) { render(`<header class="top compact"><a class="back" href="#/home" aria-label="Back"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg></a><h1>Not available</h1></header><main><div class="card"><p>You don't have access to this horse.</p></div></main>`, { tab: 'home' }, tok); return; }
  const c = await climate(id);
  const logs = (await call(`select id, logged_on, minutes, notes from api_v1.training_logs where horse_id = $1 order by logged_on desc, created_at desc limit 6`, [id])).rows || [];
  const people = (await call(`select user_id, display_name, role from api_v1.horse_people where horse_id = $1 order by role, display_name`, [id])).rows || [];
  const device = (await call(`select serial from api_v1.sensor_devices where horse_id = $1 limit 1`, [id])).rows?.[0];
  const canLog = await can(`select api_v1.upsert_training_log(gen_random_uuid(), $1, current_date, 1, 'check')`, [id]).then(async (r) => { if (r.ok) await admin(`delete from app.training_logs where notes = 'check' and horse_id = $1`, [id]); return r; });
  const canPhoto = await can(`select api_v1.authorize_horse_media($1, 'write')`, [id]);
  const canInvite = await can(`select api_v1.set_horse_role($1, $1, 'caretaker')`, [id]);
  const canSensor = await can(`select api_v1.register_sensor($1, 'BLE-CHECK-00')`, [id]).then(async (r) => { if (r.ok) await admin(`delete from app.sensor_devices where serial = 'BLE-CHECK-00'`); return r; });
  const pendingHere = queue.filter((q) => q.horse === id).length;
  render(`<div class="hero"><a class="back" href="#/home" aria-label="Back to my horses"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg></a><span>Photo of ${esc(h.name)}</span></div>
    <main>
      <div class="between"><div><h1 style="margin:0;font:700 32px/1 var(--cond)">${esc(h.name)}</h1><p class="muted">${h.stable_id ? 'Boarded at ' + esc((await call(`select name from api_v1.stables where id = $1`, [h.stable_id])).rows?.[0]?.name || 'a stable') : 'Kept at home'}</p></div>${roleBadge(h.my_role)}</div>
      ${pendingHere ? `<p class="banner">${pendingHere} change${pendingHere > 1 ? 's' : ''} saved on this phone, waiting for signal.</p>` : ''}
      <section class="card">
        <header><h3>Stall climate, last 24 hours</h3><span class="small">${device ? 'Sensor ' + esc(device.serial) : 'No sensor'}</span></header>
        ${c ? `<div style="display:flex;gap:20px;align-items:baseline"><span class="big">${c.t} °C</span><span class="big blue">${c.h}%</span><span class="muted">humidity</span></div>
        <svg class="spark" viewBox="0 0 356 54" preserveAspectRatio="none" role="img" aria-label="Temperature and humidity over the last 24 hours">${spark(c.temps, '#17211c')}${spark(c.hums, '#2c5d8a', true)}</svg>
        <p class="small">Solid line temperature, dashed humidity. Last reading ${new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</p>`
        : `<p class="muted">No readings in the last 24 hours.</p>`}
        ${device ? `<button class="btn ghost sm" data-act="readings" data-horse="${id}">Upload readings from the sensor</button>` : `<button class="btn ghost sm" data-act="sensor" data-horse="${id}" ${canSensor.ok ? '' : 'disabled'}>Register a sensor</button>${whyLine(canSensor)}`}
      </section>
      <div class="between"><h2 class="sec" style="margin:0">Training</h2><a class="btn sm ${canLog.ok ? '' : 'disabled'}" href="#/log/${id}" ${canLog.ok ? '' : 'aria-disabled="true" style="pointer-events:none;background:#e7ebe8;color:#6b766f"'}>Log training</a></div>
      ${whyLine(canLog)}
      <ul class="list">${logs.length ? logs.map((l) => `<li><span class="grow">${esc(l.notes || 'Training')}</span><span class="muted">${fmtDate(l.logged_on)}, ${l.minutes} min</span></li>`).join('') : '<li class="empty">No training logged yet</li>'}</ul>
      <h2 class="sec">Photos</h2>
      <div class="card"><button class="btn ghost sm" data-act="photo" data-horse="${id}" ${canPhoto.ok ? '' : 'disabled'}>Add a photo</button>${whyLine(canPhoto)}<p class="small">Photos live in a private bucket. The app asks the backend for a short-lived upload link; the backend checks your role first.</p></div>
      <h2 class="sec">People</h2>
      <div class="list">${people.map((p) => `<li><span class="who badge ${esc(p.role)}">${esc(p.display_name[0])}</span><span class="grow">${esc(p.display_name)}${p.user_id === PEOPLE[me].id ? ' (you)' : ''}</span><span class="muted">${esc(cap(p.role))}</span>${canInvite.ok && p.role !== 'owner' ? `<button class="btn ghost sm" data-act="remove" data-horse="${id}" data-user="${p.user_id}" aria-label="Remove ${esc(p.display_name)}">Remove</button>` : ''}</li>`).join('')}
        ${canInvite.ok ? `<button class="link" data-act="invite" data-horse="${id}">Invite a trainer or caretaker</button>` : `<li class="small" style="justify-content:flex-start">${esc(canInvite.why)}</li>`}
      </div>
    </main>`, { tab: 'home' }, tok);
}

async function logTraining(tok, horseId) {
  const h = (await call(`select name from api_v1.horses where id = $1`, [horseId])).rows?.[0];
  const horses = await must(`select id, name, my_role from api_v1.horses order by name`);
  const state = { type: 'Flatwork', minutes: 45 };
  const draw = () => render(`<header class="top compact"><a class="back" href="#/horse/${horseId}" aria-label="Back"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg></a><h1>Log training</h1></header>
    ${offline ? `<p class="banner"><svg viewBox="0 0 24 24"><path d="M5 12.6a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01M3 3l18 18"/></svg>No signal. This log is saved on your phone and syncs later.</p>` : ''}
    <main>
      <div class="field"><label for="f-horse">Horse</label><select id="f-horse">${horses.map((x) => `<option value="${x.id}" ${x.id === horseId ? 'selected' : ''}>${esc(x.name)}${x.my_role ? ` (${x.my_role})` : ''}</option>`).join('')}</select></div>
      <div class="field"><span class="lbl">Type</span><div class="grid2">${['Flatwork', 'Jumping', 'Hacking', 'Lunging'].map((t) => `<button type="button" class="btn ghost sm ${state.type === t ? 'on' : ''}" data-type="${t}">${t}</button>`).join('')}</div></div>
      <div class="grid2">
        <div class="field"><label for="f-date">Date</label><input id="f-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="field"><span class="lbl">Minutes</span><div class="stepper"><button type="button" data-min="-5" aria-label="Five minutes less">−</button><span id="f-min">${state.minutes}</span><button type="button" data-min="5" aria-label="Five minutes more">+</button></div></div>
      </div>
      <div class="field"><label for="f-notes">Notes</label><textarea id="f-notes" rows="4" placeholder="How did it go?"></textarea></div>
      <button class="btn" id="f-save">Save training</button>
      <p class="small" style="text-align:center">Each log gets its own id from this phone, so syncing it twice never saves it twice.</p>
    </main>`, { tab: 'home' }, tok);
  draw();
  screen.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-type]'); if (t) { state.type = t.dataset.type; screen.querySelectorAll('[data-type]').forEach((b) => b.classList.toggle('on', b.dataset.type === state.type)); }
    const m = e.target.closest('[data-min]'); if (m) { state.minutes = Math.min(600, Math.max(5, state.minutes + Number(m.dataset.min))); $('#f-min').textContent = state.minutes; }
    if (e.target.closest('#f-save')) {
      const horse = $('#f-horse').value, date = $('#f-date').value, notes = `${state.type}${$('#f-notes').value.trim() ? ': ' + $('#f-notes').value.trim() : ''}`;
      const item = { kind: 'training', who: me, horse, sql: `select api_v1.upsert_training_log($1, $2, $3, $4, $5)`, params: [crypto.randomUUID(), horse, date, state.minutes, notes], label: `${notes}, ${state.minutes} min` };
      if (offline) { enqueue(item); toast('Saved on this phone. It will sync when you have signal.'); location.hash = `#/horse/${horse}`; return; }
      const r = await call(item.sql, item.params);
      if (r.ok) { toast('Training saved.'); location.hash = `#/horse/${horse}`; } else toast(cap(r.error.replace(/^forbidden: /, '')), true);
    }
  }, { once: false });
  void h;
}

async function scan(tok, code) {
  const chosen = code || store.get('stable.lastScan', '');
  let p = null, err = null;
  if (chosen) { const r = await call(`select api_v1.passport($1) as p`, [chosen]); if (r.ok) p = r.rows[0].p; else err = r.error; }
  const mine = me && me !== 'visitor' ? await must(`select id, name, my_role from api_v1.horses where my_role in ('owner','trainer') order by name`) : [];
  const others = me && me !== 'visitor' ? (await call(`select id, display_name from api_v1.people order by display_name`)).rows || [] : [];
  const product = p ? (await admin(`select id from app.products where qr_code = $1`, [p.public.qr_code]))[0]?.id : null;
  render(`<div class="scan-top">
      ${me ? `<a class="back" href="${me === 'visitor' ? '#/signin' : '#/home'}" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></a>` : ''}
      <div class="viewfinder"><svg viewBox="0 0 190 190" aria-hidden="true"><path d="M2 40V2h38M150 2h38v38M188 150v38h-38M40 188H2v-38" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/></svg>
        <select id="scan-pick" aria-label="Point the camera at a label (demo: choose one)"><option value="">Point at a label</option>${PRODUCTS.map((x) => `<option value="${x.code}" ${x.code === chosen ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></div>
      <p class="muted" style="margin:0">${chosen ? `Code ${esc(chosen)} found` : 'Demo: choose a label to scan'}</p>
    </div>
    <main>
      ${err ? `<div class="card"><p>${esc(cap(err))}</p></div>` : ''}
      ${p ? `<div><p class="muted" style="margin:0 0 2px">Digital product passport</p><h1 style="margin:0;font:700 28px/1.05 var(--cond)">${esc(p.public.model)}</h1></div>
      <dl class="passport"><dt>Product</dt><dd>${esc(cap(p.public.product_type))}</dd><dt>Batch</dt><dd>${esc(p.public.batch)}</dd><dt>Made</dt><dd>${esc(String(p.public.manufactured_on).slice(0, 10))}</dd><dt>Materials</dt><dd>${esc(p.public.materials.join(', '))}</dd><dt>Care</dt><dd>${esc(p.public.care)}</dd><dt>Registered</dt><dd>${p.public.registered ? 'Yes' : 'Not yet'}</dd></dl>
      ${p.owner ? `<div class="owner-box"><strong>Registered to you${p.owner.horse ? ', on ' + esc(p.owner.horse.name) : ''}</strong><p class="small" style="color:inherit">Since ${new Date(p.owner.registered_at).toLocaleDateString()}. ${p.owner.history.map((e) => e.from ? `${esc(e.from)} to ${esc(e.to)}` : `Registered by ${esc(e.to)}`).join(', ')}.</p></div>
        ${others.length ? `<div class="card"><h3>Sold or given away?</h3><div class="field"><label for="t-to">Transfer to</label><select id="t-to">${others.map((o) => `<option value="${o.id}">${esc(o.display_name)}</option>`).join('')}</select></div><button class="btn ghost sm" data-act="transfer" data-product="${product}">Transfer ownership</button><p class="small">The new owner sees the full history. You keep nothing.</p></div>` : ''}`
      : p.public.registered ? `<div class="card"><p>Registered to someone else.</p><p class="small">Who, and on which horse, is shown only to the owner. Ask them to transfer it to you.</p></div>`
      : me && me !== 'visitor' ? `<div class="card"><p>Not registered yet. Register it to keep its history with your horse.</p>
          <div class="field"><label for="r-horse">For which horse</label><select id="r-horse"><option value="">Just me, no horse</option>${mine.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></div>
          <button class="btn" data-act="register" data-code="${esc(p.public.qr_code)}">Register to me</button></div>`
      : `<div class="card"><p>Not registered yet.</p><p class="small">Sign in to register it to yourself and your horse.</p><a class="btn ghost sm" href="#/signin">Sign in</a></div>`}
      <p class="small">Anyone can read this passport, with or without an account. Who owns it is shown only to the owner.</p>` : ''}
    </main>`, { tab: 'scan' }, tok);
  if (chosen) store.set('stable.lastScan', chosen);
}

async function stable(tok) {
  if (me === 'visitor') { location.hash = '#/scan'; return; }
  const stables = await must(`select id, name from api_v1.stables order by name`);
  if (!stables.length) { render(`<header class="top"><h1>Stable</h1></header><main><div class="card"><p>You're not part of a stable yet.</p><p class="muted">A stable manager can add you as staff, or you can set up your own.</p><button class="btn ghost sm" data-act="new-stable">Set up a stable</button></div></main>`, { tab: 'stable' }, tok); return; }
  const s = stables[0];
  const horses = (await call(`select id, name, my_role from api_v1.horses where stable_id = $1 order by name`, [s.id])).rows || [];
  const cards = [];
  for (const h of horses) {
    const c = await climate(h.id);
    const warn = c && c.h >= 80;
    cards.push(`<a class="card tap" href="#/horse/${h.id}"><header><h2>${esc(h.name)}</h2>${roleBadge(h.my_role)}</header>
      <div class="chips">${c ? `<span class="chip">${c.t} °C</span><span class="chip" ${warn ? 'style="background:var(--warn-bg);color:var(--warn)"' : ''}>${c.h}% humidity</span>` : '<span class="chip">No sensor</span>'}</div>
      ${warn ? `<p class="small" style="color:var(--warn)">High humidity. Check ventilation before tonight.</p>` : ''}</a>`);
  }
  render(`<header class="top"><div class="row"><p class="greet">${esc(PEOPLE[me].name)}</p>${syncPill()}</div><h1>${esc(s.name)}</h1><p class="sub">${horses.length} horse${horses.length === 1 ? '' : 's'} you can see here</p></header>
    <main>${cards.join('') || '<div class="card"><p class="muted">No horses boarded here yet.</p></div>'}
    <p class="small">A stable manager sees every horse boarded here and its climate, and can read training logs, but only an owner or trainer can write them.</p></main>`, { tab: 'stable' }, tok);
}

function profile() {
  render(`<header class="top"><h1>${me === 'visitor' ? 'Visitor' : esc(PEOPLE[me].name)}</h1><p class="sub">${me === 'visitor' ? 'Not signed in' : esc(PEOPLE[me].blurb)}</p></header>
    <main>
      <div class="card"><div class="switch"><div><p><strong>Simulate no signal</strong></p><p class="small">The database runs on this device, so this switch controls the sync queue, not the data.</p></div><input type="checkbox" id="p-offline" ${offline ? 'checked' : ''} aria-label="Simulate no signal"></div></div>
      <div class="card"><header><h3>Waiting to sync</h3><span class="small">${queue.length} item${queue.length === 1 ? '' : 's'}</span></header>
        ${queue.length ? `<ol class="queue">${queue.map((q) => `<li>${esc(q.label)}</li>`).join('')}</ol><button class="btn sm" data-act="sync" ${offline ? 'disabled' : ''}>Sync now</button>${offline ? '<p class="small">Turn the signal back on to sync.</p>' : ''}` : '<p class="muted">Nothing waiting.</p>'}
      </div>
      <div class="card"><button class="btn ghost sm" data-act="signout">Switch person</button><button class="btn ghost sm" data-act="reset">Reset the demo data</button><p class="small">Reset wipes this device's copy of the database and loads the stable again.</p></div>
    </main>`, { tab: 'profile' });
}

async function newHorse(tok) {
  const stables = await must(`select id, name from api_v1.stables order by name`);
  render(`<header class="top compact"><a class="back" href="#/home" aria-label="Back"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg></a><h1>Add a horse</h1></header>
    <main><div class="field"><label for="n-name">Name</label><input id="n-name" placeholder="Horse's name"></div>
    <div class="field"><label for="n-stable">Boarded at</label><select id="n-stable"><option value="">At home</option>${stables.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
    <button class="btn" data-act="create-horse">Add horse</button><p class="small">You become the owner and can invite a trainer or caretaker from the horse's page.</p></main>`, { tab: 'home' }, tok);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function action(el) {
  const a = el.dataset.act, horse = el.dataset.horse;
  const feedback = (r, okText) => { if (r.ok) toast(okText); else toast(cap(r.error.replace(/^forbidden: /, '')), true); return r.ok; };
  if (a === 'readings') {
    const dev = (await call(`select id from api_v1.sensor_devices where horse_id = $1 limit 1`, [horse])).rows?.[0];
    const last = Number((await call(`select coalesce(max(seq), 0) as s from api_v1.sensor_readings where device_id = $1`, [dev.id])).rows?.[0]?.s || 0);
    const batch = Array.from({ length: 3 }, (_, i) => ({ seq: last + i + 1, measured_at: new Date(Date.now() - (2 - i) * 600e3).toISOString(), temperature: +(7 + Math.random() * 2).toFixed(1), humidity: Math.round(72 + Math.random() * 10) }));
    const item = { kind: 'readings', who: me, horse, sql: `select * from api_v1.upload_readings($1, $2)`, params: [dev.id, JSON.stringify(batch)], label: `3 sensor readings for a horse` };
    if (offline) { enqueue(item); toast('3 readings saved on this phone, waiting for signal.'); return route(); }
    const r = await call(item.sql, item.params);
    if (feedback(r, `${r.rows?.[0]?.accepted ?? 0} new readings stored.`)) route();
  } else if (a === 'sensor') {
    const serial = prompt('Sensor serial (on the box)', 'BLE-' + Math.random().toString(36).slice(2, 6).toUpperCase());
    if (!serial) return;
    if (feedback(await call(`select api_v1.register_sensor($1, $2)`, [horse, serial]), 'Sensor registered.')) route();
  } else if (a === 'photo') {
    const r = await call(`select api_v1.authorize_horse_media($1, 'write') as folder`, [horse]);
    feedback(r, `Upload allowed. The app would now get a signed link for ${r.rows?.[0]?.folder || 'the horse folder'}.`);
  } else if (a === 'invite') {
    const people = (await call(`select id, display_name from api_v1.people order by display_name`)).rows || [];
    if (!people.length) return toast('Nobody to invite yet: you only see people who share a horse or stable with you.', true);
    const who = prompt('Invite who?\n' + people.map((p, i) => `${i + 1}. ${p.display_name}`).join('\n'), '1');
    const p = people[Number(who) - 1]; if (!p) return;
    const role = prompt('As what? trainer or caretaker', 'trainer');
    if (!['trainer', 'caretaker', 'owner'].includes(role)) return toast('Role must be trainer, caretaker or owner.', true);
    if (feedback(await call(`select api_v1.set_horse_role($1, $2, $3)`, [horse, p.id, role]), `${p.display_name} added as ${role}.`)) route();
  } else if (a === 'remove') {
    if (feedback(await call(`select api_v1.revoke_horse_role($1, $2)`, [horse, el.dataset.user]), 'Removed.')) route();
  } else if (a === 'register') {
    const h = $('#r-horse').value || null;
    if (feedback(await call(`select api_v1.register_product($1, $2)`, [el.dataset.code, h]), 'Registered to you.')) route();
  } else if (a === 'transfer') {
    const to = $('#t-to').value;
    if (feedback(await call(`select api_v1.transfer_product($1, $2)`, [el.dataset.product, to]), 'Transferred.')) route();
  } else if (a === 'sync') {
    const results = await sync();
    const ok = results.filter((x) => x.r.ok).length, bad = results.filter((x) => !x.r.ok);
    toast(bad.length ? `${ok} synced, ${bad.length} refused: ${cap(bad[0].r.error.replace(/^forbidden: /, ''))}` : `${ok} change${ok === 1 ? '' : 's'} synced.`, bad.length > 0);
    route();
  } else if (a === 'signout') {
    me = null; store.set('stable.me', null); if (location.hash === '#/signin') route(); else location.hash = '#/signin';
  } else if (a === 'reset') {
    if (!confirm('Reset the demo data on this device?')) return;
    store.set('stable.seeded', false); store.set('stable.queue', []); store.set('stable.schema', null); store.set('stable.lastScan', '');
    await db.close?.();
    await new Promise((r) => { const q = indexedDB.deleteDatabase('/pglite/stable-app'); q.onsuccess = q.onerror = q.onblocked = () => r(); });
    location.reload();
  } else if (a === 'create-horse') {
    const name = $('#n-name').value.trim(); if (!name) return toast('Give the horse a name.', true);
    const r = await call(`select api_v1.create_horse($1, $2) as id`, [name, $('#n-stable').value || null]);
    if (feedback(r, `${name} added.`)) location.hash = `#/horse/${r.rows[0].id}`;
  } else if (a === 'new-stable') {
    const name = prompt('Stable name', 'My yard'); if (!name) return;
    if (feedback(await call(`select api_v1.create_stable($1)`, [name]), 'Stable created. You are its manager.')) route();
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function route() {
  const [path, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const tok = ++nav;
  try {
    if (!me && path !== 'scan' && path !== 'signin') { location.hash = '#/signin'; return; }
    if (path === '' || path === 'signin') return me ? (location.hash = '#/home') : signIn();
    if (path === 'home') return home(tok);
    if (path === 'horse') return horse(tok, arg);
    if (path === 'log') return logTraining(tok, arg);
    if (path === 'scan') return scan(tok, arg);
    if (path === 'stable') return stable(tok);
    if (path === 'profile') return profile();
    if (path === 'new-horse') return newHorse(tok);
    location.hash = '#/home';
  } catch (e) {
    render(`<main><div class="card"><p>Something went wrong.</p><p class="small">${esc(e.message)}</p><a class="btn ghost sm" href="#/home">Back</a></div></main>`);
  }
}

window.addEventListener('hashchange', route);
document.addEventListener('click', (e) => {
  const me_ = e.target.closest('[data-me]');
  if (me_) { me = me_.dataset.me; store.set('stable.me', me); const to = me === 'visitor' ? '#/scan' : '#/home'; if (location.hash === to) route(); else location.hash = to; return; }
  const go = e.target.closest('[data-go]'); if (go) { location.hash = go.dataset.go; return; }
  const act = e.target.closest('[data-act]'); if (act) { action(act); return; }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'p-offline') { offline = e.target.checked; store.set('stable.offline', offline); toast(offline ? 'Simulating no signal.' : 'Signal is back.'); profile(); }
  if (e.target.id === 'scan-pick' && e.target.value) { location.hash = `#/scan/${e.target.value}`; }
});

(async () => {
  try {
    const started = Date.now();
    const setText = (t) => { const b = $('#boot-text'); if (b) b.textContent = t; };
    const slow = setInterval(() => {
      const s = Math.round((Date.now() - started) / 1000);
      const n = $('#boot-note'); if (n && s >= 6) n.textContent = `First start downloads the database engine (15 MB) and builds a sample stable on this phone. ${s} s so far; it opens instantly after this.`;
    }, 1000);
    try { await openDb(setText); } finally { clearInterval(slow); }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    route();
  } catch (e) {
    render(`<main><div class="card"><p>This browser could not start the database.</p><p class="small">${esc(e.message)}</p></div></main>`);
  }
})();
