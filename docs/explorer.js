import { PGlite } from './vendor/pglite/index.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Fixed ids so every visitor sees the same story.
const U = {
  anna: '0a000000-0000-4000-8000-000000000001',
  ben: '0b000000-0000-4000-8000-000000000002',
  carl: '0c000000-0000-4000-8000-000000000003',
  dana: '0d000000-0000-4000-8000-000000000004',
  eve: '0e000000-0000-4000-8000-000000000005',
  visitor: null,
};
const NAMES = { anna: 'Anna', ben: 'Ben', carl: 'Carl', dana: 'Dana', eve: 'Eve', visitor: 'A visitor' };
const PEOPLE = ['anna', 'ben', 'carl', 'dana', 'eve', 'visitor'];
const RUG = 'EQ-7K4Q29XD3M';

const db = new PGlite();
let ids = {};

// One call as one person, the way PostgREST runs it on Supabase:
// role anon/authenticated + the user id in request.jwt.claims, inside a transaction.
let chain = Promise.resolve();
function call(person, sql, params = [], { rollback = false } = {}) {
  const run = async () => {
    await db.exec('begin');
    try {
      await db.exec(`set local role ${U[person] ? 'authenticated' : 'anon'}`);
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [U[person] ? JSON.stringify({ sub: U[person] }) : '']);
      const res = await db.query(sql, params);
      await db.exec(rollback ? 'rollback' : 'commit');
      return { ok: true, rows: res.rows };
    } catch (e) {
      await db.exec('rollback');
      return { ok: false, error: e.message, code: e.code };
    }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}
const admin = async (sql, params = []) => { await chain; return (await db.query(sql, params)).rows; };

async function boot() {
  const status = $('#status');
  const files = await (await fetch('sql/index.json')).json();
  for (const f of files) {
    status.lastChild.textContent = `Applying ${f}`;
    await db.exec(await (await fetch(`sql/${f}`)).text());
  }
  status.lastChild.textContent = 'Loading the story';
  for (const p of PEOPLE.filter((p) => U[p])) await admin(`insert into app.profiles (id, display_name) values ($1, $2)`, [U[p], NAMES[p]]);
  const one = async (person, sql, params) => {
    const r = await call(person, sql, params);
    if (!r.ok) throw new Error(r.error);
    return r.rows[0];
  };
  ids.stable = (await one('dana', `select api_v1.create_stable('Willow Farm') as id`)).id;
  await admin(`insert into app.stable_members (stable_id, user_id, role) values ($1, $2, 'staff')`, [ids.stable, U.ben]);
  ids.storm = (await one('anna', `select api_v1.create_horse('Storm') as id`)).id;
  ids.luna = (await one('ben', `select api_v1.create_horse('Luna', $1) as id`, [ids.stable])).id;
  await one('ben', `select api_v1.set_horse_role($1, $2, 'trainer')`, [ids.luna, U.anna]);
  await one('anna', `select api_v1.set_horse_role($1, $2, 'caretaker')`, [ids.storm, U.carl]);
  ids.stormDevice = (await one('anna', `select api_v1.register_sensor($1, 'BLE-STORM-01') as id`, [ids.storm])).id;
  ids.lunaDevice = (await one('ben', `select api_v1.register_sensor($1, 'BLE-LUNA-01') as id`, [ids.luna])).id;
  await one('ben', `select api_v1.upsert_training_log(gen_random_uuid(), $1, current_date - 1, 40, 'Lunging, 3 x 10 min')`, [ids.luna]);
  await one('anna', `select api_v1.upsert_training_log(gen_random_uuid(), $1, current_date, 45, 'Flatwork, trot sets')`, [ids.luna]);
  await one('anna', `select api_v1.upsert_training_log(gen_random_uuid(), $1, current_date, 30, 'Hacking in the forest')`, [ids.storm]);
  await one('ben', `select * from api_v1.upload_readings($1, $2)`, [ids.lunaDevice, JSON.stringify([{ seq: 1, measured_at: '2026-11-05T06:00:00Z', temperature: 7.5, humidity: 81 }])]);
  await admin(
    `insert into app.products (qr_code, product_type, model, batch, manufactured_on, materials, care) values
       ($1, 'rug', 'Thermo Turnout 200g', 'B-2026-031', '2026-03-12', '["recycled polyester","merino lining"]', 'Wash cold, air dry'),
       ('EQ-B00T5X21QA', 'boots', 'Brushing Boot Pro', 'B-2026-044', '2026-04-02', '["neoprene","TPU shell"]', 'Rinse after use')`,
    [RUG],
  );
  ids.rug = (await admin(`select id from app.products where qr_code = $1`, [RUG]))[0].id;
}

// ---------------------------------------------------------------------------
// The permission grid
// ---------------------------------------------------------------------------
const ACTIONS = [
  { key: 'see', label: 'See the horse', sql: () => `select count(*)::int as n from api_v1.horses where id = $1`, args: (h) => [h.id], check: (r) => r.rows[0].n === 1 || 'Not visible: no role on this horse and not its stable manager' },
  { key: 'photos', label: 'View photos', sql: () => `select api_v1.authorize_horse_media($1, 'read') as folder`, args: (h) => [h.id] },
  { key: 'train', label: 'Log training', sql: () => `select api_v1.upsert_training_log(gen_random_uuid(), $1, current_date, 30, 'Trot sets')`, args: (h) => [h.id] },
  { key: 'upload', label: 'Upload photos', sql: () => `select api_v1.authorize_horse_media($1, 'write') as folder`, args: (h) => [h.id] },
  { key: 'readings', label: 'Upload sensor readings', sql: () => `select * from api_v1.upload_readings($1, '[{"seq":99,"measured_at":"2026-11-06T08:00:00Z","temperature":8.1,"humidity":78}]')`, args: (h) => [h.device] },
  { key: 'role', label: 'Give someone a role', sql: () => `select api_v1.set_horse_role($1, $2, 'caretaker')`, args: (h) => [h.id, U.eve] },
  { key: 'sensor', label: 'Register a sensor', sql: () => `select api_v1.register_sensor($1, 'BLE-NEW-0042')`, args: (h) => [h.id] },
];
let results = {};

async function buildGrid() {
  const horses = [
    { key: 'storm', name: 'Storm', note: "Anna's horse", id: ids.storm, device: ids.stormDevice },
    { key: 'luna', name: 'Luna', note: "Ben's horse, boarded at Willow Farm", id: ids.luna, device: ids.lunaDevice },
  ];
  const body = $('#grid-body');
  body.innerHTML = '';
  const started = performance.now();
  let count = 0;
  for (const h of horses) {
    const head = document.createElement('tr');
    head.className = 'horse';
    head.innerHTML = `<th scope="rowgroup" colspan="1">${esc(h.name)}<span>${esc(h.note)}</span></th>${PEOPLE.map(() => '<td></td>').join('')}`;
    body.append(head);
    for (const a of ACTIONS) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<th scope="row">${esc(a.label)}</th>`;
      for (const p of PEOPLE) {
        const sql = a.sql();
        const params = a.args(h);
        const r = await call(p, sql, params, { rollback: true });
        count++;
        let allowed = r.ok;
        let reason = r.ok ? null : r.error;
        if (r.ok && a.check) { const c = a.check(r); if (c !== true) { allowed = false; reason = c; } }
        const id = `${h.key}-${a.key}-${p}`;
        results[id] = { person: p, horse: h, action: a, sql, params, allowed, reason, code: r.code, rows: r.rows };
        const td = document.createElement('td');
        td.innerHTML = `<button type="button" class="cell ${allowed ? 'yes' : 'no'}" data-id="${id}" aria-pressed="false" aria-label="${esc(NAMES[p])}, ${esc(a.label)} on ${esc(h.name)}: ${allowed ? 'allowed' : 'refused'}">${allowed ? '✓' : '✕'}</button>`;
        tr.append(td);
      }
      body.append(tr);
    }
  }
  return { count, ms: Math.round(performance.now() - started) };
}

function showDetail(id) {
  const r = results[id];
  document.querySelectorAll('.cell[aria-pressed="true"]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  document.querySelector(`.cell[data-id="${id}"]`)?.setAttribute('aria-pressed', 'true');
  const shown = r.params.map((v) => (v === r.horse.id ? `'${r.horse.name}'` : v === r.horse.device ? `'${r.horse.name}''s sensor'` : v === U.eve ? `'Eve'` : v));
  let sql = r.sql;
  shown.forEach((v, i) => { sql = sql.replace(`$${i + 1}`, v); });
  const d = $('#detail');
  d.hidden = false;
  d.innerHTML = `<h3>${esc(NAMES[r.person])}: ${esc(r.action.label.toLowerCase())} on ${esc(r.horse.name)}</h3>
    <pre>${esc(sql)}</pre>
    <p class="verdict ${r.allowed ? 'yes' : 'no'}">${r.allowed ? 'Allowed. The call succeeded (and was rolled back).' : `Refused: ${esc(r.reason)}${r.code ? ` (SQLSTATE ${esc(r.code)})` : ''}`}</p>`;
}

// ---------------------------------------------------------------------------
// QR passport
// ---------------------------------------------------------------------------
function drawQr() {
  if (typeof window.qrcode !== 'function') { $('#qr-code').textContent = RUG; return; }
  const qr = window.qrcode(0, 'M');
  qr.addData(RUG);
  qr.make();
  $('#qr-code').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
}

function logLine(target, ok, text) {
  const li = document.createElement('li');
  li.className = ok ? 'yes' : 'no';
  li.textContent = text;
  $(target).prepend(li);
}

async function scan(person) {
  document.querySelectorAll('[data-scan]').forEach((b) => b.classList.toggle('current', b.dataset.scan === person));
  const r = await call(person, `select api_v1.passport($1) as p`, [RUG]);
  const box = $('#passport');
  if (!r.ok) { box.innerHTML = `<p class="empty">${esc(r.error)}</p>`; return; }
  const p = r.rows[0].p;
  const pub = p.public;
  let html = `<h3>${esc(pub.model)}</h3><p class="caller">Scanned by ${esc(NAMES[person].toLowerCase() === 'a visitor' ? 'a visitor without an account' : NAMES[person])}</p>
    <dl>
      <dt>Product</dt><dd>${esc(pub.product_type)}</dd>
      <dt>Batch</dt><dd>${esc(pub.batch)}</dd>
      <dt>Made</dt><dd>${esc(pub.manufactured_on)}</dd>
      <dt>Materials</dt><dd>${esc(pub.materials.join(', '))}</dd>
      <dt>Care</dt><dd>${esc(pub.care)}</dd>
      <dt>Registered</dt><dd>${pub.registered ? 'Yes' : 'Not yet'}</dd>
    </dl>`;
  if (p.owner) {
    html += `<div class="owner"><h4>Owner section, visible only to ${esc(NAMES[person])}</h4><dl>
      <dt>On horse</dt><dd>${p.owner.horse ? esc(p.owner.horse.name) : 'Not attached'}</dd>
      <dt>History</dt><dd>${p.owner.history.map((e) => `${e.from ? esc(e.from) + ' to ' : 'Registered by '}${esc(e.to)}`).join('<br>')}</dd></dl></div>`;
  } else {
    html += `<p class="locked">${pub.registered ? 'Registered to someone else. Who, and on which horse, is shown only to the owner.' : 'Nobody has registered it yet.'}</p>`;
  }
  box.innerHTML = html;
}

async function qrAction(act) {
  if (act === 'register') {
    const r = await call('anna', `select api_v1.register_product($1, $2)`, [RUG, ids.storm]);
    logLine('#qr-log', r.ok, r.ok ? 'Anna registered the rug to Storm.' : `Anna: ${r.error}`);
    await scan('anna');
  } else if (act === 'steal') {
    const r = await call('eve', `select api_v1.register_product($1)`, [RUG]);
    logLine('#qr-log', r.ok, r.ok ? 'Eve registered the rug (nobody owned it yet).' : `Refused for Eve: ${r.error}`);
    await scan('eve');
  } else if (act === 'transfer') {
    const r = await call('anna', `select api_v1.transfer_product($1, $2)`, [ids.rug, U.ben]);
    logLine('#qr-log', r.ok, r.ok ? 'Anna transferred the rug to Ben.' : `Refused for Anna: ${r.error}`);
    await scan(r.ok ? 'ben' : 'anna');
  }
  await renderOutbox();
  await renderPhone();
}

// ---------------------------------------------------------------------------
// Offline sensor upload
// ---------------------------------------------------------------------------
const reading = (seq) => ({ seq, measured_at: new Date(Date.UTC(2026, 10, 6, 5, seq * 10)).toISOString(), temperature: +(6 + seq * 0.3).toFixed(1), humidity: 84 - seq });
const BATCHES = {
  first: { label: 'Readings 1 to 6', rows: [1, 2, 3, 4, 5, 6].map(reading) },
  again: { label: 'Same batch, resent', rows: [1, 2, 3, 4, 5, 6].map(reading) },
  next: { label: 'Readings 5 to 9', rows: [5, 6, 7, 8, 9].map(reading) },
};
async function upload(which) {
  const b = BATCHES[which];
  const r = await call('anna', `select * from api_v1.upload_readings($1, $2)`, [ids.stormDevice, JSON.stringify(b.rows)]);
  const body = $('#sync-body');
  body.querySelector('.placeholder')?.remove();
  const tr = document.createElement('tr');
  tr.innerHTML = r.ok
    ? `<td>${esc(b.label)}</td><td class="num">${r.rows[0].accepted}</td><td class="num">${r.rows[0].duplicates}</td><td class="num">${r.rows[0].last_seq}</td>`
    : `<td>${esc(b.label)}</td><td colspan="3">${esc(r.error)}</td>`;
  body.append(tr);
  $('#stored').textContent = (await admin(`select count(*)::int as n from app.sensor_readings where device_id = $1`, [ids.stormDevice]))[0].n;
  await renderPhone();
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------
async function renderOutbox() {
  const rows = await admin(`select id, topic, payload, delivered_at, attempts from app.outbox order by id`);
  const body = $('#outbox-body');
  if (!rows.length) return;
  body.innerHTML = rows.map((r) => `<tr><td class="num">${r.id}</td><td>${esc(r.topic)}</td><td><code>${esc(JSON.stringify(r.payload))}</code></td><td>${r.delivered_at ? 'Delivered' : 'Waiting for the dispatcher (idempotency key outbox-' + r.id + ')'}</td></tr>`).join('');
}

// ---------------------------------------------------------------------------
// The same rules, seen as the app
// ---------------------------------------------------------------------------
let phoneUser = 'anna';
const ROLE_LABEL = { owner: 'Owner', trainer: 'Trainer', caretaker: 'Caretaker' };

async function can(person, actionKey, horse) {
  const a = ACTIONS.find((x) => x.key === actionKey);
  const r = await call(person, a.sql(), a.args(horse), { rollback: true });
  if (r.ok) return { ok: true };
  const why = r.error.replace(/^forbidden: /, '');
  return { ok: false, why: why.charAt(0).toUpperCase() + why.slice(1) };
}

async function renderPhone() {
  const screen = $('#phone-screen');
  if (!screen) return;
  document.querySelectorAll('[data-phone]').forEach((b) => b.classList.toggle('current', b.dataset.phone === phoneUser));
  const person = phoneUser;
  const horses = await call(person, `select id, name, my_role, stable_id from api_v1.horses order by name`);
  if (!horses.ok) {
    screen.innerHTML = `<div class="app-top"><span class="app-title">My horses</span></div>
      <div class="app-empty"><p>Sign in to see your horses.</p><p class="small">Without an account you can still scan a product's QR code and read its public passport.</p><button type="button" class="app-btn primary" disabled>Sign in</button></div>`;
    return;
  }
  const cards = [];
  for (const h of horses.rows) {
    const horse = { id: h.id, name: h.name, device: h.id === ids.storm ? ids.stormDevice : ids.lunaDevice };
    const logs = await call(person, `select logged_on, minutes, notes from api_v1.training_logs where horse_id = $1 order by logged_on desc, created_at desc limit 2`, [h.id]);
    const last = await call(person, `select r.temperature, r.humidity from api_v1.sensor_readings r join api_v1.sensor_devices d on d.id = r.device_id where d.horse_id = $1 order by r.measured_at desc limit 1`, [h.id]);
    const train = await can(person, 'train', horse);
    const upload = await can(person, 'upload', horse);
    const role = await can(person, 'role', horse);
    const roleText = h.my_role ? ROLE_LABEL[h.my_role] : 'Stable manager';
    const env = last.ok && last.rows[0] ? `${Number(last.rows[0].temperature)} °C, ${Number(last.rows[0].humidity)}% humidity` : 'No readings yet';
    const btn = (label, c) => `<button type="button" class="app-btn" ${c.ok ? '' : 'disabled'}>${esc(label)}</button>${c.ok ? '' : `<span class="why">${esc(c.why)}</span>`}`;
    cards.push(`<article class="horse-card">
      <header><h4>${esc(h.name)}</h4><span class="badge badge-${esc(h.my_role ?? 'manager')}">${esc(roleText)}</span></header>
      <p class="env">Stall sensor: ${esc(env)}</p>
      <ul class="logs">${logs.ok && logs.rows.length ? logs.rows.map((l) => `<li><span>${esc(l.notes)}</span><span>${l.minutes} min</span></li>`).join('') : '<li><span>No training logged</span></li>'}</ul>
      <div class="app-actions">${btn('Log training', train)}${btn('Add photo', upload)}${btn('Invite someone', role)}</div>
    </article>`);
  }
  const products = await call(person, `select model from api_v1.my_products order by model`);
  screen.innerHTML = `<div class="app-top"><span class="app-title">My horses</span><span class="app-user">${esc(NAMES[person])}</span></div>
    ${cards.length ? cards.join('') : '<div class="app-empty"><p>No horses yet.</p><p class="small">An owner can invite you as trainer or caretaker.</p></div>'}
    <div class="app-section"><h5>My products</h5>${products.ok && products.rows.length ? products.rows.map((p) => `<p>${esc(p.model)}</p>`).join('') : '<p class="small">Scan a QR code to register equipment.</p>'}</div>
    <div class="app-tabbar" aria-hidden="true"><span class="on">Horses</span><span>Scan</span><span>Stable</span><span>Profile</span></div>`;
}

// ---------------------------------------------------------------------------
async function main() {
  const status = $('#status');
  try {
    await boot();
    const { count, ms } = await buildGrid();
    status.classList.add('ready');
    status.lastChild.textContent = `PostgreSQL is running in this tab. 6 migrations applied, ${count} permission checks in ${(ms / 1000).toFixed(1)} s.`;
    drawQr();
    await renderPhone();
  } catch (e) {
    status.classList.add('failed');
    status.lastChild.textContent = `Could not start the database in this browser: ${e.message}`;
    console.error(e);
    return;
  }
  $('#grid-body').addEventListener('click', (e) => { const b = e.target.closest('.cell'); if (b) showDetail(b.dataset.id); });
  document.querySelectorAll('[data-scan]').forEach((b) => b.addEventListener('click', () => scan(b.dataset.scan)));
  document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => qrAction(b.dataset.act)));
  document.querySelectorAll('[data-batch]').forEach((b) => b.addEventListener('click', () => upload(b.dataset.batch)));
  document.querySelectorAll('[data-phone]').forEach((b) => b.addEventListener('click', async () => { phoneUser = b.dataset.phone; await renderPhone(); }));
}
main();
