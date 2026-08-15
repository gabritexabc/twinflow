// TwinFlow server — static files + email API. Run: node serve.mjs [port]
//
// Email sending requires smtp-config.json next to this file
// (copy smtp-config.example.json and fill in your SMTP credentials).
import { createServer } from 'node:http';
import { readFile, writeFile, unlink, mkdir, rename, rm, readdir, copyFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
// db.mjs (and its sql.js dependency) is imported dynamically inside the guarded
// boot block below, so even a module-resolution failure lands in boot-error.txt
let openDb, loadAppState, loadUsersDb, migrateFromJson, persistAppState, persistUsersDb, scheduleBackups, dataDir;
import { scryptSync, randomBytes, randomUUID, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
// no top-level await inside it — safe to import statically under Passenger's require()
import { initTrainingLog, logEvent, listLogFiles, trainingDir } from './train-log.mjs';
// likewise await-free: reads an .xlsx with nothing but node:zlib, because the
// production host cannot install a spreadsheet library
import { readWorkbook, planStockImport, mergeName, componentKey, mapType, TYPES } from './xlsx-stock.mjs';
import { buildSecurity, communicate as atCommunicate, UNKNOWN_NIF } from './at.mjs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT) || Number(process.argv[2]) || 8123; // cloud hosts set PORT
// when deployed under a sub-path (e.g. a cPanel/Passenger app mounted at /twinflow)
// the reverse proxy may forward the request url with that prefix still attached
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');
// SMTP credentials. TWINFLOW_SMTP_CONFIG points at a file outside the web root —
// same reasoning as the database (see db.mjs): under the app folder, an .htaccess
// rule is the only thing standing between this file and anyone who asks for it.
// Unlike the data directory this one is NOT auto-adopted: copying a secret to a
// new place and leaving the original behind is the wrong default, so the operator
// moves it deliberately. Unset, the file next to the app is used, as before.
const LEGACY_CONFIG_PATH = join(root, 'smtp-config.json');
const CONFIG_PATH = process.env.TWINFLOW_SMTP_CONFIG || LEGACY_CONFIG_PATH;
// uploaded IFC files, one per project. TWINFLOW_MODELS_DIR moves them off the web
// root, like TWINFLOW_DATA_DIR does for the database (see db.mjs). Unset, nothing
// changes. Client models are not secrets like the database is, but a project's IFC
// is still the client's drawing set — it should not be fetchable by URL guessing.
const LEGACY_MODELS_DIR = join(root, 'models');
const MODELS_DIR = process.env.TWINFLOW_MODELS_DIR || LEGACY_MODELS_DIR;
const MAX_IFC_BYTES = 300 * 1024 * 1024;

// "which code is actually live?" — the question every deploy raises. The package
// version alone never answers it (it does not move between deploys), so it is paired
// with a build id: a short hash of the size and timestamp of the files that ARE the
// app. Any change to any of them produces a different id, and two servers showing
// the same id are provably running the same files — which a date could not tell you,
// since two deploys in the same minute would look identical.
// Computed per request, not at boot: the client files are replaced without a restart,
// so a boot-time value would keep claiming the old build after a JS-only deploy.
const APP_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || '0'; }
  catch { return '0'; }
})();
const BUILD_FILES = ['package.json', 'serve.mjs', 'db.mjs', 'index.html', 'js/app.js', 'js/store.js', 'js/i18n.js', 'css/styles.css'];
function buildId() {
  const h = createHash('sha1');
  let seen = 0;
  for (const f of BUILD_FILES) {
    try {
      const s = statSync(join(root, f));
      h.update(`${f}:${s.size}:${Math.floor(s.mtimeMs)}`);
      seen++;
    } catch { h.update(`${f}:missing`); } // absence is part of the identity too
  }
  return seen ? h.digest('hex').slice(0, 6) : null;
}
const IFC_VERSIONS_KEEP = 5; // archived copies kept per project when a model is replaced

// move the current model aside instead of overwriting it, pruning old archives
async function archiveIfcVersion(id, file) {
  if (!existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await rename(file, join(MODELS_DIR, `${id}.v${stamp}.ifc`));
  const archives = (await readdir(MODELS_DIR)).filter(f => f.startsWith(id + '.v') && f.endsWith('.ifc')).sort();
  for (const f of archives.slice(0, Math.max(0, archives.length - IFC_VERSIONS_KEEP))) {
    try { await unlink(join(MODELS_DIR, f)); } catch { /* best effort */ }
  }
}

async function listIfcVersions(id) {
  try {
    return (await readdir(MODELS_DIR))
      .filter(f => f.startsWith(id + '.v') && f.endsWith('.ifc'))
      .sort().reverse()
      .map(f => f.slice(id.length + 2, -4)); // just the timestamp portion
  } catch { return []; }
}

// ---------- shared application state (server is the source of truth) ----------

const defaultAppState = () => ({
  rev: 0,
  seq: 1,
  projects: [],
  orders: [],
  parties: [
    { id: 'p-gc',   name: 'Site Preparation',          type: 'admin',     email: '', phone: '' },
    { id: 'p-fab',  name: 'Factory (off-site)',        type: 'factory',   email: '', phone: '' },
    { id: 'p-log',  name: 'Logistics Operator',        type: 'logistics', email: '', phone: '' },
    { id: 'p-site', name: 'Site Assembly Team',        type: 'site',      email: '', phone: '' },
  ],
  components: [], // component catalog + stock balances (warehouse/factory/consumed)
  stockMoves: [], // append-only stock ledger (in / send / consume / adjust / reverse)
  procurement: [], // purchase orders on suppliers: awarded → invoiced → delivered
});

// SQLite (data/twinflow.db) is the source of truth; a first boot on an older
// installation migrates the legacy JSON files automatically (kept as *.migrated).
// IMPORTANT: no top-level await in this module — cPanel/Passenger loads the app
// with require(), which Node accepts for ES modules ONLY when they are fully
// synchronous (ERR_REQUIRE_ASYNC_MODULE otherwise). The async boot happens in
// bootAndServe() at the bottom of the file.
let appState = defaultAppState(); // placeholders until the DB finishes loading
let usersDb = { users: [], sessions: {} };
let dbReady = false; // API requests are held (503) until the SQLite load completes

async function bootDatabase() {
  ({ openDb, loadAppState, loadUsersDb, migrateFromJson, persistAppState, persistUsersDb, scheduleBackups, dataDir } = await import('./db.mjs'));
  await openDb();
  let loadedState = loadAppState(defaultAppState());
  let loadedUsers = loadUsersDb();
  if (loadedState === null || loadedUsers === null) {
    const m = migrateFromJson(defaultAppState(), { state: loadedState === null, users: loadedUsers === null });
    if (loadedState === null) loadedState = m.appState ?? defaultAppState();
    if (loadedUsers === null) loadedUsers = m.usersDb; // may stay null → seeded below
  }
  appState = loadedState;
  usersDb = loadedUsers || { users: [], sessions: {} };
  if (!usersDb.users.length) {
    const { salt, hash } = hashPassword('admin');
    usersDb.users.push({
      id: 'u-admin', username: 'admin', name: 'Administrator', role: 'admin', projectIds: [], lang: 'en',
      salt, hash, mustChangePassword: true, createdAt: new Date().toISOString(),
    });
    saveUsers();
    console.log('[auth] first run — default account: admin / admin (change the password after login)');
  }
  waivePreExistingShopDrawings();
  splitPartyContacts();
  scopeExistingProjectDirectors();
  mergeComponentDescriptions();
  mapComponentTypes();
  migrateProcurementLines();
  // give every stored request a starting version, so the concurrency check below is
  // strict from the first load — without this, orders written before versioning
  // existed would keep falling back to the lenient heuristic and could lose writes
  let versioned = 0;
  for (const o of appState.orders) if (o.orderRev === undefined) { o.orderRev = 0; versioned++; }
  if (versioned) { bumpState(); console.log(`[migrate] ${versioned} request(s) given an initial version`); }
  scheduleBackups(); // daily copy into <data dir>/backups/, keeps the last 14
  scheduleDigests(); // one per-person summary a day, stock shortages included
  // defaults inside the data directory, which is already outside the web root
  const trainDir = process.env.TWINFLOW_TRAINING_DIR || join(dataDir(), 'training');
  initTrainingLog(trainDir);
  console.log(`[boot] training log: ${trainDir}`);
  adoptLegacyModels().catch(e => console.error('[models] adoption failed:', e.message));
  console.log(`[boot] data: ${dataDir()}${dataDir().startsWith(root) ? ' (inside the web root — see TWINFLOW_DATA_DIR)' : ' (outside the web root)'}`);
  console.log(`[boot] models: ${MODELS_DIR}${MODELS_DIR.startsWith(root) ? ' (inside the web root — see TWINFLOW_MODELS_DIR)' : ' (outside the web root)'}`);
}

// Same reasoning as the database: pointing TWINFLOW_MODELS_DIR at an empty folder
// would silently lose every stored IFC, so the first boot at a new location copies
// what is already there. Copies, never moves — the originals stay until deleted by
// hand. Runs after the server is listening, so a large model set cannot delay boot.
async function adoptLegacyModels() {
  if (MODELS_DIR === LEGACY_MODELS_DIR || !existsSync(LEGACY_MODELS_DIR)) return;
  await mkdir(MODELS_DIR, { recursive: true });
  const already = new Set(await readdir(MODELS_DIR).catch(() => []));
  let n = 0;
  for (const f of await readdir(LEGACY_MODELS_DIR)) {
    if (already.has(f) || !f.endsWith('.ifc')) continue;
    await copyFile(join(LEGACY_MODELS_DIR, f), join(MODELS_DIR, f));
    n++;
  }
  if (n) console.log(`[models] adopted ${n} file(s) from ${LEGACY_MODELS_DIR} — the originals were COPIED, delete them by hand once proven`);
}

// The shop-drawings gate is new: without this, every request already past Submitted
// when this version first boots would be stuck, since none of them carry the field.
// Those are waived once — recorded as such, never silently marked "validated" — and
// the flag makes it a one-time act, so a later restart cannot waive a request that
// is legitimately waiting for its drawings.
function waivePreExistingShopDrawings() {
  if (appState.sdWaivedAt) return;
  const past = new Set(['accepted', 'production', 'ready', 'transit', 'delivered', 'installed']);
  let n = 0;
  for (const o of appState.orders) {
    if (past.has(o.status) && !o.shopDrawings) {
      o.shopDrawings = { status: 'waived', waivedAt: new Date().toISOString() };
      n++;
    }
  }
  appState.sdWaivedAt = new Date().toISOString();
  bumpState();
  if (n) console.log(`[migrate] ${n} pre-existing request(s) waived from the shop-drawings gate`);
}

// A supplier's contact used to be one free-text field ("email · phone"), which meant
// the address had to be guessed with a regex every time an order was emailed. It is now
// two fields; this splits the stored values once, keeping whatever is not an address as
// the phone so nothing entered by hand is lost.
const EMAIL_RE = /^[^\s,;·<>()[\]@]+@[^\s,;·<>()[\]@]+\.[a-z]{2,}$/i;
function splitPartyContacts() {
  let n = 0;
  for (const p of appState.parties) {
    if (p.contact === undefined) continue;
    const parts = String(p.contact).split(/[·,;|]+/).map(s => s.trim()).filter(Boolean);
    p.email = parts.find(s => EMAIL_RE.test(s)) || '';
    p.phone = parts.filter(s => !EMAIL_RE.test(s)).join(' ');
    delete p.contact;
    n++;
  }
  if (n) { bumpState(); console.log(`[migrate] ${n} supplier contact(s) split into email + phone`); }
}

// project_director became a project-scoped role. Accounts created before that have
// no project list, and the scoping rule is literal — an empty list means NO projects,
// which would silently blank the screen for every existing director on the first boot
// after the upgrade. So they inherit every project that exists today; the
// administrator narrows them afterwards. One-time, flagged, never re-run: a director
// deliberately narrowed later must not be widened again by a restart.
function scopeExistingProjectDirectors() {
  if (appState.pdScopedAt) return;
  const all = appState.projects.map(p => p.id);
  let n = 0;
  for (const u of usersDb.users) {
    if (u.role === 'project_director' && !(u.projectIds || []).length) { u.projectIds = [...all]; n++; }
  }
  appState.pdScopedAt = new Date().toISOString();
  bumpState();
  if (n) { saveUsers(); console.log(`[migrate] ${n} project director(s) given access to all ${all.length} existing project(s)`); }
}

// ---------- transport document numbering ----------
//
// The AT's DocumentNumber has to follow the SAF-T (PT) shape: internal document code, a
// space, the series identifier, a slash, and a sequential number inside that series —
// "GT 2026/7". Two properties matter and they pull in opposite directions: no gaps, and
// no reuse.
//
// No gaps is why a number is NOT assigned when a shipment is recorded. Most stock leaves
// this warehouse without ever becoming a communicated document; numbering every send
// would burn numbers and leave holes in the series. The counter advances only when a
// document is actually issued.
//
// No reuse is why the counters are treated like the migration markers on a full-state
// import: an imported export carries ITS counters, and taking them verbatim would hand
// out a number twice. They are merged by taking the higher of the two.
const DOC_TYPES = {
  GR: 'Guia de remessa',
  GT: 'Guia de transporte',
  GA: 'Guia de movimentação de ativos próprios',
  GC: 'Guia de consignação',
  GD: 'Guia ou nota de devolução',
};
const docSeries = () => String(appState.docSeries?.series || new Date().getFullYear());
const docCounters = () => appState.docSeries?.counters || {};
const docPeek = (type) => (Number(docCounters()[`${type}|${docSeries()}`]) || 0) + 1;

// Consumes a number. Only ever called when a document is really being issued.
function nextDocumentNumber(type) {
  if (!DOC_TYPES[type]) throw new Error('Unknown transport document type');
  const series = docSeries();
  const key = `${type}|${series}`;
  const seq = (Number(docCounters()[key]) || 0) + 1;
  appState.docSeries = { series, counters: { ...docCounters(), [key]: seq } };
  bumpState();
  return { documentNumber: `${type} ${series}/${seq}`, type, series, seq };
}

// A purchase order's STATUS IS DERIVED, never taken from the client and never written
// by hand. A stored status plus a set of lines are two records of one fact, and two
// records of one fact drift: the header would read "entregue" while a line still owed
// 40 units. The lines are the truth and this reads them.
//
//   awarded   — nothing received yet
//   invoiced  — the invoice arrived (an order-level fact, not a line one)
//   partial   — some received, some still owed. This state did not exist before, and
//               its absence is what made the feature unusable: a supplier delivering
//               3 of 5 references had nowhere to be recorded.
//   delivered — every line received in full
const poStatus = (po) => {
  const lines = po.lines || [];
  if (lines.length && lines.every(l => (l.qtyReceived || 0) >= l.qty)) return 'delivered';
  if (lines.some(l => (l.qtyReceived || 0) > 0)) return 'partial';
  return po.invoicedAt ? 'invoiced' : 'awarded';
};
const poOutstanding = (line) => Math.max(0, (Number(line.qty) || 0) - (Number(line.qtyReceived) || 0));

// A purchase order used to hold ONE component (`componentId` + `qty`). An order with a
// single line is exactly what that meant, so this is a rename, not a decision.
//
// Deliberately NOT guarded by a meta marker, unlike its neighbours: it converts only
// orders that still carry the old field and have no lines, which makes re-running it a
// no-op. Markers are dropped by a full-state import (a known defect in PUT /api/state),
// and a migration that is safe to re-run does not care whether the marker survived.
function migrateProcurementLines() {
  let n = 0;
  for (const po of appState.procurement || []) {
    if (Array.isArray(po.lines)) continue;
    const wasDelivered = po.status === 'delivered';
    po.lines = [{
      id: 'pol-' + randomUUID().slice(0, 8),
      componentId: po.componentId,
      qty: Number(po.qty) || 0,
      // a delivered order already moved its stock — the line has to say so, or this
      // migration would offer to receive goods that are on the shelf already
      qtyReceived: wasDelivered ? (Number(po.qty) || 0) : 0,
      receivedAt: wasDelivered ? (po.deliveredAt || null) : null,
      receivedBy: wasDelivered ? (po.by || null) : null,
      note: '',
    }];
    delete po.componentId; // the line is the truth now; a stale copy is a future bug
    delete po.qty;
    po.status = poStatus(po);
    n++;
  }
  if (n) console.log(`[migrate] ${n} purchase order(s) converted to line form`);
}

// One-time (1.16.0): the component's two description columns became a single name.
// Two things make this a migration rather than a display change. The stored
// `description` would otherwise linger where nothing shows it, and — the part that
// bites — a component's import identity was built from BOTH texts. Leave the stored
// keys alone and the next import of the same sheet recognises nothing it created,
// so it duplicates the entire warehouse instead of updating it.
function mergeComponentDescriptions() {
  if (appState.descMergedAt) return;
  let renamed = 0;
  for (const c of appState.components) {
    const merged = mergeName(c.name, c.description);
    if (merged !== c.name) renamed++;
    c.name = merged;
    delete c.description;
    if (c.importKey) c.importKey = componentKey(c);
  }
  appState.descMergedAt = new Date().toISOString();
  bumpState();
  if (renamed) console.log(`[migrate] ${renamed} component name(s) absorbed their description`);
}

// One-time (1.19.0): the free-text TIPO became a closed list of three — material,
// equipment, consumable. The sixteen families the warehouse had written (FIXAÇÃO,
// CALÇOS, SELANTE…) are mapped through the same table the importer uses, so a row
// arriving in a future spreadsheet lands in the same place as the row already here.
//
// Anything the table does not recognise is left EMPTY rather than guessed. An unset
// field asks to be answered; a wrongly-set one is a lie that nobody goes looking for.
function mapComponentTypes() {
  if (appState.typesMappedAt) return;
  let mapped = 0, cleared = 0;
  for (const c of appState.components) {
    if (!c.type) continue;
    const next = mapType(c.type);
    if (next) mapped++; else cleared++;
    c.type = next;
  }
  appState.typesMappedAt = new Date().toISOString();
  bumpState();
  if (mapped || cleared) console.log(`[migrate] ${mapped} component type(s) classified, ${cleared} left for review`);
}

// Where stock can go when it leaves the warehouse. It was factories only, because the
// warehouse existed to feed off-site production; a site also receives material and holds
// it until it is fixed, so it is a destination too.
//
// NOTE for anyone extending this: the balance still lives in `component.factoryQty`,
// keyed by party id. The name is now narrower than the thing it holds — renaming it means
// migrating every component, and the risk outweighs the tidiness today. Do NOT read the
// name as a constraint: read this function.
const stockDestination = (id) => appState.parties.find(p => p.id === id && ['factory', 'site'].includes(p.type)) || null;

// ---------- roles & project-level access ----------
// admin manages accounts/access; project_director sees every project; site_director
// and foreman are restricted to the projects assigned to them (user.projectIds).
// quality: GC-side auditor — sees every project/order, records inspections and
// non-conformities anywhere (including at the factory), but never moves the
// workflow and never manages projects/models/users
// The only five a party can be. Anything else is refused rather than stored: the type
// is printed in the Partners table, and free text there was stored XSS.
const PARTY_TYPES = ['supplier', 'factory', 'logistics', 'site', 'admin'];
const VALID_ROLES = ['admin', 'project_director', 'site_director', 'foreman', 'quality', 'factory', 'logistics', 'site'];
const GC_ROLES = ['admin', 'project_director', 'site_director', 'foreman'];
// José, 2026-08-05: the encarregado is a leadership post and gets the same powers as a
// project director — asked for explicitly, including the two validation gates. Recorded
// here because it collapses a separation of duties: the foreman marks a non-conformity
// repaired AND can now sign it off. He was told once and decided; it is his call to make.
const FULL_ACCESS_ROLES = ['admin', 'project_director', 'foreman'];
// only these decide WHAT to order; foreman runs the on-site logistics tail instead
const CREATOR_ROLES = ['admin', 'project_director', 'site_director', 'foreman'];
// roles limited to their explicitly assigned projects (user.projectIds): the scoped
// GC roles plus the off-site factory and the on-site assembly team. quality (audit)
// and logistics stay unscoped — they work across every project.
// project_director is scoped too: a firm can run several sites with a director per
// site, so the administrator assigns which projects each one covers. The
// administrator alone stays unscoped and always sees everything.
const PROJECT_SCOPED_ROLES = ['project_director', 'site_director', 'foreman', 'factory', 'site'];
const isGcRole = (role) => GC_ROLES.includes(role);
// the administrator overrides the process gates (shop drawings, JIT slot, one load at
// a time, deletion after start). Those gates describe physical reality rather than
// permissions, so they hold for every other role — including the project director.
const isAdmin = (role) => role === 'admin';
const hasFullAccess = (role) => FULL_ACCESS_ROLES.includes(role);
const isProjectScoped = (role) => PROJECT_SCOPED_ROLES.includes(role);

// who may move an order OUT of a given status — mirrors js/store.js STATUSES.*.actor
const STATUS_ACTORS = {
  draft: CREATOR_ROLES,
  submitted: ['factory'],
  rejected: CREATOR_ROLES,
  accepted: ['factory'],
  production: ['factory'],
  ready: ['logistics', 'foreman', 'site_director'], // the factory's job ends at Ready — dispatch is the GC side's call
  transit: ['logistics', 'foreman'],
  delivered: ['site', 'foreman'],
  installed: [],
};
// the assembly team only needs to see what's already moving/arrived/done
const SITE_VISIBLE_STATUSES = new Set(['transit', 'delivered', 'installed']);
// ---------- component stock ----------
const UNITS = ['un', 'kg', 'm', 'm2', 'm3', 'L'];
// factory-floor marks: deduct a factory balance WITHOUT a recipe. 'use' is manual
// consumption (counts toward consumedQty, like the automatic 'consume'); 'defect'
// and 'loss' are scrap/shrinkage. The factory role may record and reverse these.
const FACTORY_MARK_TYPES = ['use', 'defect', 'loss'];
// who may sign off a repaired non-conformity — site management, never the repairer
const NC_VALIDATOR_ROLES = ['admin', 'project_director', 'site_director', 'foreman'];
// who may validate shop drawings for fabrication — the Project Director's call
const SD_VALIDATOR_ROLES = ['admin', 'project_director', 'foreman'];
// states that clear the gate: validated now, or waived because the request predates it
const SD_CLEARED = new Set(['validated', 'waived']);
// a request may only be deleted while it never materially started
const DELETABLE_STATUSES = new Set(['draft', 'submitted', 'rejected']);
// every status the workflow knows — a PUT/POST may not invent one
const VALID_STATUSES = new Set(Object.keys(STATUS_ACTORS));
// what a client may never restate on an existing request: who it belongs to and
// when it began. Everything else is legitimately edited through the flow.
const IMMUTABLE_ORDER_FIELDS = ['id', 'code', 'projectId', 'createdAt'];

// An inspection photo is a downscaled JPEG that the browser produced as a data:
// URL. Nothing else is a photo, and the value is written straight into an <img
// src> attribute — an arbitrary string there escapes the attribute and executes
// (the client escapes it too now; this stops the bad value being STORED at all,
// which is what makes every other reader of the record safe).
const DATA_IMAGE_RE = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/;
function sanitizeInspectionPhotos(order) {
  for (const i of order?.inspections || []) {
    if (i && i.photo != null && !DATA_IMAGE_RE.test(String(i.photo))) i.photo = null;
  }
}
// once an order reaches any of these, every element in it counts as produced
// (covers elements that were never individually as-built ticked / null GlobalIds)
const CONSUMED_STATUSES = new Set(['ready', 'transit', 'delivered', 'installed']);
function canAccessProject(user, projectId) {
  if (!user) return false;
  // scope is checked FIRST: a project director has full powers over the projects
  // assigned to them, but "full powers" is not the same as "every project"
  if (isProjectScoped(user.role)) return (user.projectIds || []).includes(projectId);
  if (hasFullAccess(user.role)) return true; // administrator
  return true; // quality (audit) and logistics work across every project
}

// Automatic component consumption — server-authoritative, runs on every order PUT.
// `cur` is the stored order (baseline), `o` the incoming replacement. Per item the
// "target" is how many of its elements count as produced: each as-built-ticked
// GlobalId, or the full quantity once the order reaches a CONSUMED_STATUS (which
// also covers null GlobalIds / never-ticked elements). Consumption is monotonic
// (never un-consumes) and delta-based, so identical replays and offline re-PUTs are
// idempotent. The project recipe (project.recipes[groupKey]) converts element units
// into component quantities, debited from the supplier factory's balance — negative
// balances are allowed (the elements were physically produced) and flagged in the UI.
// ---------- decision context for the training log ----------
// The snapshot of what was knowable when somebody acted. Without it the log says
// only what happened, which teaches a model nothing: "dispatched on the 26th" is
// noise unless you also know that 5 of 5 elements were built, the site had no other
// load inbound, and the JIT date was 4 days out.
//
// Deliberately NOT captured: the weather. It is derivable after the fact from the
// project coordinates and the date, both recorded here, and fetching it on the write
// path would put an external HTTP call between a user and their click.
//
// Everything here is O(orders + components) — a scan, not a nested loop, so it stays
// cheap as the history grows. Verified under the 100-project / 5000-order load test.
function decisionContext(order) {
  const now = Date.now();
  const project = appState.projects.find(p => p.id === order?.projectId) || null;
  const num = (v) => (Number.isFinite(v) ? Number(v.toFixed(3)) : null);

  const elements = (order?.items || []).reduce((s, i) => s + (Number(i.qty) || 0), 0);
  const built = (order?.items || []).reduce((s, i) =>
    s + (i.globalIds || []).filter(g => g && order.tracking?.[g]?.built).length, 0);
  const lastEvent = (order?.events || []).slice(-1)[0];
  const shipped = (order?.shipments || []).flatMap(s => s.items || [])
    .reduce((s, i) => s + (Number(i.qty) || 0), 0);

  // components this order actually consumes, via the project recipe for each item
  const stock = [];
  const recipes = project?.recipes || {};
  const seen = new Set();
  for (const it of order?.items || []) {
    for (const r of recipes[it.key] || []) {
      if (seen.has(r.componentId)) continue;
      seen.add(r.componentId);
      const c = appState.components.find(x => x.id === r.componentId);
      if (!c) continue;
      const factory = Number(c.factoryQty?.[order.supplierId]) || 0;
      stock.push({
        componentId: c.id, name: c.name || '', unit: c.unit || '',
        perElement: num(Number(r.qtyPer)) ?? null,
        warehouse: num(Number(c.warehouseQty) || 0), factory: num(factory),
        min: c.minQty == null ? null : num(Number(c.minQty)),
        needed: num((Number(r.qtyPer) || 0) * elements),
        shortfall: num(Math.max(0, (Number(r.qtyPer) || 0) * elements - factory)),
      });
    }
  }

  const byStatus = {};
  let dueIn14d = 0, late = 0, loadsInTransitProject = 0;
  const in14 = now + 14 * 864e5;
  for (const o of appState.orders) {
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    const due = o.needBy ? Date.parse(o.needBy) : NaN;
    if (Number.isFinite(due)) {
      if (due <= in14 && due >= now && !['delivered', 'installed'].includes(o.status)) dueIn14d++;
      if (due < now && !['delivered', 'installed'].includes(o.status)) late++;
    }
    if (o.projectId === order?.projectId && (o.shipments || []).some(s => s.status === 'transit')) {
      loadsInTransitProject++;
    }
  }

  const due = order?.needBy ? Date.parse(order.needBy) : NaN;
  return {
    order: order ? {
      status: order.status,
      items: (order.items || []).length,
      elements,
      built,
      builtRatio: elements ? num(built / elements) : null,
      shippedElements: shipped,
      remainingAtFactory: elements - shipped,
      volume: num((order.items || []).reduce((s, i) => s + (Number(i.volume) || 0), 0)),
      needBy: order.needBy || null,
      needByTime: order.needByTime || null,
      daysToJit: Number.isFinite(due) ? num((due - now) / 864e5) : null,
      hoursInStatus: lastEvent?.ts ? num((now - Date.parse(lastEvent.ts)) / 36e5) : null,
      shopDrawings: order.shopDrawings?.status || null,
      openNcs: (order.nonConformities || []).filter(nc => nc.status !== 'validated').length,
      inspections: (order.inspections || []).length,
      loads: (order.shipments || []).length,
    } : null,
    project: project ? {
      id: project.id,
      hasAddress: !!project.address,
      lat: project.lat ?? null, lon: project.lon ?? null, // weather joins on these + the date
      elements: project.summary?.elementCount ?? null,
    } : null,
    logistics: { loadsInTransitProject },
    stock,
    portfolio: { byStatus, dueIn14d, late, orders: appState.orders.length },
    time: { weekday: new Date(now).getUTCDay(), hour: new Date(now).getUTCHours() },
  };
}

const actorOf = (user) => ({ user: user?.username || null, role: user?.role || null });
const subjectOf = (o) => ({ kind: 'order', id: o?.id || null, code: o?.code || null, projectId: o?.projectId || null });

// Configuration acts are not operational decisions, but they change the ground the
// decisions are made on — a recipe edit moves every future stock calculation, and who
// holds which project explains who could have decided at all. Logged with a light
// context (no portfolio scan: these are rare and the portfolio is not what they act on).
// Never any credential material: for accounts, only who, which role, which projects.
function logConfig(event, subject, decision = {}, user) {
  logEvent(event, {
    actor: actorOf(user), subject, decision,
    context: { time: { weekday: new Date().getUTCDay(), hour: new Date().getUTCHours() } },
  });
}

// Purchase orders are the reordering decision itself: how much was bought, from whom,
// against what balance — and, on delivery, how long the supplier actually took.
// A purchase order now carries LINES, but the training log keeps its old shape: one
// entry per reference, with that reference's balance context at the moment of the act.
// Ten references bought together must not collapse into one record where there used to
// be ten — the dataset is the point, and a decision is about a reference, not a form.
function logProcurement(event, po, user, line = null) {
  const comp = appState.components.find(c => c.id === (line ? line.componentId : po.lines?.[0]?.componentId));
  const sup = appState.parties.find(p => p.id === po.supplierId);
  const shared = decisionContext(null);
  const days = (a, b) => (a && b ? Number(((Date.parse(b) - Date.parse(a)) / 864e5).toFixed(2)) : null);
  logEvent(event, {
    actor: actorOf(user),
    subject: { kind: 'procurement', id: po.id, lineId: line?.id || null, componentId: comp?.id || null, supplierId: po.supplierId },
    decision: {
      qty: line ? line.qty : null,
      qtyReceived: line ? (line.qtyReceived || 0) : null,
      lines: (po.lines || []).length,
      supplier: sup?.name || null, supplierType: sup?.type || null,
    },
    context: {
      component: comp ? {
        name: comp.name || '', unit: comp.unit || '',
        warehouse: comp.warehouseQty, min: comp.minQty ?? null,
        belowMin: comp.minQty != null && comp.warehouseQty < comp.minQty,
      } : null,
      lead: { awardedToInvoicedDays: days(po.awardedAt, po.invoicedAt), invoicedToDeliveredDays: days(po.invoicedAt, po.deliveredAt), awardedToDeliveredDays: days(po.awardedAt, po.deliveredAt) },
      portfolio: shared.portfolio,
      time: shared.time,
    },
  });
}

// Stock events carry the balances AFTER the move plus the minimum — that pairing is
// what a reordering model needs, and it is not recoverable from the ledger alone
// without replaying every movement.
function logStockMove(move, comp, user, extra = {}) {
  const shared = decisionContext(null);
  logEvent('stock.move', {
    actor: actorOf(user),
    subject: { kind: 'component', id: comp.id, name: comp.name || '', unit: comp.unit || '' },
    decision: { type: move.type, qty: move.qty, factoryId: move.factoryId || null, ...extra },
    context: {
      component: {
        warehouse: comp.warehouseQty, factory: comp.factoryQty || {},
        min: comp.minQty ?? null, consumed: comp.consumedQty || 0,
        belowMin: comp.minQty != null && comp.warehouseQty < comp.minQty,
      },
      portfolio: shared.portfolio,
      time: shared.time,
    },
  });
}

// One PUT can carry several distinct decisions (advance the status AND close a
// non-conformity). Each is logged as its own event so the dataset has one row per
// decision rather than one row per HTTP request.
function logOrderChange(before, after, user, context, overrides = []) {
  const base = { actor: actorOf(user), subject: subjectOf(after), context };
  const withOverrides = overrides.length ? { ...base, overrides } : base;
  const ncOpen = (l) => (l || []).filter(n => n.status !== 'validated').length;
  const ncAt = (l, s) => (l || []).filter(n => n.status === s).length;

  if (after.status !== before.status) {
    logEvent('order.status.changed', {
      ...withOverrides,
      change: { from: before.status, to: after.status },
      decision: {
        // the fields a model would predict, named for what they are
        jitDate: after.needBy || null, jitTime: after.needByTime || null,
        supplierId: after.supplierId || null,
      },
    });
    // outcome rows: the label that makes the earlier decisions learnable
    if (after.status === 'delivered' || after.status === 'installed') {
      const due = after.needBy ? Date.parse(after.needBy) : NaN;
      const t = (a) => (a ? Date.parse(a) : NaN);
      const created = t(after.createdAt);
      logEvent('outcome.' + after.status, {
        ...base,
        outcome: {
          onTime: Number.isFinite(due) ? Date.now() <= due + 864e5 : null, // same-day counts
          daysEarlyOrLate: Number.isFinite(due) ? Number(((Date.now() - due) / 864e5).toFixed(2)) : null,
          leadTimeDays: Number.isFinite(created) ? Number(((Date.now() - created) / 864e5).toFixed(2)) : null,
          ncsRaised: (after.nonConformities || []).length,
          ncsStillOpen: ncOpen(after.nonConformities),
          loads: (after.shipments || []).length,
          inspections: (after.inspections || []).length,
        },
      });
    }
  }
  if ((after.shipments?.length || 0) > (before.shipments?.length || 0)) {
    const load = (after.shipments || []).slice(-1)[0];
    logEvent('order.load.dispatched', {
      ...withOverrides,
      decision: {
        loadNumber: load?.num ?? null,
        elements: (load?.items || []).reduce((s, i) => s + (Number(i.qty) || 0), 0),
        partial: (context?.order?.remainingAtFactory ?? 0) > 0,
      },
    });
  }
  if ((after.nonConformities?.length || 0) > (before.nonConformities?.length || 0)) {
    logEvent('order.nc.raised', { ...base, decision: { total: (after.nonConformities || []).length } });
  }
  if (ncAt(after.nonConformities, 'repaired') > ncAt(before.nonConformities, 'repaired')) {
    logEvent('order.nc.repaired', { ...base });
  }
  if (ncAt(after.nonConformities, 'validated') > ncAt(before.nonConformities, 'validated')) {
    logEvent('order.nc.validated', { ...base });
  }
  if (after.shopDrawings?.status !== before.shopDrawings?.status) {
    logEvent('order.shopdrawings.' + (after.shopDrawings?.status || 'cleared'), {
      ...base, change: { from: before.shopDrawings?.status || null, to: after.shopDrawings?.status || null },
      decision: { ref: after.shopDrawings?.ref || null },
    });
  }
  if ((after.inspections?.length || 0) > (before.inspections?.length || 0)) {
    const insp = (after.inspections || []).slice(-1)[0];
    logEvent('order.inspection.recorded', {
      ...base, decision: { gate: insp?.gate || null, passed: insp?.passed ?? null },
    });
  }
}

function applyStockConsumption(cur, o, user) {
  const project = appState.projects.find(p => p.id === cur.projectId);
  const recipes = project?.recipes || {};
  // pre-feature orders already past 'ready' must not mass-consume when merely touched
  const grandfathered = cur.stockConsumed === undefined && CONSUMED_STATUSES.has(cur.status);
  const facId = o.supplierId || cur.supplierId || null;
  const consumed = {};
  for (const it of o.items || []) {
    const target = CONSUMED_STATUSES.has(o.status)
      ? Number(it.qty) || 0
      : (it.globalIds || []).filter(g => g && o.tracking?.[g]?.built).length;
    const prev = grandfathered ? target : Number(cur.stockConsumed?.[it.key]) || 0;
    const next = Math.max(prev, target);
    const delta = next - prev;
    if (delta > 0) {
      for (const r of recipes[it.key] || []) {
        const comp = appState.components.find(c => c.id === r.componentId);
        const qtyPer = Number(r.qtyPer);
        if (!comp || !(qtyPer > 0)) continue; // unknown component / bad recipe row → skip
        const q = delta * qtyPer;
        if (facId) comp.factoryQty[facId] = (comp.factoryQty[facId] || 0) - q;
        comp.consumedQty += q;
        appState.stockMoves.push({
          id: 'mv-' + randomUUID().slice(0, 8), ts: new Date().toISOString(),
          componentId: comp.id, type: 'consume', qty: q, factoryId: facId,
          orderId: o.id, orderCode: cur.code || o.code || null, projectId: o.projectId || null,
          by: user.username, note: it.name || '',
        });
      }
    }
    consumed[it.key] = next; // recorded for EVERY item, recipe or not — a recipe
  }                          // added mid-production only applies to later builds
  o.stockConsumed = consumed; // server value always wins over what the client sent
}


// ---------- daily digest, one per person, scoped to what they can act on ----------
//
// The alternative was one more themed alert per topic, and that is how automation dies:
// five senders competing for the same inbox until somebody writes a filter. This is one
// mail a day per account, listing only what is waiting for THAT person, and it does not
// send at all when their list is empty.
//
// Everything here is already computed elsewhere in the app — the dashboard draws it, the
// kanban chips it, decisionContext() counts it. The only thing that was missing was
// telling anyone.

const LISBON = 'Europe/Lisbon';
// The server's own clock is not the site's. Asking Intl for the wall time in Lisbon keeps
// "once a day, in the morning" true through DST without any date arithmetic here.
function lisbonNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: LISBON, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}
// Not before this hour, local time. TWINFLOW_DIGEST_HOUR moves it without touching code —
// the right hour is whatever gets the mail read before the site meeting, which is not a
// decision this file should be making on its own.
const DIGEST_HOUR = (() => {
  const h = Number(process.env.TWINFLOW_DIGEST_HOUR);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 7;
})();

const overdue = (o) => o.needBy && !['delivered', 'installed'].includes(o.status)
  && o.needBy < lisbonNow().date;
// Only references with a minimum SET for that factory count. Factory balances are allowed
// to go negative by design — automatic consumption debits them because the elements really
// were produced — so "negative" is not a shortage on its own.
function factoryShortages() {
  const out = [];
  // an archived reference is one nobody is meant to act on any more, so it must
  // stop generating alerts — otherwise archiving fails at the one thing it is for
  for (const c of appState.components.filter(x => !x.archivedAt)) {
    for (const f of appState.parties.filter(p => p.type === 'factory')) {
      const min = c.factoryMinQty?.[f.id];
      if (min == null) continue;
      const qty = Number(c.factoryQty?.[f.id]) || 0;
      if (qty < min) out.push({ c, f, qty, min });
    }
  }
  return out;
}
const inTransit = (o) => (o.shipments || []).some(s => s.status === 'transit');
const ncRepaired = (o) => (o.nonConformities || []).filter(nc => nc.status === 'repaired').length;
const ncOpen = (o) => (o.nonConformities || []).filter(nc => !nc.status || nc.status === 'open').length;

// The sections a given account should see. Each one names an act that person can perform:
// a line nobody in that role can resolve is noise, however true it is.
function digestSections(user) {
  const mine = appState.orders.filter(o => canAccessProject(user, o.projectId));
  const code = (o) => `${o.code}${o.needBy ? ' (JIT ' + o.needBy + ')' : ''}`;
  const out = [];
  const add = (title, items) => { if (items.length) out.push({ title, items }); };
  const role = user.role;

  if (CREATOR_ROLES.includes(role)) {
    add('Pedidos em atraso', mine.filter(overdue).map(o => `${code(o)} — ${statusOf(o)}`));
    add('Cargas por confirmar (bloqueiam o próximo despacho)',
      mine.filter(inTransit).map(o => `${code(o)} — carga em trânsito`));
    // Stock is not project-scoped — the catalog and the balances are global infrastructure,
    // so these lines are the same for every director regardless of which sites they hold.
    add('Stock abaixo do mínimo em armazém',
      appState.components
        .filter(c => !c.archivedAt && c.minQty != null && c.warehouseQty < c.minQty)
        .map(c => `${c.name}${c.ref ? ' (' + c.ref + ')' : ''}: ${c.warehouseQty} ${c.unit} (mínimo ${c.minQty})`));
    add('Stock abaixo do mínimo em fábrica', factoryShortages().map(l =>
      `${l.c.name}${l.c.ref ? ' (' + l.c.ref + ')' : ''} — ${l.f.name}: ${l.qty} ${l.c.unit} (mínimo ${l.min})`));
  }
  if (SD_VALIDATOR_ROLES.includes(role)) {
    add('Desenhos de fabrico à espera da tua validação',
      mine.filter(o => o.status === 'accepted' && o.shopDrawings?.status === 'submitted')
        .map(o => `${code(o)} — produção parada até validares`));
  }
  if (NC_VALIDATOR_ROLES.includes(role)) {
    add('Não conformidades reparadas à espera de validação',
      mine.filter(o => ncRepaired(o)).map(o => `${code(o)} — ${ncRepaired(o)} reparada(s)`));
  }
  if (role === 'factory') {
    add('Pedidos à espera de aceitação', mine.filter(o => o.status === 'submitted').map(code));
    add('Em produção', mine.filter(o => o.status === 'production').map(code));
    add('Desenhos de fabrico por submeter',
      mine.filter(o => o.status === 'accepted' && !o.shopDrawings?.status).map(code));
  }
  if (role === 'logistics' || role === 'foreman') {
    add('Prontos para despacho', mine.filter(o => o.status === 'ready').map(code));
    add('Em trânsito, por confirmar entrega', mine.filter(inTransit).map(code));
  }
  if (role === 'site' || role === 'foreman') {
    add('Entregues, por montar', mine.filter(o => o.status === 'delivered').map(code));
  }
  if (role === 'quality') {
    add('Não conformidades em aberto',
      mine.filter(o => ncOpen(o)).map(o => `${code(o)} — ${ncOpen(o)} em aberto`));
    add('Prontos — inspeção de saída de fábrica', mine.filter(o => o.status === 'ready').map(code));
  }
  return out;
}
// The server has STATUS_ACTORS but no labels — STATUSES lives in js/store.js, which is
// client code and is not imported here. The digest is written in Portuguese like the other
// mails, so it carries its own short labels rather than reaching for the client's.
const STATUS_PT = {
  draft: 'rascunho', submitted: 'submetido', rejected: 'rejeitado', accepted: 'aceite',
  production: 'em produção', ready: 'pronto', transit: 'em trânsito',
  delivered: 'entregue', installed: 'instalado',
};
const statusOf = (o) => STATUS_PT[o.status] || o.status;

async function sendDailyDigests() {
  try {
    const { date, hour } = lisbonNow();
    if (hour < DIGEST_HOUR) return;
    const cfg = loadSmtpConfig();
    if (!cfg) return;
    const due = usersDb.users.filter(u => u.email && u.digestSentOn !== date);
    if (!due.length) return;
    const nodemailer = (await import('nodemailer')).default;
    const transport = cfg.test
      ? nodemailer.createTransport({ jsonTransport: true })
      : nodemailer.createTransport({
          host: cfg.host, port: cfg.port || 465, secure: cfg.secure !== false,
          auth: { user: cfg.user, pass: cfg.pass },
        });
    const configuredFrom = cfg.from || cfg.user || 'twinflow@localhost';
    const fromAddr = configuredFrom.match(/<([^>]+)>/)?.[1] || configuredFrom;
    let sent = 0, quiet = 0;
    for (const u of due) {
      const sections = digestSections(u);
      // Nothing waiting for this person: mark the day done and stay silent. A digest that
      // arrives saying "nothing to report" is the fastest way to teach people to ignore it.
      if (!sections.length) { u.digestSentOn = date; quiet++; continue; }
      const total = sections.reduce((s, x) => s + x.items.length, 0);
      const body = sections.map(s => `${s.title}:\n` + s.items.map(i => ` • ${i}`).join('\n')).join('\n\n');
      // Test mode pretends to send, which until now meant nobody could check WHAT it would
      // have sent. Printing it makes the mode worth having.
      if (cfg.test) console.log(`[digest] (test) ${u.username} <${u.email}> — ${total} ponto(s)\n${body}\n`);
      try {
        await transport.sendMail({
          from: `"TwinFlow" <${fromAddr}>`,
          to: u.email,
          subject: `TwinFlow — ${total} ponto(s) à tua espera`,
          text: `Bom dia${u.name ? ' ' + u.name.split(' ')[0] : ''},\n\n`
            + `Isto é o que está à espera de ti hoje:\n\n${body}\n\n`
            + `— TwinFlow (resumo diário; só chega quando há algo)`,
        });
        u.digestSentOn = date;
        sent++;
      } catch (e) { console.error(`[digest] falhou para ${u.username}:`, e.message); }
    }
    if (sent || quiet) { saveUsers(); console.log(`[digest] ${sent} enviado(s), ${quiet} sem nada a reportar${cfg.test ? ' (test mode)' : ''}`); }
  } catch (e) { console.error('[digest] failed:', e.message); }
}

// Stock shortages used to be two standalone emails on their own 22h clocks. They are now
// two sections of the daily digest, which is the whole point of having one: a director who
// is late on three requests and short on a component gets that in one mail, once, instead
// of three senders arriving at different hours of the same morning.
//
// The digest waits for a window in the DAY ("past 07:00, not yet sent today") rather than
// for hours to elapse, so it is checked every 20 minutes — a 6h tick sails past the morning.
function scheduleDigests() {
  sendDailyDigests();
  setInterval(sendDailyDigests, 20 * 60 * 1000).unref?.();
}

// ---------- users & sessions ----------

function saveUsers() {
  try { persistUsersDb(usersDb); }
  catch (e) { console.error('[auth] save failed:', e.message); }
}

function hashPassword(pw, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(String(pw), salt, 64).toString('hex') };
}

function verifyPassword(pw, user) {
  const h = scryptSync(String(pw), user.salt, 64);
  const stored = Buffer.from(user.hash, 'hex');
  return h.length === stored.length && timingSafeEqual(h, stored);
}

// ---------- Portal das Finanças credentials, per account ----------
//
// The AT's own manual settles the design: the taxpayer is responsible for the content of
// the message because it goes out under THEIR Portal credentials, and those "só podem ser
// conhecidas pelo Sujeito Passivo". So they belong to the account, each person enters
// their own, and an administrator never sees or sets somebody else's.
//
// This password is the one thing here that cannot be hashed — it has to be recoverable in
// clear at request time, because the AT scheme encrypts it with a per-request AES key. So
// it is encrypted at rest with AES-256-GCM under a key that lives OUTSIDE the database and
// outside the web root, in TWINFLOW_AT_KEY. Two consequences worth stating plainly:
// somebody holding the database alone cannot read these passwords, and somebody holding
// both the database and the key can. There is no arrangement where an automatic
// submission is possible and the password is unrecoverable — that is inherent to what the
// AT asks for, not a shortcut taken here.
//
// With no key configured, storing is REFUSED rather than falling back to plaintext.
const atKey = () => {
  const raw = process.env.TWINFLOW_AT_KEY || '';
  if (!raw) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  return key.length === 32 ? key : null;
};

function encryptAtPassword(plain) {
  const key = atKey();
  if (!key) throw new Error('TWINFLOW_AT_KEY is not set (needs 32 bytes, hex or base64) — cannot store Portal das Finanças credentials');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

// Used only by the submission path, never by anything that answers a request.
function decryptAtPassword(blob) {
  const key = atKey();
  if (!key || !blob) return null;
  try {
    const [iv, tag, data] = String(blob).split(':');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch { return null; } // wrong key, or a tampered record — either way, not usable
}

// "quem não tiver não pode comunicar automaticamente" — one predicate, so the UI and the
// submission endpoint can never disagree about who is allowed.
const canCommunicateAt = (u) => !!(u && u.atUsername && u.atPasswordEnc && atKey());

// The AT username is `<NIF>/<subutilizador>`: the taxpayer's number, then the sub-user id.
const AT_USERNAME_RE = /^\d{9}\/\d{1,10}$/;

function getUser(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)tf_token=([a-f0-9-]+)/);
  const token = m && m[1];
  const sess = token && usersDb.sessions[token];
  if (!sess) return null;
  // expire stale sessions server-side (a leaked token can't live forever); a missing
  // or unparseable createdAt (legacy rows) is treated as fresh to avoid mass logout
  const created = Number(sess.createdAt);
  if (created && Date.now() - created > SESSION_TTL_MS) {
    delete usersDb.sessions[token];
    saveUsers();
    return null;
  }
  return usersDb.users.find(u => u.id === sess.userId) || null;
}

const VALID_LANGS = ['en', 'pt'];
// atUsername is `<NIF>/<subutilizador>` — an identifier, not a secret, and the person
// needs to see which one is configured. The password NEVER leaves this process in any
// form: what goes out is a boolean saying whether an automatic submission is possible.
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, email: u.email || '', role: u.role, projectIds: u.projectIds || [], partyId: u.partyId || '', lang: u.lang || 'en', mustChangePassword: !!u.mustChangePassword, atUsername: u.atUsername || '', canCommunicateAt: canCommunicateAt(u), createdAt: u.createdAt });

// The factory an account belongs to, and therefore the only stock it may see or
// touch. Three answers, and the middle one is the point of the whole feature:
//   'all'     — the warehouse side: admin and the two director roles run it
//   {factory} — bound to one factory: its balance, its movements, nothing else
//   'none'    — a factory account nobody has linked yet. It sees no balances at
//               all, deliberately: the safe reading of "not configured" is "not
//               entitled", never "entitled to everything".
// The binding follows the LINK, not the role, so linking a quality account scopes
// its stock too — while a director's link means nothing, because they hold the
// warehouse and would otherwise lock themselves out of it.
function stockScope(u) {
  if (!u) return { mode: 'none' };
  if (CREATOR_ROLES.includes(u.role)) return { mode: 'all' };
  if (u.partyId) return { mode: 'factory', factoryId: u.partyId };
  // An account whose whole job is one location and which has not been given one is
  // entitled to nothing — on WRITES as much as on reads. This used to name only
  // 'factory', so an unlinked site account fell through to 'all' and could mark
  // consumption at any factory in the system while its own screen showed nothing.
  if (['factory', 'site'].includes(u.role)) return { mode: 'none' };
  return { mode: 'all' };
}

// The single place a component is masked before it leaves this process.
//
// The state endpoint used to do this inline while /api/stock/move and
// /api/stock/reverse answered with the raw object — so every mark or reversal by a
// bound account handed back the real warehouse balance and every other factory's,
// which the client then wrote straight into its local state. The masking now lives in
// one function and every exit uses it: a second exit that forgets to mask is exactly
// the shape of bug this had.
//
// `null`, never 0: zero is a claim about stock and would be a lie. Null says "not
// yours to know" and the client renders a dash.
function scopedComponent(c, scope) {
  if (!c || scope.mode !== 'factory') return c;
  return {
    ...c,
    warehouseQty: null,
    minQty: null, // the warehouse minimum is the warehouse's business
    factoryQty: { [scope.factoryId]: c.factoryQty?.[scope.factoryId] || 0 },
    factoryMinQty: c.factoryMinQty?.[scope.factoryId] === undefined
      ? {} : { [scope.factoryId]: c.factoryMinQty[scope.factoryId] },
  };
}
// only a real fabrication company can be an account's factory — an id typed by hand,
// or one belonging to a supplier or a logistics party, would bind the account to
// something that holds no stock, which reads as "linked" while behaving as "blind"
const factoryPartyId = (id) => {
  const v = String(id || '').trim();
  return v && appState.parties.some(p => p.id === v && ['factory', 'site'].includes(p.type)) ? v : '';
};

// an account's address is used as Reply-To on outgoing mail, so it must be one
// single-line address — the same rule the send endpoint applies to recipients
const cleanEmail = (e) => {
  const v = String(e || '').trim();
  return v && v.includes('@') && !/[\r\n]/.test(v) ? v : '';
};

// ---------- communicating a shipment to the AT ----------
//
// A shipment is not an entity here — it is the set of 'send' movements sharing one
// timestamp and one destination — so the document is composed from the ledger, exactly
// like the guia and the guia email. The client names the LOAD and the document type; it
// never supplies the contents, the recipient or the numbering.
//
// Order of operations, and the reason for it: the movements are already written before
// this runs. If the AT is unreachable the stock still moved and the ledger still says so,
// and the shipment is simply marked as not yet communicated. Losing a warehouse movement
// because a tax service timed out would be the worse failure by a wide margin.
function shipmentMoves(ts, factoryId) {
  return appState.stockMoves.filter(m => m.type === 'send' && m.ts === ts
    && (m.factoryId || '') === (factoryId || '') && !m.reversedBy);
}

function buildAtDocument({ moves, documentNumber, movementType }) {
  const m0 = moves[0];
  const sender = appState.parties.find(p => p.type === 'admin');
  const dest = appState.parties.find(p => p.id === m0.factoryId);
  if (!sender) throw new Error('No company record of type "admin" — the sender is taken from it');
  const addr = (p) => ({ detail: p?.address || '', city: p?.city || '', postalCode: p?.postalCode || '', country: p?.country || 'PT' });

  // The AT wants all four address parts on the sender and on the loading place. Refusing
  // here, by name, beats a schema error that says only that something was wrong.
  const gaps = [];
  if (!sender.nif) gaps.push('NIF do remetente');
  for (const [k, label] of [['address', 'morada'], ['city', 'localidade'], ['postalCode', 'código postal']]) {
    if (!sender[k]) gaps.push(`${label} do remetente`);
  }
  if (gaps.length) throw new Error(`Faltam dados obrigatórios: ${gaps.join(', ')}`);

  const comp = (id) => appState.components.find(c => c.id === id);
  const start = m0.departAt || m0.ts;
  return {
    senderNif: sender.nif,
    senderName: sender.name,
    senderAddress: addr(sender),
    documentNumber,
    movementStatus: 'N',
    movementDate: String(m0.ts).slice(0, 10),
    movementType,
    // A movement of the company's own goods to its own factory has no third-party
    // customer; the manual's placeholder NIF is the correct answer, not a blank.
    customerNif: dest?.nif || UNKNOWN_NIF,
    customerName: dest?.name || '',
    customerAddress: dest ? addr(dest) : null,
    addressTo: dest ? addr(dest) : null,
    addressFrom: addr(sender),
    // "AAAA-MM-DDThh:mm:ss" — seconds may be 00, but the shape is fixed
    movementStartTime: new Date(start).toISOString().slice(0, 19),
    vehicleId: m0.plate || '',
    lines: moves.map(m => {
      const c = comp(m.componentId);
      return {
        description: c?.name || m.componentId,
        quantity: m.qty,
        unit: c?.unit || 'un',
        unitPrice: 0, // this app moves goods, it does not price them
        orderReferences: m.orderCode ? [m.orderCode] : [],
      };
    }),
  };
}

// Writes the outcome onto every line of the shipment, so the ledger — which is what the
// document is rebuilt from — carries the answer too.
function stampShipment(moves, fields) {
  for (const m of moves) Object.assign(m, fields);
}

async function communicateShipment({ ts, factoryId, movementType, user }) {
  const cfg = loadAtConfig();
  if (!cfg) throw new Error('A ligação à AT não está configurada neste servidor (TWINFLOW_AT_CONFIG)');
  if (!canCommunicateAt(user)) throw new Error('A tua conta não tem credenciais do Portal das Finanças — preenche-as na tua ficha');
  const moves = shipmentMoves(ts, factoryId);
  if (!moves.length) throw new Error('Carga não encontrada, ou estornada por inteiro');
  if (moves[0].atDocCodeId) throw new Error('Esta carga já foi comunicada à AT');

  // The number is consumed once and then REUSED on a retry. The document was issued with
  // that number the first time; a retry communicates the same document, not a new one.
  // Taking a fresh number per attempt would burn a number on every failure and, worse,
  // leave two numbers describing one shipment.
  const documentNumber = moves[0].documentNumber || nextDocumentNumber(movementType).documentNumber;
  const type = moves[0].movementType || movementType;
  stampShipment(moves, { documentNumber, movementType: type, atStatus: 'pending' });

  const password = decryptAtPassword(user.atPasswordEnc);
  if (!password) throw new Error('Não foi possível ler as credenciais guardadas — volta a introduzi-las na tua ficha');

  const material = { atPublicKeyPath: cfg.atPublicKeyPath };
  let result;
  try {
    const security = buildSecurity({
      username: user.atUsername,
      password,
      atPublicKeyPem: readFileSync(material.atPublicKeyPath, 'utf8'),
    });
    result = await atCommunicate({ cfg, security, doc: buildAtDocument({ moves, documentNumber, movementType: type }) });
  } catch (e) {
    stampShipment(moves, { atStatus: 'error', atMessage: e.message, atAt: new Date().toISOString() });
    bumpState();
    throw e;
  }

  if (!result.ok) {
    stampShipment(moves, {
      atStatus: 'error',
      atMessage: result.message || `ReturnCode ${result.returnCode}`,
      atReturnCode: result.returnCode ?? null,
      atAt: new Date().toISOString(),
    });
    bumpState();
    logConfig('at.communication.failed', { kind: 'state' },
      { documentNumber, returnCode: result.returnCode ?? null, production: result.production }, user);
    throw new Error(result.message || `A AT recusou o documento (código ${result.returnCode})`);
  }

  stampShipment(moves, {
    atStatus: 'sent',
    atDocCodeId: result.atDocCodeId || '',
    atMessage: '',
    atReturnCode: 0,
    atAt: new Date().toISOString(),
    atProduction: !!result.production,
  });
  bumpState();
  logConfig('at.communicated', { kind: 'state' },
    { documentNumber, atDocCodeId: result.atDocCodeId || '', lines: moves.length, production: !!result.production }, user);
  return { documentNumber, atDocCodeId: result.atDocCodeId || '', production: !!result.production, lines: moves.length };
}

// The reference to the REAL transport document, which the AT issues and another system
// communicates. TwinFlow does not produce it and deliberately does not try: issuing a
// documento de transporte is what puts software inside the certification regime. What it
// keeps is the number and the Código AT, so a shipment in this ledger can be tied to the
// paper that legally accompanied it.
//
// Free text with a length cap, and no format check. The formats are the AT's to define
// and to change; a regex invented here would start refusing valid codes the day they
// adjust something, and a document that cannot be recorded is worse than one recorded
// oddly. Uppercased and stripped of line breaks only.
const cleanGuiaRef = ({ guiaNumber, atCode }) => {
  const one = (v, n) => String(v ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
  const num = one(guiaNumber, 60);
  const code = one(atCode, 40).toUpperCase();
  return { ...(num ? { guiaNumber: num } : {}), ...(code ? { atCode: code } : {}) };
};

// The set of addresses this installation is allowed to write to: a partner on file, or
// a colleague's account. Both are administered inside the app and both are logged when
// they change — which is what makes this a boundary rather than a formality. Compared
// case-insensitively because the domain half is case-insensitive and nobody types an
// address back the same way twice.
const knownRecipient = (addr) => {
  const v = String(addr || '').trim().toLowerCase();
  if (!v) return false;
  return appState.parties.some(p => String(p.email || '').trim().toLowerCase() === v)
    || usersDb.users.some(u => String(u.email || '').trim().toLowerCase() === v);
};

// server-sent events: connected clients get the new revision instantly
const sseClients = new Set();
function broadcastRev() {
  for (const c of sseClients) {
    try { c.write(`data: ${appState.rev}\n\n`); } catch { sseClients.delete(c); }
  }
}

let stateSaveTimer = null;
function bumpState() {
  appState.rev += 1;
  broadcastRev();
  clearTimeout(stateSaveTimer);
  stateSaveTimer = setTimeout(() => {
    try { persistAppState(appState); } // transactional rewrite + atomic file export
    catch (e) { console.error('[state] save failed:', e.message); }
  }, 150);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.ifc': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  // without these the fonts went out as application/octet-stream, which makes the
  // browser discard the preload and fetch them a second time
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function loadSmtpConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    if (!cfg.test && (!cfg.host || !cfg.user || !cfg.pass)) return null;
    return cfg;
  } catch { return null; }
}

// Everything the CONNECTION to the AT needs — the environment, the AT public key used to
// encrypt the request key, and the client certificate the AT signs. Not credentials:
// those belong to each account (see canCommunicateAt), and an account without them simply
// cannot submit automatically.
//
// A file outside the web root, like the SMTP config and for the same reason: on this host
// Apache serves static files itself, so anything inside the app folder is one .htaccess
// mistake away from being downloadable — and this one points at a private key.
//
// It is a FILE and not a settings screen on purpose: it carries certificate and key
// paths, which are not things to upload through a form.
//
// `environment` is the guard. Anything other than the exact string 'production' is
// treated as the test service, so pointing at the real one is always a deliberate edit
// and never a default. Communicating a test movement to the live service creates a real
// declared document.
const AT_ENDPOINTS = {
  test: 'https://servicos.portaldasfinancas.gov.pt:701/sgdtws/documentosTransporte',
  production: 'https://servicos.portaldasfinancas.gov.pt:401/sgdtws/documentosTransporte',
};
const AT_CONFIG_PATH = process.env.TWINFLOW_AT_CONFIG || '';
function loadAtConfig() {
  if (!AT_CONFIG_PATH || !existsSync(AT_CONFIG_PATH)) return null;
  try {
    // Strip the BOM. Every Windows editor and PowerShell's own Out-File write one, and
    // JSON.parse rejects it — which surfaces as "the AT is not configured" while the file
    // sits there looking perfectly correct. An hour lost to an invisible character.
    const cfg = JSON.parse(readFileSync(AT_CONFIG_PATH, 'utf8').replace(/^﻿/, ''));
    const production = cfg.environment === 'production';
    return {
      ...cfg,
      production,
      endpoint: production ? AT_ENDPOINTS.production : AT_ENDPOINTS.test,
    };
  } catch { return null; }
}
function sendJson(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('File too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- security helpers (online deployment) ----------
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // stale sessions expire server-side
const cookieToken = (req) => (req.headers.cookie || '').match(/(?:^|;\s*)tf_token=([a-f0-9-]+)/)?.[1] || null;
// behind cPanel/Passenger, TLS is terminated by the proxy — trust the forwarded proto
const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
  || !!req.socket?.encrypted;
// X-Forwarded-For arrives from the client and is only trustworthy where the proxy
// wrote it. nginx APPENDS the address it actually saw to whatever the request
// carried, so the chain reads "whatever the caller invented, …, the real caller"
// — the LAST entry is the only one written by infrastructure we control. Reading
// the FIRST one (as this did) let anyone rotate a header and reset their own login
// throttle: 8 failures locked one fake IP while the next fake IP started clean.
// Falling back to the socket address is wrong in production on its own — behind
// Passenger every request comes from the same local hop, so one attacker would
// lock out the whole company. Set TWINFLOW_TRUST_PROXY=0 when the app is exposed
// directly, with no proxy in front to write the header.
const TRUST_PROXY = process.env.TWINFLOW_TRUST_PROXY !== '0';
const clientIp = (req) => {
  if (TRUST_PROXY) {
    const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (chain.length) return chain[chain.length - 1];
  }
  return req.socket?.remoteAddress || '';
};
function sessionCookie(req, token, maxAge) {
  // Secure is added only over HTTPS so local http development still works
  return `tf_token=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`;
}

// login brute-force throttle: per IP+username, lock after too many failures
const LOGIN_MAX_FAILS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map();
const loginKey = (req, username) => clientIp(req) + '|' + String(username || '').toLowerCase();
function loginLockSeconds(key) {
  const e = loginAttempts.get(key);
  return e?.lockUntil > Date.now() ? Math.ceil((e.lockUntil - Date.now()) / 1000) : 0;
}
function noteLoginFail(key) {
  const now = Date.now();
  if (loginAttempts.size > 5000) { // opportunistic prune so the map can't grow unbounded
    for (const [k, v] of loginAttempts) if (now - v.first > LOGIN_WINDOW_MS && !(v.lockUntil > now)) loginAttempts.delete(k);
  }
  let e = loginAttempts.get(key);
  if (!e || now - e.first > LOGIN_WINDOW_MS) e = { fails: 0, first: now, lockUntil: 0 };
  e.fails += 1;
  if (e.fails >= LOGIN_MAX_FAILS) e.lockUntil = now + LOGIN_WINDOW_MS;
  loginAttempts.set(key, e);
}

// per-user hourly cap on outbound email (the app relays via one SMTP account)
const EMAIL_MAX_PER_HOUR = 40;
const emailCounts = new Map();
function emailAllowed(userId) {
  const now = Date.now();
  let e = emailCounts.get(userId);
  if (!e || now > e.resetAt) e = { count: 0, resetAt: now + 60 * 60 * 1000 };
  if (e.count >= EMAIL_MAX_PER_HOUR) { emailCounts.set(userId, e); return false; }
  e.count += 1;
  emailCounts.set(userId, e);
  return true;
}

async function handleApi(req, res, path, user) {
  // ---------- auth (public endpoints) ----------
  if (path === '/api/login' && req.method === 'POST') {
    try {
      const { username, password } = JSON.parse(await readBody(req));
      const key = loginKey(req, username);
      const locked = loginLockSeconds(key);
      if (locked) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(locked) });
        res.end(JSON.stringify({ ok: false, error: 'Too many attempts — try again later' }));
        return true;
      }
      const u = usersDb.users.find(x => x.username.toLowerCase() === String(username || '').toLowerCase());
      if (!u || !verifyPassword(password || '', u)) {
        noteLoginFail(key);
        sendJson(res, { ok: false, error: 'Wrong username or password' }, 401);
        return true;
      }
      loginAttempts.delete(key); // clean slate on success
      const token = randomUUID();
      usersDb.sessions[token] = { userId: u.id, createdAt: Date.now() };
      saveUsers();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': sessionCookie(req, token, 2592000),
      });
      res.end(JSON.stringify({ ok: true, user: publicUser(u) }));
    } catch { sendJson(res, { ok: false, error: 'Invalid request' }, 400); }
    return true;
  }
  if (path === '/api/me') {
    if (user) sendJson(res, { ok: true, user: publicUser(user) });
    else sendJson(res, { ok: false, error: 'unauthorized' }, 401);
    return true;
  }
  if (path === '/api/logout' && req.method === 'POST') {
    const token = cookieToken(req);
    if (token) { delete usersDb.sessions[token]; saveUsers(); }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': sessionCookie(req, '', 0),
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // everything below requires a signed-in user
  if (!user) { sendJson(res, { ok: false, error: 'unauthorized' }, 401); return true; }

  // An account still carrying the seeded password is not a working session.
  //
  // First boot creates admin/admin with `mustChangePassword`. That flag was handed back
  // to the client and consumed by exactly one line — a banner you could dismiss — while
  // no route on the server ever read it. So a session opened with the default
  // credentials held complete administrator authority from its first request: users,
  // full-state import, the training export, everything. The seeded password also
  // sidesteps the 8-character minimum every other password in the system must meet, and
  // the login throttle never fires because admin/admin succeeds on the first attempt.
  //
  // The flag is now a gate, not a notice. /api/me and /api/logout sit above this line
  // and stay reachable, and /api/password is the one way out — enough for the client to
  // know who it is, change the password, or leave, and nothing else.
  if (user.mustChangePassword && path !== '/api/password') {
    sendJson(res, { ok: false, error: 'Set a new password before using the application', mustChangePassword: true }, 403);
    return true;
  }

  if (path === '/api/password' && req.method === 'POST') {
    try {
      const { current, next } = JSON.parse(await readBody(req));
      if (!verifyPassword(current || '', user)) { sendJson(res, { ok: false, error: 'Current password is wrong' }, 403); return true; }
      if (!next || String(next).length < 8) { sendJson(res, { ok: false, error: 'New password too short (min. 8)' }, 400); return true; }
      Object.assign(user, hashPassword(next));
      delete user.mustChangePassword; // the default-credential nag clears once changed
      // changing the password logs every OTHER device out (a precaution if it leaked)
      const keep = cookieToken(req);
      for (const [tok, s] of Object.entries(usersDb.sessions)) {
        if (s.userId === user.id && tok !== keep) delete usersDb.sessions[tok];
      }
      saveUsers();
      sendJson(res, { ok: true });
    } catch { sendJson(res, { ok: false, error: 'Invalid request' }, 400); }
    return true;
  }

  // self-service preferences (e.g. display language) — any signed-in user, own account only
  if (path === '/api/preferences' && req.method === 'POST') {
    try {
      const { lang, email } = JSON.parse(await readBody(req));
      if (lang && VALID_LANGS.includes(lang)) user.lang = lang;
      if (email !== undefined) user.email = cleanEmail(email);
      saveUsers();
      sendJson(res, { ok: true, user: publicUser(user) });
    } catch { sendJson(res, { ok: false, error: 'Invalid request' }, 400); }
    return true;
  }

  // ---------- transport document series ----------
  // Readable by anyone who can dispatch, because the next number is information a person
  // wants before issuing. Writable only by an administrator: the series identifier
  // decides which counter is used, so changing it is changing the numbering of a legal
  // document.
  if (path === '/api/doc-series' && req.method === 'GET') {
    sendJson(res, {
      ok: true,
      series: docSeries(),
      types: Object.entries(DOC_TYPES).map(([code, label]) => ({ code, label, next: `${code} ${docSeries()}/${docPeek(code)}` })),
    });
    return true;
  }
  if (path === '/api/doc-series' && req.method === 'POST') {
    if (user.role !== 'admin') { sendJson(res, { ok: false, error: 'admin only' }, 403); return true; }
    try {
      const { series } = JSON.parse(await readBody(req));
      const s = String(series || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 20);
      if (!s) throw new Error('The series identifier cannot be empty');
      // Switching to a series that has already issued documents would restart numbering
      // partway through it. Moving to a fresh series, or back to one that is still empty,
      // is fine — going back into a used one is not.
      const used = Object.keys(docCounters()).some(k => k.endsWith(`|${s}`));
      if (s !== docSeries() && used) {
        throw new Error(`Series ${s} has already issued documents — pick a series that has not been used`);
      }
      appState.docSeries = { series: s, counters: docCounters() };
      bumpState();
      logConfig('docseries.changed', { kind: 'state' }, { series: s }, user);
      sendJson(res, { ok: true, series: s });
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    return true;
  }

  // ---------- Portal das Finanças credentials (own account only) ----------
  //
  // No admin branch, deliberately. An administrator can see WHO is able to communicate —
  // publicUser carries the boolean — but there is no route by which one account writes
  // another's Portal password. The AT holds the taxpayer responsible for what goes out
  // under their credentials; a system where somebody else can enter them makes that
  // responsibility unattributable.
  if (path === '/api/at-credentials' && req.method === 'POST') {
    try {
      const { atUsername, atPassword } = JSON.parse(await readBody(req));
      const uname = String(atUsername || '').trim();
      if (!AT_USERNAME_RE.test(uname)) throw new Error('The user must be NIF/subuser, e.g. 599999993/37');
      if (!atPassword) throw new Error('Password is required');
      // encryptAtPassword throws when TWINFLOW_AT_KEY is missing — surfaced as-is,
      // because "it saved" while storing a Portal password in clear is not acceptable
      user.atPasswordEnc = encryptAtPassword(atPassword);
      user.atUsername = uname;
      user.atConfiguredAt = new Date().toISOString();
      saveUsers();
      // the log records that credentials were set and by whom — never the value, and
      // not even the sub-user id's password half
      logConfig('at.credentials.set', { kind: 'account', id: user.id, username: user.username },
        { atUsername: uname }, user);
      sendJson(res, { ok: true, user: publicUser(user) });
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    return true;
  }
  if (path === '/api/at-credentials' && req.method === 'DELETE') {
    delete user.atUsername;
    delete user.atPasswordEnc;
    delete user.atConfiguredAt;
    saveUsers();
    logConfig('at.credentials.cleared', { kind: 'account', id: user.id, username: user.username }, {}, user);
    sendJson(res, { ok: true, user: publicUser(user) });
    return true;
  }

  // ---------- user management (admin only) ----------
  if (path === '/api/users' && req.method === 'GET') {
    if (user.role !== 'admin') { sendJson(res, { ok: false, error: 'admin only' }, 403); return true; }
    sendJson(res, { ok: true, users: usersDb.users.map(publicUser) });
    return true;
  }
  if (path === '/api/users' && req.method === 'POST') {
    if (user.role !== 'admin') { sendJson(res, { ok: false, error: 'admin only' }, 403); return true; }
    try {
      const { username, name, email, password, role, projectIds, partyId } = JSON.parse(await readBody(req));
      if (!username || !password || !role) throw new Error('username, password and role are required');
      if (String(password).length < 8) throw new Error('Password too short (min. 8)');
      if (!VALID_ROLES.includes(role)) throw new Error('Invalid role');
      if (usersDb.users.some(u => u.username.toLowerCase() === String(username).toLowerCase())) throw new Error('Username already exists');
      const u = {
        id: 'u-' + randomUUID().slice(0, 8),
        username: String(username).trim(), name: String(name || username).trim(), email: cleanEmail(email), role,
        projectIds: Array.isArray(projectIds) ? projectIds : [],
        partyId: factoryPartyId(partyId),
        ...hashPassword(password), createdAt: new Date().toISOString(),
      };
      usersDb.users.push(u);
      saveUsers();
      logConfig('account.created', { kind: 'account', id: u.id, username: u.username },
        { role: u.role, projects: (u.projectIds || []).length }, user);
      sendJson(res, { ok: true, user: publicUser(u) });
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    return true;
  }
  if (path.startsWith('/api/users/') && req.method === 'PUT') {
    if (user.role !== 'admin') { sendJson(res, { ok: false, error: 'admin only' }, 403); return true; }
    const id = path.slice('/api/users/'.length);
    const target = usersDb.users.find(u => u.id === id);
    if (!target) { sendJson(res, { ok: false, error: 'Account not found' }, 404); return true; }
    try {
      const { username, name, email, role, password, projectIds, partyId } = JSON.parse(await readBody(req));
      const prevRole = target.role;
      const prevProjects = JSON.stringify(target.projectIds || []);
      const otherAdmins = usersDb.users.filter(u => u.id !== id && u.role === 'admin').length;
      if (target.role === 'admin' && role && role !== 'admin' && otherAdmins === 0) {
        throw new Error('Cannot remove the last administrator');
      }
      if (username) {
        const clash = usersDb.users.some(u => u.id !== id && u.username.toLowerCase() === String(username).toLowerCase());
        if (clash) throw new Error('Username already exists');
        target.username = String(username).trim();
      }
      if (name) target.name = String(name).trim();
      if (email !== undefined) target.email = cleanEmail(email);
      if (role) {
        if (!VALID_ROLES.includes(role)) throw new Error('Invalid role');
        target.role = role;
      }
      if (Array.isArray(projectIds)) target.projectIds = projectIds;
      if (partyId !== undefined) target.partyId = factoryPartyId(partyId);
      if (password) {
        if (String(password).length < 8) throw new Error('New password too short (min. 8)');
        Object.assign(target, hashPassword(password));
        delete target.mustChangePassword; // an admin-set password clears the nag too
        // force other devices of that account to re-authenticate
        for (const [tok, s] of Object.entries(usersDb.sessions)) if (s.userId === target.id) delete usersDb.sessions[tok];
      }
      saveUsers();
      // the password itself is never in the event — only that one was set, which is
      // what matters for explaining a forced re-authentication
      logConfig('account.updated', { kind: 'account', id: target.id, username: target.username },
        { role: target.role, projects: (target.projectIds || []).length,
          roleChanged: !!role && role !== prevRole, projectsChanged: Array.isArray(projectIds) && JSON.stringify(projectIds) !== prevProjects,
          passwordSet: !!password }, user);
      sendJson(res, { ok: true, user: publicUser(target) });
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    return true;
  }
  if (path.startsWith('/api/users/') && req.method === 'DELETE') {
    if (user.role !== 'admin') { sendJson(res, { ok: false, error: 'admin only' }, 403); return true; }
    const id = path.slice('/api/users/'.length);
    if (id === user.id) { sendJson(res, { ok: false, error: 'You cannot delete your own account' }, 400); return true; }
    const target = usersDb.users.find(u => u.id === id);
    const otherAdmins = usersDb.users.filter(u => u.id !== id && u.role === 'admin').length;
    if (target?.role === 'admin' && otherAdmins === 0) {
      sendJson(res, { ok: false, error: 'Cannot delete the last administrator' }, 400); return true;
    }
    usersDb.users = usersDb.users.filter(u => u.id !== id);
    for (const [t, s] of Object.entries(usersDb.sessions)) if (s.userId === id) delete usersDb.sessions[t];
    saveUsers();
    logConfig('account.deleted', { kind: 'account', id, username: target?.username || '' },
      { role: target?.role || null }, user);
    sendJson(res, { ok: true });
    return true;
  }

  // ---------- shared state API ----------
  if (path === '/api/events') { // SSE stream of state revisions
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${appState.rev}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return true;
  }
  if (path === '/api/rev') { sendJson(res, { rev: appState.rev }); return true; }
  if (path === '/api/state') {
    if (req.method === 'GET') {
      // project-scoped roles (project_director, site_director, foreman, factory,
      // site) only ever receive the projects assigned to them; everyone else (the
      // administrator, plus quality/logistics who audit across sites) gets it all.
      if (isProjectScoped(user.role)) {
        const allowed = new Set(user.projectIds || []);
        const projects = appState.projects.filter(p => allowed.has(p.id));
        let orders = appState.orders.filter(o => allowed.has(o.projectId));
        // the assembly team only needs what's in transit, delivered or installed —
        // not the factory/engineering side of the process (and no stock at all)
        if (user.role === 'site') orders = orders.filter(o => SITE_VISIBLE_STATUSES.has(o.status));
        // catalog + balances are global infrastructure (like parties); the ledger is
        // the project-traceable artifact, so scope it exactly like projects/orders —
        // warehouse-level moves (no projectId) stay visible to everyone but 'site'
        // An account bound to a factory is sent ONLY that factory's balance. The
        // warehouse quantity is nulled rather than zeroed — zero is a fact about
        // stock and would be a lie; null says "not yours to know", and the client
        // renders it as a dash. Other factories' balances never leave this process.
        // The site role used to get no stock at all — the assembly team was not meant to
        // see the warehouse. Now that material can be delivered TO a site, an account
        // bound to one needs its own balance, and only that: the binding is what grants
        // it, exactly as for a factory. Unbound, it still sees nothing.
        const scope = stockScope(user);
        const noStock = scope.mode === 'none' || (user.role === 'site' && scope.mode !== 'factory');
        let components = noStock ? [] : appState.components;
        let stockMoves = noStock ? []
          : appState.stockMoves.filter(m => !m.projectId || allowed.has(m.projectId));
        if (scope.mode === 'factory') {
          components = components.map(c => scopedComponent(c, scope));
          stockMoves = stockMoves.filter(m => m.factoryId === scope.factoryId);
        }
        // procurement is the GC's commercial book: which supplier, how much, how
        // long they took. The factory is an outside company — it needs the catalog
        // and its own floor marks, never the purchasing history behind them. Only
        // CREATOR_ROLES can write procurement, so nothing here loses a capability.
        const procurement = (user.role === 'site' || user.role === 'factory') ? [] : appState.procurement;
        sendJson(res, { ...appState, projects, orders, components, stockMoves, procurement });
      } else {
        // quality and logistics audit across every project, so nothing here scopes by
        // project — but the stock binding follows the LINK, not the role (see stockScope),
        // and this branch used to ignore it entirely. An administrator who linked a
        // logistics account to one haulier, believing that narrowed it, was handed every
        // fabricator's balance and the whole ledger on the one endpoint that ships the
        // numbers, while /api/stock/move scoped that same account correctly. The masking
        // has to happen on the read too, or the binding means nothing where it counts.
        const scope = stockScope(user);
        if (scope.mode === 'factory') {
          sendJson(res, {
            ...appState,
            components: appState.components.map(c => scopedComponent(c, scope)),
            stockMoves: appState.stockMoves.filter(m => m.factoryId === scope.factoryId),
          });
        } else {
          sendJson(res, appState);
        }
      }
      return true;
    }
    if (req.method === 'PUT') { // full replace (first-device migration, data import) — admin only
      if (user.role !== 'admin') { sendJson(res, { ok: false, error: 'admin only' }, 403); return true; }
      try {
        const body = JSON.parse(await readRawBody(req, 50 * 1024 * 1024));
        // The one-time markers describe THIS INSTALLATION's migration history, not the
        // data being imported, so they have to survive the replace. `defaultAppState()`
        // carries none of them, so rebuilding from it silently cleared all five: the
        // next restart re-ran every guarded migration, and the one that matters is
        // scopeExistingProjectDirectors — a director deliberately narrowed afterwards
        // was handed every project again, which is precisely the invariant its own
        // comment promises to hold.
        // Document counters are merged, not carried and not replaced. An imported export
        // brings its own, and either direction alone is wrong: taking theirs can hand out
        // a number this installation already issued, keeping ours can do the same to
        // theirs. The higher of the two is the only choice that never reuses a number —
        // at the cost of a gap, which is the survivable one of the two failures.
        const importedSeries = body.docSeries || {};
        const mergedCounters = { ...docCounters() };
        for (const [k, v] of Object.entries(importedSeries.counters || {})) {
          mergedCounters[k] = Math.max(Number(mergedCounters[k]) || 0, Number(v) || 0);
        }
        const keep = {
          resetAt: appState.resetAt,
          sdWaivedAt: appState.sdWaivedAt,
          pdScopedAt: appState.pdScopedAt,
          docSeries: { series: importedSeries.series || docSeries(), counters: mergedCounters },
        };
        appState = {
          ...defaultAppState(),
          seq: Number(body.seq) || 1,
          projects: Array.isArray(body.projects) ? body.projects : [],
          orders: Array.isArray(body.orders) ? body.orders : [],
          parties: Array.isArray(body.parties) && body.parties.length ? body.parties : defaultAppState().parties,
          components: Array.isArray(body.components) ? body.components : [],
          stockMoves: Array.isArray(body.stockMoves) ? body.stockMoves : [],
          procurement: Array.isArray(body.procurement) ? body.procurement : [],
          rev: appState.rev,
          ...keep,
        };
        // The DATA-SHAPE migrations are a different matter: the import may well carry an
        // old export, and those run only at boot, so the data stayed half-migrated until
        // somebody happened to restart. mergeComponentDescriptions is the dangerous one
        // — until it runs, a sheet import recognises nothing it created and duplicates
        // the entire warehouse. They are idempotent and touch only components and
        // procurement, so they run here directly rather than being marker-gated.
        splitPartyContacts(); // an export taken before the split still carries `contact`
        appState.descMergedAt = null;
        appState.typesMappedAt = null;
        mergeComponentDescriptions();
        mapComponentTypes();
        migrateProcurementLines();
        bumpState();
        // a full replace invalidates every earlier context in the log — mark the seam
        // so a training run can tell "the world changed" from "somebody decided"
        logConfig('data.imported', { kind: 'state' },
          { projects: appState.projects.length, orders: appState.orders.length,
            components: appState.components.length, stockMoves: appState.stockMoves.length }, user);
        sendJson(res, { ok: true, rev: appState.rev });
      } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
      return true;
    }
    if (req.method === 'DELETE') { // reset everything, including stored models — admin only
      if (user.role !== 'admin') { sendJson(res, { ok: false, error: 'admin only' }, 403); return true; }
      const wiped = { projects: appState.projects.length, orders: appState.orders.length };
      // Mark the erasure. Without it, the next device to sign in with the old data
      // still in its localStorage sees an empty server, decides this must be a
      // pre-server installation waiting to be migrated, and uploads everything
      // back — the reset silently undone by whoever opened the app next.
      appState = { ...defaultAppState(), rev: appState.rev, resetAt: new Date().toISOString() };
      bumpState();
      await rm(MODELS_DIR, { recursive: true, force: true }).catch(() => {});
      // the training log deliberately SURVIVES a reset: the decisions were still made,
      // and this seam is exactly the kind of discontinuity a training run must see
      logConfig('data.reset', { kind: 'state' }, wiped, user);
      sendJson(res, { ok: true, rev: appState.rev });
      return true;
    }
  }
  if (path === '/api/projects' && req.method === 'POST') { // upsert by id
    try {
      const p = JSON.parse(await readRawBody(req, 50 * 1024 * 1024));
      if (!p.id) throw new Error('Missing project id');
      // foremen operate the flow but do not manage project data/models
      if (!CREATOR_ROLES.includes(user.role)) throw new Error('Only directors can manage projects');
      const i = appState.projects.findIndex(x => x.id === p.id);
      const prevRecipes = i >= 0 ? JSON.stringify(appState.projects[i].recipes || {}) : null;
      if (i < 0 && !hasFullAccess(user.role)) throw new Error('Only administrators or project directors can create new projects');
      if (i >= 0 && !canAccessProject(user, p.id)) throw new Error('No access to this project');
      if (i >= 0) appState.projects[i] = p; else appState.projects.push(p);
      // a scoped creator must end up inside the scope of what they just created —
      // otherwise a project director creates a project and immediately loses sight
      // of it, since an unlisted project is out of scope by definition
      if (i < 0 && isProjectScoped(user.role)) {
        const me = usersDb.users.find(u => u.id === user.id);
        if (me && !(me.projectIds || []).includes(p.id)) {
          me.projectIds = [...(me.projectIds || []), p.id];
          saveUsers();
        }
      }
      // recipes ride on the project record, and a recipe edit silently moves every
      // future stock calculation — worth its own event rather than hiding inside
      // "project.updated"
      const before = i >= 0 ? prevRecipes : null;
      const after = JSON.stringify(p.recipes || {});
      bumpState();
      logConfig(i < 0 ? 'project.created' : 'project.updated',
        { kind: 'project', id: p.id, name: p.name || '' },
        { hasAddress: !!p.address, elements: p.summary?.elementCount ?? null,
          fileName: p.fileName || null, recipes: Object.keys(p.recipes || {}).length }, user);
      if (before !== null && before !== after) {
        logConfig('project.recipes.changed', { kind: 'project', id: p.id, name: p.name || '' },
          { groups: Object.keys(p.recipes || {}).length }, user);
      }
      sendJson(res, { ok: true, rev: appState.rev });
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    return true;
  }
  if (path.startsWith('/api/projects/') && req.method === 'DELETE') {
    if (!hasFullAccess(user.role)) { sendJson(res, { ok: false, error: 'Only administrators or project directors can delete projects' }, 403); return true; }
    const id = path.slice('/api/projects/'.length);
    // now that project directors are scoped, deleting has to respect that scope —
    // it did not before, because there was nothing to respect
    if (!canAccessProject(user, id)) { sendJson(res, { ok: false, error: 'No access to this project' }, 403); return true; }
    const goneProject = appState.projects.find(p => p.id === id);
    const lostOrders = appState.orders.filter(o => o.projectId === id).length;
    appState.projects = appState.projects.filter(p => p.id !== id);
    appState.orders = appState.orders.filter(o => o.projectId !== id);
    bumpState();
    logConfig('project.deleted', { kind: 'project', id, name: goneProject?.name || '' },
      { ordersRemoved: lostOrders }, user);
    sendJson(res, { ok: true, rev: appState.rev });
    return true;
  }
  if (path === '/api/parties' && req.method === 'POST') { // upsert by id
    if (!CREATOR_ROLES.includes(user.role)) { sendJson(res, { ok: false, error: 'Only directors can manage partners' }, 403); return true; }
    try {
      const body = JSON.parse(await readRawBody(req, 100_000));
      if (!body.id) throw new Error('Missing party id');
      // Built field by field, never `= body`. The previous version sanitised the fields
      // it knew about and then stored the whole posted object, so anything else the
      // caller invented was persisted too — and `type` in particular was free text that
      // the Partners table printed without escaping. A party type carrying markup became
      // stored XSS running in the session of whoever opened that screen, administrator
      // included. A whitelist is the only shape that cannot be extended by the caller.
      const p = { id: String(body.id).trim() };
      // An id is a key, not content — it addresses an EXISTING record. Nothing outside
      // this shape was ever minted by the client (`uid('p')`), so a loose id is how a
      // caller reaches for a record it had no business editing.
      if (!/^[A-Za-z0-9_-]{1,60}$/.test(p.id)) throw new Error('Invalid party id');
      p.name = String(body.name ?? '').replace(/[\r\n]/g, ' ').trim().slice(0, 120);
      p.type = PARTY_TYPES.includes(body.type) ? body.type : 'supplier';
      // the email field addresses outgoing mail, so it must be one clean address —
      // never a free-text blob that could smuggle extra recipients or headers
      p.email = String(body.email ?? '').trim();
      p.phone = String(body.phone ?? '').trim().replace(/[\r\n]/g, ' ');
      if (p.email && !EMAIL_RE.test(p.email)) throw new Error('Invalid email address');
      const body_nif = body.nif, body_address = body.address;
      // Identification for a transport document: both parties have to appear on it with
      // a tax number and an address. Kept as plain text, including the NIF — it is an
      // identifier to print, not a number to compute with, and a Portuguese NIF written
      // as a number would lose nothing today and everything the day a foreign VAT number
      // with letters arrives.
      p.nif = String(body_nif ?? '').trim().replace(/[\r\n]/g, ' ').slice(0, 30);
      p.address = String(body_address ?? '').replace(/\r/g, '').trim().slice(0, 300);
      // The AT wants the address in PARTS, not as one block: AddressDetail, City,
      // PostalCode and Country are separate fields and all four are mandatory on the
      // sender and on the loading place. Splitting a free-text address by guessing where
      // the postal code ends is exactly the kind of parsing that works on the examples and
      // fails on the twentieth real one, so they are asked for separately and the existing
      // free text stays as the detail line.
      //
      // No format check on the postal code: 4-3 is Portugal's shape, but a foreign
      // destination is a normal thing for a factory and a refused address helps nobody.
      p.city = String(body.city ?? '').replace(/[\r\n]/g, ' ').trim().slice(0, 80);
      p.postalCode = String(body.postalCode ?? '').replace(/[\r\n]/g, ' ').trim().slice(0, 20);
      p.country = String(body.country ?? 'PT').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 2) || 'PT';
      const i = appState.parties.findIndex(x => x.id === p.id);
      const before = i >= 0 ? appState.parties[i] : null;
      // The seeded records are infrastructure, not contacts. `p-gc` (type admin) is the
      // sender printed on every goods document with its NIF and address, and the email on
      // a `factory` record is where the guia is SENT. Because this upsert addresses a
      // record by a well-known id, any director — the encarregado included, by the parity
      // José chose — could re-point `p-fab` at another address, and every goods document
      // and order mail would follow it while the screen showed only a changed contact
      // column. So: changing what a partner IS, or touching the company's own record, is
      // the administrator's act. Maintaining a supplier's contact details stays everyone's.
      const isAdmin = user.role === 'admin';
      if (!isAdmin && before && before.type !== p.type) {
        throw new Error('Only an administrator can change what a partner is');
      }
      if (!isAdmin && (p.type === 'admin' || before?.type === 'admin')) {
        throw new Error('Only an administrator can edit the company record');
      }
      if (i >= 0) appState.parties[i] = p; else appState.parties.push(p);
      bumpState();
      // The address is what the mail follows, so the log records the CHANGE, not merely
      // that an address exists: `hasEmail: true` was true before and after a redirect.
      const changed = (k) => (before && (before[k] || '') !== (p[k] || ''))
        ? { from: before[k] || '', to: p[k] || '' } : undefined;
      logConfig(i >= 0 ? 'supplier.updated' : 'supplier.created',
        { kind: 'supplier', id: p.id, name: p.name || '' },
        { type: p.type || null, hasEmail: !!p.email, hasPhone: !!p.phone,
          emailChange: changed('email'), nifChange: changed('nif'),
          addressChange: changed('address') }, user);
      sendJson(res, { ok: true, rev: appState.rev });
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    return true;
  }
  if (path.startsWith('/api/parties/') && req.method === 'DELETE') {
    if (!CREATOR_ROLES.includes(user.role)) { sendJson(res, { ok: false, error: 'Only directors can manage partners' }, 403); return true; }
    const id = path.slice('/api/parties/'.length);
    const goneParty = appState.parties.find(p => p.id === id);
    appState.parties = appState.parties.filter(p => p.id !== id);
    bumpState();
    logConfig('supplier.deleted', { kind: 'supplier', id, name: goneParty?.name || '' },
      { type: goneParty?.type || null }, user);
    sendJson(res, { ok: true, rev: appState.rev });
    return true;
  }

  // ---------- component catalog & warehouse stock ----------
  // Catalog fields come from the client; every QUANTITY is server-managed and can
  // only change through /api/stock/move or the automatic consumption hook below.
  if (path === '/api/components' && req.method === 'POST') { // upsert by id
    if (!CREATOR_ROLES.includes(user.role)) { sendJson(res, { ok: false, error: 'Only directors can manage components' }, 403); return true; }
    try {
      const c = JSON.parse(await readBody(req));
      if (!c.id) throw new Error('Missing component id');
      const name = String(c.name || '').trim();
      if (!name) throw new Error('Component name is required');
      if (!UNITS.includes(c.unit)) throw new Error('Invalid unit');
      const minQty = c.minQty === null || c.minQty === undefined || c.minQty === ''
        ? null : Math.max(0, Number(c.minQty) || 0);
      // A minimum per factory, keyed by party id — the counterpart of minQty for the
      // balances held at each factory. Only keys that are real factory parties survive,
      // and an empty value REMOVES the key rather than storing a zero: "no minimum" and
      // "minimum of zero" are different answers, and only the first means "do not alert".
      const factoryIds = new Set(appState.parties.filter(p => p.type === 'factory').map(p => p.id));
      const factoryMinQty = {};
      for (const [fid, v] of Object.entries(c.factoryMinQty || {})) {
        if (!factoryIds.has(fid)) continue;
        if (v === null || v === undefined || v === '') continue;
        factoryMinQty[fid] = Math.max(0, Number(v) || 0);
      }
      // Warehouse descriptors, all optional. They come from the warehouse's own
      // sheet, where a reference is identified by whichever of them the person
      // holding it happens to know — the pallet most of all. Capped because an
      // import is the one path that writes many of these at once.
      const txt = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
      const fields = {
        name, ref: txt(c.ref, 80), unit: c.unit, minQty, factoryMinQty,
        type: TYPES.includes(c.type) ? c.type : '',
        size: txt(c.size, 60),
        standard: txt(c.standard, 60),
        brand: txt(c.brand, 60),
        location: txt(c.location, 60),
      };
      // Two references with the same name, medida AND localização are the same thing
      // entered twice, and the damage is quiet: the balance splits across two records
      // and "how many do we have" answers wrong until somebody notices. It cannot be
      // undone either — the duplicate gets an opening movement and then refuses to be
      // deleted, so the only remedy left is archiving one and living with the split.
      //
      // The identity is deliberately the SAME one the spreadsheet import uses, so a
      // reference typed by hand is recognised when that row later arrives in a sheet,
      // instead of being duplicated by the other door.
      //
      // Only the exact triple blocks. Name alone would refuse four legitimate groups in
      // this warehouse (four CHAPA PILARES ARRANQUE differing only in medida), and the
      // reference alone would refuse a fifth — one screw genuinely lives on two pallets.
      const clash = appState.components.find(x => x.id !== c.id && componentKey(x) === componentKey(fields));
      if (clash) {
        sendJson(res, {
          ok: false,
          error: `Já existe: ${clash.name}${clash.size ? ' · ' + clash.size : ''}${clash.location ? ' · ' + clash.location : ''}`,
          duplicateOf: { id: clash.id, name: clash.name },
        }, 409);
        return true;
      }
      const existing = appState.components.find(x => x.id === c.id);
      let component;
      if (existing) {
        component = Object.assign(existing, fields); // balances untouched
      } else {
        component = { id: c.id, ...fields, warehouseQty: 0, factoryQty: {}, consumedQty: 0, createdAt: new Date().toISOString() };
        appState.components.push(component);
      }
      bumpState();
      logConfig(existing ? 'component.updated' : 'component.created',
        { kind: 'component', id: component.id, name: component.name },
        { unit: component.unit, min: component.minQty ?? null, ref: component.ref || null }, user);
      sendJson(res, { ok: true, component, rev: appState.rev });
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    return true;
  }
  // Archiving — the answer for a reference that has history and therefore cannot be
  // deleted, which after a warehouse import is nearly the whole catalogue: booking
  // opening balances as real movements gives every reference a ledger from the first
  // minute. Archiving retires it from everything forward-looking and touches nothing
  // that already happened.
  //
  // It has its own endpoint rather than riding on the component save, so the edit form
  // cannot flip it by accident, and so a re-import — which writes descriptors through
  // that save — leaves the decision alone.
  if (path.startsWith('/api/components/') && path.endsWith('/archive') && req.method === 'POST') {
    if (!CREATOR_ROLES.includes(user.role)) { sendJson(res, { ok: false, error: 'Only directors can manage components' }, 403); return true; }
    const id = path.slice('/api/components/'.length, -'/archive'.length);
    const comp = appState.components.find(c => c.id === id);
    if (!comp) { sendJson(res, { ok: false, error: 'Component not found' }, 404); return true; }
    try {
      const { archived } = JSON.parse(await readBody(req));
      if (archived) {
        comp.archivedAt = new Date().toISOString();
        comp.archivedBy = user.username;
      } else {
        delete comp.archivedAt;
        delete comp.archivedBy;
      }
      bumpState();
      logConfig(archived ? 'component.archived' : 'component.unarchived',
        { kind: 'component', id: comp.id, name: comp.name },
        { warehouse: comp.warehouseQty, factories: Object.values(comp.factoryQty || {}).reduce((a, b) => a + b, 0) }, user);
      sendJson(res, { ok: true, component: scopedComponent(comp, stockScope(user)), rev: appState.rev });
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    return true;
  }
  if (path.startsWith('/api/components/') && req.method === 'DELETE') {
    if (!CREATOR_ROLES.includes(user.role)) { sendJson(res, { ok: false, error: 'Only directors can manage components' }, 403); return true; }
    const id = path.slice('/api/components/'.length);
    if (!appState.components.some(c => c.id === id)) { sendJson(res, { ok: false, error: 'Component not found' }, 404); return true; }
    // ledger integrity: a component with history or recipe references cannot vanish
    if (appState.stockMoves.some(m => m.componentId === id)) {
      sendJson(res, { ok: false, error: 'Component has stock movements and cannot be deleted' }, 400); return true;
    }
    if (appState.projects.some(p => Object.values(p.recipes || {}).some(rows => (rows || []).some(r => r.componentId === id)))) {
      sendJson(res, { ok: false, error: 'Component is used in an element recipe and cannot be deleted' }, 400); return true;
    }
    const goneComp = appState.components.find(c => c.id === id);
    appState.components = appState.components.filter(c => c.id !== id);
    bumpState();
    logConfig('component.deleted', { kind: 'component', id, name: goneComp?.name || '' },
      { warehouse: goneComp?.warehouseQty ?? null }, user);
    sendJson(res, { ok: true, rev: appState.rev });
    return true;
  }
  if (path === '/api/stock/move' && req.method === 'POST') {
    // directors move stock freely; the factory role may only record factory-floor
    // marks (manual use / defect / loss) against a factory balance
    const isCreator = CREATOR_ROLES.includes(user.role);
    if (!isCreator && !['factory', 'site'].includes(user.role)) { sendJson(res, { ok: false, error: 'Not allowed to move stock' }, 403); return true; }
    // a bound account may only ever touch its own destination, and an unbound one may
    // touch nothing — enforced here, not only by what the UI offers
    const scope = stockScope(user);
    if (scope.mode === 'none') { sendJson(res, { ok: false, error: 'This account is not linked to a factory yet — ask an administrator' }, 403); return true; }
    try {
      const { componentId, type, qty, factoryId, note } = JSON.parse(await readBody(req));
      if (scope.mode === 'factory' && factoryId !== scope.factoryId) {
        throw new Error('You can only move stock where your account is assigned');
      }
      const comp = appState.components.find(c => c.id === componentId);
      if (!comp) throw new Error('Component not found');
      // a bound account may also send leftovers back — it is giving stock up, not taking it
      if (!isCreator && !FACTORY_MARK_TYPES.includes(type) && type !== 'return') {
        sendJson(res, { ok: false, error: 'This role can only record use, defect, loss or a return' }, 403); return true;
      }
      const q = Number(qty);
      if (!Number.isFinite(q)) throw new Error('Invalid quantity');
      let target = null; // party id for factory-targeted moves
      if (type === 'in') {
        if (q <= 0) throw new Error('Quantity must be positive');
        comp.warehouseQty += q;
      } else if (type === 'send') {
        if (q <= 0) throw new Error('Quantity must be positive');
        const fac = stockDestination(factoryId);
        if (!fac) throw new Error('Unknown destination — must be a fabrication company or a site');
        // a send cannot exceed what the warehouse actually holds — register the entry first
        if (q > comp.warehouseQty) throw new Error('Insufficient warehouse stock');
        comp.warehouseQty -= q;
        comp.factoryQty[fac.id] = (comp.factoryQty[fac.id] || 0) + q;
        target = fac.id;
      } else if (type === 'return') {
        // leftovers coming back off the factory floor or the site. The mirror of a send,
        // and a real movement rather than two adjustments: "20 came back from the factory" is
        // a fact somebody may need to explain later, and a pair of corrections is not.
        if (q <= 0) throw new Error('Quantity must be positive');
        const fac = stockDestination(factoryId);
        if (!fac) throw new Error('Unknown origin');
        const held = comp.factoryQty[fac.id] || 0;
        if (q > held) throw new Error(`Only ${held} ${comp.unit} at ${fac.name}`);
        comp.factoryQty[fac.id] = held - q;
        comp.warehouseQty += q;
        target = fac.id;
      } else if (type === 'adjust') {
        if (q === 0) throw new Error('Quantity must not be zero');
        if (factoryId) {
          const fac = stockDestination(factoryId);
          if (!fac) throw new Error('Unknown destination');
          comp.factoryQty[fac.id] = (comp.factoryQty[fac.id] || 0) + q; // corrections may go negative
          target = fac.id;
        } else {
          comp.warehouseQty += q;
        }
      } else if (FACTORY_MARK_TYPES.includes(type)) {
        // Manual consumption / defect / loss, recorded wherever the stock actually is —
        // a factory floor or a site. Material delivered to a site used to enter the
        // balance and never leave it: nobody could say it had been fixed, so the site
        // balance only ever grew.
        if (q <= 0) throw new Error('Quantity must be positive');
        const fac = stockDestination(factoryId);
        if (!fac) throw new Error('Unknown destination');
        comp.factoryQty[fac.id] = (comp.factoryQty[fac.id] || 0) - q; // deduct — may go negative
        if (type === 'use') comp.consumedQty += q; // manual use counts as consumed
        target = fac.id;
      } else {
        // 'consume' is produced exclusively by the order-PUT hook — never by clients
        sendJson(res, { ok: false, error: 'Invalid movement type' }, 403); return true;
      }
      const move = {
        id: 'mv-' + randomUUID().slice(0, 8), ts: new Date().toISOString(),
        componentId, type, qty: q, factoryId: target,
        orderId: null, orderCode: null, projectId: null,
        by: user.username, note: String(note || '').trim(),
      };
      appState.stockMoves.push(move);
      bumpState();
      logStockMove(move, comp, user);
      sendJson(res, { ok: true, component: scopedComponent(comp, scope), move, rev: appState.rev });
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    return true;
  }
  // Sending many references to a factory in one act — a delivery to the factory is a
  // pallet with twenty lines on it, not twenty separate decisions.
  //
  // It exists as its own endpoint, rather than the client calling /api/stock/move
  // twenty times, for one reason: **all of it lands or none of it does**. Twenty calls
  // means that when line 14 asks for more than the warehouse holds, thirteen
  // references are already recorded as gone and the truck disagrees with the ledger.
  // So every line is checked — against a running total, so two lines for the same
  // reference cannot each pass on the same units — and only then is anything written.
  if (path === '/api/stock/send-batch' && req.method === 'POST') {
    if (!CREATOR_ROLES.includes(user.role)) { sendJson(res, { ok: false, error: 'Not allowed to move stock' }, 403); return true; }
    try {
      const { factoryId, note, lines, plate, departAt, guiaNumber, atCode, communicateAt, movementType } = JSON.parse(await readBody(req));
      const fac = stockDestination(factoryId);
      if (!fac) throw new Error('Unknown destination — must be a fabrication company or a site');
      if (!Array.isArray(lines) || !lines.length) throw new Error('Nothing to send');
      if (lines.length > 500) throw new Error('Too many lines in one send');

      // same reference twice is one demand on the same units, so add it up first
      const wanted = new Map();
      for (const l of lines) {
        const q = Number(l.qty);
        if (!Number.isFinite(q) || q <= 0) throw new Error('Quantity must be positive');
        wanted.set(l.componentId, (wanted.get(l.componentId) || 0) + q);
      }
      const planned = [];
      for (const [componentId, qty] of wanted) {
        const comp = appState.components.find(c => c.id === componentId);
        if (!comp) throw new Error('Component not found');
        if (qty > comp.warehouseQty) {
          throw new Error(`${comp.name}: only ${comp.warehouseQty} ${comp.unit} in the warehouse, ${qty} requested`);
        }
        planned.push({ comp, qty });
      }

      const stamp = new Date().toISOString();
      const cleanNote = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      // Transport details ride on every line of the batch. They belong to the shipment,
      // not to the component — but the shipment is not an entity here: it is exactly the
      // set of movements sharing one timestamp and one factory. Storing them per line
      // keeps the guia reprintable from the ledger without inventing a second record
      // that could disagree with it.
      const cleanPlate = String(plate || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 15);
      const departure = !isNaN(Date.parse(departAt || '')) ? new Date(departAt).toISOString() : '';
      const guia = cleanGuiaRef({ guiaNumber, atCode });
      const moves = [];
      for (const { comp, qty } of planned) {
        comp.warehouseQty -= qty;
        comp.factoryQty[fac.id] = (comp.factoryQty[fac.id] || 0) + qty;
        const move = {
          id: 'mv-' + randomUUID().slice(0, 8), ts: stamp,
          componentId: comp.id, type: 'send', qty, factoryId: fac.id,
          orderId: null, orderCode: null, projectId: null,
          by: user.username, note: cleanNote,
          ...(cleanPlate ? { plate: cleanPlate } : {}),
          ...(departure ? { departAt: departure } : {}),
          ...guia,
        };
        appState.stockMoves.push(move);
        moves.push(move);
      }
      bumpState();
      // each line is logged on its own: the balances and the reversals are per
      // component, so the history has to be too
      for (const m of moves) logStockMove(m, planned.find(p => p.comp.id === m.componentId).comp, user, { batch: moves.length });

      // Communicating is attempted AFTER the movements are committed, and its failure is
      // reported alongside a successful send rather than turning the whole call into an
      // error. The stock did move; refusing to admit that because the AT was unreachable
      // would leave the warehouse and the shelf disagreeing.
      let at = null;
      if (communicateAt) {
        try {
          at = { ok: true, ...(await communicateShipment({ ts: stamp, factoryId: fac.id, movementType: movementType || 'GT', user })) };
        } catch (e) {
          at = { ok: false, error: e.message };
        }
      }
      sendJson(res, {
        ok: true,
        moves: shipmentMoves(stamp, fac.id), // re-read: communicating stamps them
        components: planned.map(p => scopedComponent(p.comp, stockScope(user))),
        at,
        rev: appState.rev,
      });
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    return true;
  }
  // reverse a manual movement (estorno): applies the exact inverse and keeps BOTH
  // entries in the ledger, cross-linked — audit-friendly, unlike a silent adjust
  if (path === '/api/stock/reverse' && req.method === 'POST') {
    const isCreator = CREATOR_ROLES.includes(user.role);
    // 'site' belongs here for the same reason it belongs in /api/stock/move: a site crew
    // records what it fixed and must be able to undo its own mistake. It was left out
    // when marks were opened to sites, so the client drew an estorno button that the
    // server answered with 403.
    if (!isCreator && !['factory', 'site'].includes(user.role)) { sendJson(res, { ok: false, error: 'Not allowed to move stock' }, 403); return true; }
    const scope = stockScope(user);
    if (scope.mode === 'none') { sendJson(res, { ok: false, error: 'This account is not linked to a factory yet — ask an administrator' }, 403); return true; }
    try {
      const { moveId } = JSON.parse(await readBody(req));
      const m = appState.stockMoves.find(x => x.id === moveId);
      if (!m) throw new Error('Movement not found');
      // undoing is still a write against a factory's balance, so it obeys the same
      // boundary as making the movement in the first place
      if (scope.mode === 'factory' && m.factoryId !== scope.factoryId) {
        throw new Error('You can only reverse movements where your account is assigned');
      }
      if (m.type === 'consume') throw new Error('Automatic consumption cannot be reversed');
      if (m.type === 'reverse') throw new Error('A reversal cannot be reversed');
      if (m.reversedBy) throw new Error('Movement already reversed');
      // the factory role may only undo its OWN factory-floor marks
      if (!isCreator) {
        if (!FACTORY_MARK_TYPES.includes(m.type) && m.type !== 'return') throw new Error('This role can only reverse its own marks and returns');
        if (m.by !== user.username) throw new Error('You can only reverse your own movements');
      }
      const comp = appState.components.find(c => c.id === m.componentId);
      if (!comp) throw new Error('Component not found');
      if (m.type === 'in') {
        comp.warehouseQty -= m.qty;
      } else if (m.type === 'return') {
        comp.warehouseQty -= m.qty;
        comp.factoryQty[m.factoryId] = (comp.factoryQty[m.factoryId] || 0) + m.qty;
      } else if (m.type === 'send') {
        comp.factoryQty[m.factoryId] = (comp.factoryQty[m.factoryId] || 0) - m.qty;
        comp.warehouseQty += m.qty;
      } else if (m.type === 'adjust') {
        if (m.factoryId) comp.factoryQty[m.factoryId] = (comp.factoryQty[m.factoryId] || 0) - m.qty;
        else comp.warehouseQty -= m.qty;
      } else if (FACTORY_MARK_TYPES.includes(m.type)) {
        comp.factoryQty[m.factoryId] = (comp.factoryQty[m.factoryId] || 0) + m.qty; // give the units back
        if (m.type === 'use') comp.consumedQty -= m.qty;
      }
      const move = {
        id: 'mv-' + randomUUID().slice(0, 8), ts: new Date().toISOString(),
        componentId: m.componentId, type: 'reverse', qty: m.qty, factoryId: m.factoryId || null,
        orderId: null, orderCode: null, projectId: null, reversedId: m.id,
        by: user.username, note: '',
      };
      m.reversedBy = move.id;
      appState.stockMoves.push(move);
      bumpState();
      logStockMove(move, comp, user, { reverses: m.id });
      sendJson(res, { ok: true, component: scopedComponent(comp, scope), move, rev: appState.rev });
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    return true;
  }

  // ---------- warehouse import (inventory spreadsheet) ----------
  // Administrator only, and deliberately so: this is the single endpoint that can
  // create a hundred references and their opening balances in one act. The
  // authority for it is the warehouse's own inventory sheet, which is not a
  // document the flow roles hold.
  //
  // It runs twice over the SAME upload. The first pass writes nothing and returns
  // a plan, so the person importing sees what is about to happen — what is new,
  // what already exists, which rows the sheet could not answer for. Only a second
  // call with ?commit=1 applies it. Re-uploading is cheap; guessing is not.
  if (path === '/api/stock/import' && req.method === 'POST') {
    if (user.role !== 'admin') { sendJson(res, { ok: false, error: 'Only the administrator can import stock' }, 403); return true; }
    try {
      const buf = await readRawBody(req, 8 * 1024 * 1024);
      if (!buf.length) throw new Error('Empty file');
      const plan = planStockImport(readWorkbook(buf), appState.components);
      if (new URL(req.url, 'http://x').searchParams.get('commit') !== '1') {
        sendJson(res, { ok: true, plan });
        return true;
      }

      const stamp = new Date().toISOString();
      let created = 0, updated = 0, opening = 0;
      for (const it of plan.items) {
        const fields = {
          name: it.name, ref: it.ref, unit: it.unit,
          type: it.type, size: it.size, standard: it.standard, brand: it.brand, location: it.location,
        };
        if (it.action === 'update') {
          const existing = appState.components.find(c => c.id === it.id);
          // descriptors only. What the warehouse HOLDS is the ledger's answer, not
          // the sheet's: a second import must never silently restate a balance
          // that movements have since changed.
          //
          // AND it must not restate an answer a PERSON gave. `type` and `unit` are
          // curated in the app — the whole "an unset field asks to be answered"
          // workflow — and the sheet has no opinion on either: mapType returns '' for
          // any family outside the closed table, and the reader defaults unit to 'un'
          // for an ordinary numeric cell. Assigning them back over a curated value
          // meant every re-import wiped the classification work, and in the case of
          // unit silently reinterpreted every stored quantity for that reference.
          //
          // So they FILL, they never overwrite: type only when the sheet resolved one
          // and nothing is stored, unit only when the cell actually named a unit.
          if (existing) {
            const { type: sheetType, unit: sheetUnit, ...plain } = fields;
            Object.assign(existing, plain);
            if (sheetType && !existing.type) existing.type = sheetType;
            if (it.unitStated) existing.unit = sheetUnit;
            // a reference created by hand and matched here keeps no import key, so the
            // next edit to its descriptors makes the sheet stop recognising it and
            // create a duplicate. Writing it now closes that door.
            if (!existing.importKey && it.importKey) existing.importKey = it.importKey;
            updated++;
          }
          continue;
        }
        const comp = {
          id: 'cmp-' + randomUUID().slice(0, 8), ...fields,
          importKey: it.importKey, // which sheet row created it — see planStockImport
          minQty: null, factoryMinQty: {},
          warehouseQty: 0, factoryQty: {}, consumedQty: 0, createdAt: stamp,
        };
        appState.components.push(comp);
        created++;
        // the opening balance enters as a real movement, like every other unit in
        // the warehouse — a balance nothing explains is a balance nobody trusts
        if (it.qty > 0) {
          comp.warehouseQty = it.qty;
          appState.stockMoves.push({
            id: 'mv-' + randomUUID().slice(0, 8), ts: stamp,
            componentId: comp.id, type: 'in', qty: it.qty, factoryId: null,
            orderId: null, orderCode: null, projectId: null,
            by: user.username, note: 'Inventário inicial (importação)',
          });
          opening++;
        }
      }
      bumpState();
      logConfig('stock.imported', { kind: 'state' },
        { created, updated, opening, skipped: plan.skipped.length }, user);
      sendJson(res, { ok: true, applied: { created, updated, opening, skipped: plan.skipped.length }, rev: appState.rev });
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    return true;
  }

    // ---------- procurement (encomendas a fornecedores) ----------
  // The supply side of the site's control table: each purchase order tracks a
  // component bought from a supplier/fabrication company through
  // adjudicado → faturado → entregue. Delivery is the bridge to the physical
  // stock: it records the warehouse 'in' movement itself, so the ledger and the
  // procurement history can never disagree. Director-level, like stock moves.
  if (path === '/api/procurement' && req.method === 'POST') {
    if (!CREATOR_ROLES.includes(user.role)) { sendJson(res, { ok: false, error: 'Only directors can manage procurement' }, 403); return true; }
    try {
      const { supplierId, note, lines } = JSON.parse(await readRawBody(req, 500_000));
      const sup = appState.parties.find(p => p.id === supplierId && ['supplier', 'factory'].includes(p.type));
      if (!sup) throw new Error('Unknown supplier');
      if (!Array.isArray(lines) || !lines.length) throw new Error('A purchase order needs at least one line');
      if (lines.length > 200) throw new Error('Too many lines for one purchase order');
      // The same reference twice in one order is a mistake worth refusing, not merging:
      // merging silently changes the quantity somebody typed, and refusing takes one
      // second to fix. Receiving is per line, so two lines for one reference would also
      // mean two places to book the same goods.
      const seen = new Set();
      const built = lines.map((l) => {
        const comp = appState.components.find(c => c.id === l.componentId);
        if (!comp) throw new Error('Component not found');
        if (seen.has(comp.id)) throw new Error(`${comp.name} is on the order twice — put the whole quantity on one line`);
        seen.add(comp.id);
        const q = Number(l.qty);
        if (!(q > 0)) throw new Error(`Quantity for ${comp.name} must be greater than zero`);
        return {
          id: 'pol-' + randomUUID().slice(0, 8),
          componentId: comp.id, qty: q,
          qtyReceived: 0, receivedAt: null, receivedBy: null,
          note: String(l.note || '').trim().slice(0, 200),
        };
      });
      const po = {
        id: 'po-' + randomUUID().slice(0, 8),
        supplierId: sup.id, lines: built,
        note: String(note || '').trim().slice(0, 500),
        status: 'awarded', awardedAt: new Date().toISOString(), by: user.username,
      };
      appState.procurement.push(po);
      bumpState();
      for (const line of built) logProcurement('procurement.awarded', po, user, line);
      sendJson(res, { ok: true, po, rev: appState.rev });
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    return true;
  }
  if (path === '/api/procurement/advance' && req.method === 'POST') {
    if (!CREATOR_ROLES.includes(user.role)) { sendJson(res, { ok: false, error: 'Only directors can manage procurement' }, 403); return true; }
    try {
      const { id } = JSON.parse(await readBody(req));
      const po = appState.procurement.find(x => x.id === id);
      if (!po) throw new Error('Purchase order not found');
      // This endpoint now marks the INVOICE and nothing else. Delivery moved to
      // /receive, because delivery is a fact about a line — the goods for one reference
      // arriving — and pretending it was a fact about the whole order is what stopped a
      // part-delivered order from being recordable at all.
      if (po.invoicedAt) throw new Error('This purchase order is already invoiced');
      po.invoicedAt = new Date().toISOString();
      po.status = poStatus(po);
      bumpState();
      logProcurement('procurement.invoiced', po, user, po.lines?.[0] || null);
      sendJson(res, { ok: true, po, rev: appState.rev });
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    return true;
  }
  // Receiving one line — the act that moves physical stock, so it is the one that books
  // the warehouse entry. A partial quantity is allowed on purpose: a supplier sending 80
  // of 100 is ordinary, and forcing it to be recorded as 100 would put a number in the
  // warehouse that is not on the shelf.
  if (path === '/api/procurement/receive' && req.method === 'POST') {
    if (!CREATOR_ROLES.includes(user.role)) { sendJson(res, { ok: false, error: 'Only directors can manage procurement' }, 403); return true; }
    try {
      const { id, lineId, qty } = JSON.parse(await readBody(req));
      const po = appState.procurement.find(x => x.id === id);
      if (!po) throw new Error('Purchase order not found');
      const line = (po.lines || []).find(l => l.id === lineId);
      if (!line) throw new Error('Line not found');
      const outstanding = poOutstanding(line);
      if (outstanding <= 0) throw new Error('This line has already been received in full');
      const comp = appState.components.find(c => c.id === line.componentId);
      if (!comp) throw new Error('Component no longer exists');
      // blank means "all of what is still owed" — the common case, one click
      const q = qty === undefined || qty === null || qty === '' ? outstanding : Number(qty);
      if (!(q > 0)) throw new Error('Quantity must be greater than zero');
      // Receiving more than was ordered is refused rather than absorbed. If the supplier
      // really sent more, that is a second act: a warehouse entry or an adjustment, and
      // it should not hide inside an order that then reads as if it had been correct.
      if (q > outstanding) throw new Error(`Only ${outstanding} still outstanding on this line`);
      const ts = new Date().toISOString();
      line.qtyReceived = (Number(line.qtyReceived) || 0) + q;
      line.receivedBy = user.username;
      if (poOutstanding(line) === 0) line.receivedAt = ts;
      // the receipt IS the warehouse entry — one act, recorded in both ledgers
      comp.warehouseQty += q;
      const move = {
        id: 'mv-' + randomUUID().slice(0, 8), ts,
        componentId: comp.id, type: 'in', qty: q, factoryId: null,
        orderId: null, orderCode: null, projectId: null,
        by: user.username, note: `Encomenda ${po.id} — ${(appState.parties.find(p => p.id === po.supplierId) || {}).name || ''}`.trim(),
      };
      appState.stockMoves.push(move);
      po.status = poStatus(po);
      if (po.status === 'delivered' && !po.deliveredAt) po.deliveredAt = ts;
      bumpState();
      logStockMove(move, comp, user, { source: 'procurement', poId: po.id });
      logProcurement('procurement.received', po, user, line);
      // the move goes back too, so the ledger on screen gains the entry without waiting
      // for a full refresh — the same contract /api/stock/move already has
      sendJson(res, { ok: true, po, component: scopedComponent(comp, stockScope(user)), move, rev: appState.rev });
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    return true;
  }
  if (path.startsWith('/api/procurement/') && req.method === 'DELETE') {
    if (!CREATOR_ROLES.includes(user.role)) { sendJson(res, { ok: false, error: 'Only directors can manage procurement' }, 403); return true; }
    const id = path.slice('/api/procurement/'.length);
    const po = appState.procurement.find(x => x.id === id);
    if (!po) { sendJson(res, { ok: false, error: 'Purchase order not found' }, 404); return true; }
    // An order that has received ANY goods already moved physical stock — cancel via a
    // stock adjust, not deletion. The old test was `status === 'delivered'`, which a
    // part-received order now passes: deleting one would leave entries in the ledger
    // pointing at an order that no longer exists.
    if ((po.lines || []).some(l => (l.qtyReceived || 0) > 0)) {
      sendJson(res, { ok: false, error: 'This purchase order has already received goods and cannot be deleted' }, 400);
      return true;
    }
    appState.procurement = appState.procurement.filter(x => x.id !== id);
    bumpState();
    sendJson(res, { ok: true, rev: appState.rev });
    return true;
  }

  if (path === '/api/orders' && req.method === 'POST') { // create — the server assigns the code
    try {
      const o = JSON.parse(await readRawBody(req, 5 * 1024 * 1024));
      if (!o.id) throw new Error('Missing order id');
      if (!CREATOR_ROLES.includes(user.role)) throw new Error('Only project or site directors can create production requests');
      if (!canAccessProject(user, o.projectId)) throw new Error('No access to this project');
      o.code = 'PR-' + String(appState.seq).padStart(4, '0');
      o.stockConsumed = {}; // server-managed from birth — new orders never grandfather
      // A request is born in draft and walks the flow from there. The status was
      // taken from the payload, so a creator could post one already "installed" and
      // skip every gate (shop drawings, JIT slot, quality) and every event the log
      // depends on. The client has always sent 'draft'; now the server insists.
      o.status = 'draft';
      o.orderRev = 0;       // the version line starts here, never at a client value
      sanitizeInspectionPhotos(o);
      appState.seq += 1;
      appState.orders.push(o);
      bumpState();
      logEvent('order.created', {
        actor: actorOf(user), subject: subjectOf(o),
        decision: {
          supplierId: o.supplierId || null, jitDate: o.needBy || null,
          elements: (o.items || []).reduce((s, i) => s + (Number(i.qty) || 0), 0),
          items: (o.items || []).length, zoneId: o.zoneId || null,
        },
        context: decisionContext(o),
      });
      sendJson(res, { ok: true, order: o, rev: appState.rev });
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    return true;
  }
  if (path.startsWith('/api/orders/') && req.method === 'DELETE') {
    const id = path.slice('/api/orders/'.length);
    const order = appState.orders.find(o => o.id === id);
    if (!order) { sendJson(res, { ok: false, error: 'Order not found' }, 404); return true; }
    // deleting a request is a director-level action (foremen operate the flow only)
    if (!CREATOR_ROLES.includes(user.role) || !canAccessProject(user, order.projectId)) {
      sendJson(res, { ok: false, error: 'Not allowed to delete this request' }, 403); return true;
    }
    // once the factory has accepted it the request is a real commitment: components
    // get consumed against it, elements are physically made and the ledger keeps
    // orderId references. Deleting then would erase the audit trail of things that
    // exist — only requests that never started can be removed.
    if (!DELETABLE_STATUSES.has(order.status)) {
      if (!isAdmin(user.role)) {
        sendJson(res, { ok: false, error: 'A request already accepted by the factory cannot be deleted' }, 400); return true;
      }
      // the administrator may still remove it — the request is gone, so the only
      // possible record of the act is the server log
      console.log(`[override] ${user.username} deleted ${order.code} in status "${order.status}"`);
    }
    const delCtx = decisionContext(order);
    appState.orders = appState.orders.filter(o => o.id !== id);
    bumpState();
    logEvent('order.deleted', {
      actor: actorOf(user), subject: subjectOf(order), context: delCtx,
      decision: { status: order.status },
      ...(DELETABLE_STATUSES.has(order.status) ? {} : { overrides: ['Deleted after the request had started'] }),
    });
    sendJson(res, { ok: true, rev: appState.rev });
    return true;
  }
  if (path.startsWith('/api/orders/') && req.method === 'PUT') { // replace (status, events, NCs)
    try {
      const id = path.slice('/api/orders/'.length);
      const existing = appState.orders.find(x => x.id === id);
      if (!existing) throw new Error('Order not found');
      // project-scoped roles (GC + factory + site) may only touch orders within
      // their assigned projects; logistics/quality act across every project
      if (!canAccessProject(user, existing.projectId)) throw new Error('No access to this project');
      const o = JSON.parse(await readRawBody(req, 5 * 1024 * 1024));
      // Optimistic concurrency on a per-order version. The old guard compared
      // events.length, which silently LOST data whenever two people each appended
      // one entry: both payloads carried the same count, so neither looked stale and
      // the second overwrote the first (quality's inspection erasing a director's
      // non-conformity, both reported as saved). The client echoes back the orderRev
      // it loaded; anything not matching the stored one is a genuine conflict.
      // An offline replay (field scans recorded without coverage) is deliberately
      // exempt: its version is stale by definition, so it keeps the older
      // events-count heuristic. Everything else must match the stored version
      // exactly — a missing version counts as 0, never as "skip the check".
      const storedRev = existing.orderRev || 0;
      const stale = o.offlineReplay
        ? (o.events?.length || 0) < (existing.events?.length || 0)
        : (o.orderRev ?? 0) !== storedRev;
      if (stale) {
        sendJson(res, { ok: false, error: 'conflict: this request changed on the server', conflict: true, rev: appState.rev }, 409);
        return true;
      }
      delete o.offlineReplay;     // a transport flag, never part of the record
      o.orderRev = storedRev + 1; // server owns the version — clients never set it
      // Identity and provenance belong to the server, not to the payload. This is a
      // FULL replace, so every field the client sends is written — which meant a
      // rewritten projectId moved the request into another project entirely, and the
      // access check above had already run against the OLD value. The code and the
      // creation date are equally not the client's to restate.
      for (const f of IMMUTABLE_ORDER_FIELDS) o[f] = existing[f];

      // The trails are append-only, and the server owns them.
      //
      // This PUT is a full replace guarded only by project access, so everything the
      // client sends is written. Every other guard here polices moving FORWARD — an
      // unknown status, an actor who may not make a transition, a count of validated
      // non-conformities going UP. Nothing policed going backwards. A factory account
      // on the project — or any quality/logistics account, which reach every project —
      // could PUT the order back with `nonConformities: []` and a trimmed `events`, and
      // the finding raised against it, plus the record that it ever existed, was gone.
      // Deleting was never checked because only increases were.
      //
      // The merge below never shortens and never rewrites: the stored trail is the
      // base, and anything the client carries that is not already in it is appended.
      // A merge rather than a refusal because of the offline path — a device replaying
      // scans has an older list by definition, and refusing it would break a flow that
      // exists precisely for bad coverage. Merging keeps both sides' entries.
      const sameEvent = (a, b) => a.ts === b.ts && a.actor === b.actor && a.action === b.action;
      const baseEvents = existing.events || [];
      o.events = [
        ...baseEvents,
        ...(o.events || []).filter(e => !baseEvents.some(b => sameEvent(b, e))),
      ];
      // A non-conformity's status legitimately changes (open → repaired → validated), so
      // entries are not frozen — but one can never disappear, and who raised it and when
      // are not the client's to rewrite.
      const baseNcs = existing.nonConformities || [];
      const sentNcs = Array.isArray(o.nonConformities) ? o.nonConformities : [];
      o.nonConformities = [
        ...baseNcs.map((nc) => {
          const sent = sentNcs.find(x => x.id === nc.id);
          return sent ? { ...sent, id: nc.id, ts: nc.ts, actor: nc.actor } : nc;
        }),
        ...sentNcs.filter(x => !baseNcs.some(nc => nc.id === x.id)),
      ];
      // An inspection already recorded cannot be un-recorded. `inspections` is an ARRAY
      // (store.js pushes onto it), so it merges like the events do — spreading it into
      // an object literal would turn it into {0:…,1:…} and the `for…of` in
      // sanitizeInspectionPhotos would throw on the very next save.
      const baseIns = Array.isArray(existing.inspections) ? existing.inspections : [];
      const sentIns = Array.isArray(o.inspections) ? o.inspections : [];
      const sameIns = (a, b) => a.ts === b.ts && a.actor === b.actor && a.gate === b.gate;
      o.inspections = [...baseIns, ...sentIns.filter(i => !baseIns.some(b => sameIns(b, i)))];

      sanitizeInspectionPhotos(o);
      // a genuine status change must come from someone allowed to act on the CURRENT status
      if (o.status !== existing.status) {
        // an unknown status would sit outside every gate and every actor table,
        // so the request could never be acted on again by anyone
        if (!VALID_STATUSES.has(o.status)) throw new Error('Unknown status');
        if (!hasFullAccess(user.role)) {
          const allowedActors = STATUS_ACTORS[existing.status] || [];
          if (!allowedActors.includes(user.role)) throw new Error(`Your role cannot move this request out of "${existing.status}"`);
        }
      }
      // signing off a repaired non-conformity is site management's act — it is what
      // closes the quality loop, so it cannot be forged by whoever did the repair
      const validatedCount = (list) => (list || []).filter(nc => nc.status === 'validated').length;
      if (validatedCount(o.nonConformities) > validatedCount(existing.nonConformities)
          && !NC_VALIDATOR_ROLES.includes(user.role)) {
        throw new Error('Only site management can validate a repaired non-conformity');
      }
      // The three rules below describe physical reality, not permissions, so they
      // apply to every role — except the administrator, who is the escape hatch for
      // when reality and the model disagree. Each override is written into the
      // request's own history: total power, never silent.
      const overrides = [];
      const override = (note) => {
        overrides.push(note);
        o.events = [...(o.events || []), {
          ts: new Date().toISOString(), actor: user.role,
          action: '🔓 Administrator override', note,
        }];
        console.log(`[override] ${user.username} on ${existing.code}: ${note}`);
      };
      // fabrication cannot start before the Project Director has validated the
      // shop drawings — the engineering approval from the site's control table
      if (existing.status === 'accepted' && o.status === 'production'
          && !SD_CLEARED.has(o.shopDrawings?.status)) {
        if (!isAdmin(user.role)) throw new Error('Shop drawings must be validated before production can start');
        override('Production started without validated shop drawings');
      }
      // and validating them is the Project Director's act — it cannot be forged
      // by the factory that drew them
      if (o.shopDrawings?.status === 'validated' && existing.shopDrawings?.status !== 'validated'
          && !SD_VALIDATOR_ROLES.includes(user.role)) {
        throw new Error('Only the project director can validate shop drawings');
      }
      // one truck at a time: a new load cannot leave the factory while the
      // previous one is still on the road — it must be delivered first
      if ((o.shipments?.length || 0) > (existing.shipments?.length || 0)
          && (existing.shipments || []).some(s => s.status === 'transit')) {
        if (!isAdmin(user.role)) throw new Error('A load is still in transit — mark it delivered before sending the next one');
        override('Second load dispatched while one was still in transit');
      }
      // dispatch commits logistics/site to a firm slot: the binding JIT date+time
      // must be set before anything leaves the factory (the client modal enforces
      // this too, but a business rule this central cannot live only in the UI)
      if (existing.status === 'ready' && o.status === 'transit'
          && !(String(o.needBy || '').trim() && String(o.needByTime || '').trim())) {
        if (!isAdmin(user.role)) throw new Error('A binding JIT date and time are required to dispatch this request');
        override('Dispatched without a binding JIT date and time');
      }
      // re-find AFTER the body await: the consumption baseline must be the order as
      // stored NOW — two interleaved PUTs diffed against the pre-await `existing`
      // would both see the same stale baseline and deduct stock twice
      const i = appState.orders.findIndex(x => x.id === id);
      if (i < 0) throw new Error('Order not found'); // deleted while the body streamed in
      applyStockConsumption(appState.orders[i], o, user);
      // context BEFORE the write: what the decider could know, not what their own
      // action then made true
      const ctx = decisionContext(existing);
      appState.orders[i] = o;
      bumpState();
      logOrderChange(existing, o, user, ctx, overrides);
      sendJson(res, { ok: true, rev: appState.rev, orderRev: o.orderRev });
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    return true;
  }

  // IFC model storage: PUT/GET/DELETE /api/ifc/<projectId> → models/<projectId>.ifc
  // Replaced models are archived as models/<id>.v<timestamp>.ifc (last 5 kept) —
  // information-container versioning in the spirit of ISO 19650.
  if (path.startsWith('/api/ifc/')) {
    const rest = path.slice('/api/ifc/'.length);
    const wantsVersions = rest.endsWith('/versions');
    const id = (wantsVersions ? rest.slice(0, -'/versions'.length) : rest).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!id) { sendJson(res, { ok: false, error: 'Bad project id' }, 400); return true; }
    const file = join(MODELS_DIR, id + '.ifc');
    if (wantsVersions && req.method === 'GET') {
      if (!canAccessProject(user, id)) { sendJson(res, { ok: false, error: 'No access to this project' }, 403); return true; }
      const versions = await listIfcVersions(id);
      sendJson(res, { ok: true, versions });
      return true;
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      // uploading/replacing models is a director-level action (foremen excluded)
      if (!CREATOR_ROLES.includes(user.role) || !canAccessProject(user, id)) { sendJson(res, { ok: false, error: 'Only directors can manage models' }, 403); return true; }
      try {
        const buf = await readRawBody(req, MAX_IFC_BYTES);
        await mkdir(MODELS_DIR, { recursive: true });
        await archiveIfcVersion(id, file); // never destroy the previous model silently
        await writeFile(file, buf);
        console.log(`[models] stored ${id}.ifc (${(buf.length / 1024).toFixed(0)} KB)`);
        logConfig('model.uploaded', { kind: 'project', id }, { bytes: buf.length }, user);
        sendJson(res, { ok: true, size: buf.length });
      } catch (e) {
        sendJson(res, { ok: false, error: e.message }, e.message === 'File too large' ? 413 : 500);
      }
      return true;
    }
    if (req.method === 'GET') {
      // project-scoped roles only fetch models for their assigned projects;
      // quality/logistics may fetch any model
      if (!canAccessProject(user, id)) { sendJson(res, { ok: false, error: 'No access to this project' }, 403); return true; }
      try {
        const data = await readFile(file);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(data);
      } catch { res.writeHead(404); res.end(); }
      return true;
    }
    if (req.method === 'DELETE') {
      if (!CREATOR_ROLES.includes(user.role) || !canAccessProject(user, id)) { sendJson(res, { ok: false, error: 'Only directors can manage models' }, 403); return true; }
      try { await unlink(file); } catch { /* already gone */ }
      try { // archived versions go with the project
        for (const f of (await readdir(MODELS_DIR)).filter(x => x.startsWith(id + '.v') && x.endsWith('.ifc'))) {
          await unlink(join(MODELS_DIR, f));
        }
      } catch { /* best effort */ }
      sendJson(res, { ok: true });
      return true;
    }
  }
  // ---------- training log (administrator only) ----------
  if (path === '/api/training/summary') {
    if (!isAdmin(user.role)) { sendJson(res, { ok: false, error: 'admin only' }, 403); return true; }
    const files = await listLogFiles();
    sendJson(res, {
      ok: true, dir: trainingDir(),
      files: files.map(f => ({ name: f.name, size: f.size })),
      bytes: files.reduce((s, f) => s + f.size, 0),
    });
    return true;
  }
  if (path === '/api/training/export') {
    if (!isAdmin(user.role)) { sendJson(res, { ok: false, error: 'admin only' }, 403); return true; }
    const files = await listLogFiles();
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="twinflow-training-${new Date().toISOString().slice(0, 10)}.jsonl"`,
      'Cache-Control': 'no-store',
    });
    // streamed, not buffered: this file is meant to grow without bound
    for (const f of files) {
      try { res.write(await readFile(f.path)); } catch { /* skip a file that vanished */ }
    }
    res.end();
    return true;
  }
  if (path === '/api/version') {
    sendJson(res, { version: APP_VERSION, build: buildId() });
    return true;
  }
  if (path === '/api/email-status') {
    const cfg = loadSmtpConfig();
    sendJson(res, { configured: !!cfg, test: !!cfg?.test, from: cfg ? (cfg.from || cfg.user) : null });
    return true;
  }
  // Mailing the goods document to the place it is going.
  //
  // Deliberately NOT built on /api/send-email, which takes recipient, subject and body
  // from the caller. Here the client says only WHICH LOAD — a timestamp and a
  // destination — and the server rebuilds everything: the recipient comes from the
  // party record, the lines come from the ledger. So this endpoint cannot be used to
  // mail arbitrary text to an arbitrary address, which is the whole reason it exists
  // separately rather than as a convenience wrapper.
  //
  // The facts are the ledger's, exactly as on screen. The layout is plain text rather
  // than the screen's HTML: what must not differ is the numbers, and those have one
  // source. Nothing is sent unless a person pressed the button.
  // Retry, or communicate a shipment that went out without it. Same contract as the guia
  // email: the client names the load, the server rebuilds everything else.
  if (path === '/api/stock/at-communicate' && req.method === 'POST') {
    if (!CREATOR_ROLES.includes(user.role)) { sendJson(res, { ok: false, error: 'Not allowed to dispatch' }, 403); return true; }
    try {
      const { ts, factoryId, movementType } = JSON.parse(await readBody(req));
      const out = await communicateShipment({ ts, factoryId: factoryId || '', movementType: movementType || 'GT', user });
      sendJson(res, { ok: true, ...out, moves: shipmentMoves(ts, factoryId || ''), rev: appState.rev });
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    return true;
  }
  if (path === '/api/stock/guia-email' && req.method === 'POST') {
    if (!isGcRole(user.role)) { sendJson(res, { ok: false, error: 'Your role cannot send email' }, 403); return true; }
    if (!emailAllowed(user.id)) { sendJson(res, { ok: false, error: 'Hourly email limit reached — try again later' }, 429); return true; }
    try {
      const { ts, factoryId } = JSON.parse(await readBody(req));
      // `!m.reversedBy` for the same reason the reprint has it: a reversed line is a
      // correction, not goods on a truck. This document is composed here rather than in
      // the client precisely so the recipient cannot be chosen by the caller — which
      // means the client fixing its own copy would have left the POSTED copy wrong.
      const load = appState.stockMoves.filter(m => m.type === 'send' && m.ts === ts
        && (m.factoryId || '') === (factoryId || '') && !m.reversedBy);
      if (!load.length) throw new Error('Load not found, or every line of it was reversed');
      const dest = appState.parties.find(p => p.id === factoryId);
      if (!dest) throw new Error('Unknown destination');
      if (!dest.email) throw new Error(`${dest.name} has no email address — add one in Fornecedores`);
      const sender = appState.parties.find(p => p.type === 'admin');
      const nameOf = (id) => appState.components.find(c => c.id === id)?.name || '—';
      const unitOf = (id) => appState.components.find(c => c.id === id)?.unit || '';
      const m0 = load[0];
      const lines = [
        'DOCUMENTO INTERNO DE ACOMPANHAMENTO DE BENS',
        'NAO comunicado a AT. NAO substitui a guia de transporte legalmente exigida.',
        '',
        `Remetente:    ${sender?.name || '—'}${sender?.nif ? ' (NIF ' + sender.nif + ')' : ''}`,
        `              ${(sender?.address || '—').replace(/\n/g, ', ')}`,
        `Destinatario: ${dest.name}${dest.nif ? ' (NIF ' + dest.nif + ')' : ''}`,
        `              ${(dest.address || '—').replace(/\n/g, ', ')}`,
        '',
        `Inicio do transporte: ${new Date(m0.departAt || m0.ts).toLocaleString('pt-PT')}`,
        `Matricula:            ${m0.plate || '—'}`,
        m0.note ? `Nota:                 ${m0.note}` : '',
        '',
        'BENS TRANSPORTADOS',
        ...load.map(m => `  ${String(m.qty).padStart(8)} ${unitOf(m.componentId).padEnd(4)} ${nameOf(m.componentId)}`),
        '',
        `Emitido por ${user.name || user.username} em ${new Date().toLocaleString('pt-PT')}.`,
      ].filter(l => l !== '');
      const subject = `Guia de acompanhamento — ${load.length} referência(s) para ${dest.name}`.replace(/[\r\n]/g, ' ');

      const cfg = loadSmtpConfig();
      if (!cfg) { sendJson(res, { ok: false, error: 'SMTP not configured' }, 503); return true; }
      const nodemailer = (await import('nodemailer')).default;
      const transport = cfg.test
        ? nodemailer.createTransport({ jsonTransport: true })
        : nodemailer.createTransport({ host: cfg.host, port: cfg.port || 465, secure: cfg.secure !== false, auth: { user: cfg.user, pass: cfg.pass } });
      const senderName = (user?.name || user?.username || 'TwinFlow').replace(/["\r\n]/g, '');
      const configuredFrom = cfg.from || cfg.user || 'twinflow@localhost';
      const fromAddr = configuredFrom.match(/<([^>]+)>/)?.[1] || configuredFrom;
      const mail = { from: `"${senderName} via TwinFlow" <${fromAddr}>`, to: dest.email, subject, text: lines.join('\n') };
      if (user?.email) mail.replyTo = user.email;
      const info = await transport.sendMail(mail);
      console.log(`[email] guia sent to ${dest.email}${cfg.test ? ' (test mode)' : ''} — ${load.length} line(s)`);
      logConfig('guia.emailed', { kind: 'state' },
        { to: dest.name, lines: load.length, plate: m0.plate || null, test: !!cfg.test }, user);
      sendJson(res, { ok: true, test: !!cfg.test, to: dest.email, lines: load.length, messageId: info.messageId });
    } catch (e) { sendJson(res, { ok: false, error: e.message }, 400); }
    return true;
  }

  if (path === '/api/send-email' && req.method === 'POST') {
    // the app relays through one SMTP account — restrict who can send and cap the
    // rate, so a compromised low-privilege session can't spam from the domain
    if (!isGcRole(user.role)) { sendJson(res, { ok: false, error: 'Your role cannot send email' }, 403); return true; }
    if (!emailAllowed(user.id)) { sendJson(res, { ok: false, error: 'Hourly email limit reached — try again later' }, 429); return true; }
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch { sendJson(res, { ok: false, error: 'Invalid request body' }, 400); return true; }
    const { to, subject, text } = payload;
    if (!to || !String(to).includes('@') || !subject || !text) {
      sendJson(res, { ok: false, error: 'Missing to/subject/text' }, 400);
      return true;
    }
    // header-injection guard: recipients/subject must be single-line
    if (/[\r\n]/.test(String(to) + String(subject))) { sendJson(res, { ok: false, error: 'Invalid characters' }, 400); return true; }
    // The recipient has to be somebody the app already knows.
    //
    // Everything above bounded the SENDER — who may send, how often, and that the
    // headers are well formed. Nothing bounded WHERE it goes. This mail authenticates
    // as the real domain account, so it carries valid SPF and DKIM and lands with the
    // company's full sender reputation; only the display name distinguishes it from
    // any other mail the company sends. With an arbitrary recipient and an arbitrary body,
    // that is a domain-signed relay, and the lowest-privilege role that reaches it is
    // the encarregado — an account held on shared site phones. `replyTo` is the
    // sender's own address, which any account sets on its own profile a minute earlier,
    // so replies came back to the sender too.
    //
    // Every legitimate send addresses a partner record or a colleague's account: the
    // one caller in the client mails an order to `supplier.email`. Restricting the
    // recipient to those addresses keeps that working and removes the relay. It is a
    // real bound and not a formality — writing a partner's address is an administrator
    // act for the company record and a logged one for everybody else.
    if (!knownRecipient(to)) {
      sendJson(res, { ok: false, error: 'Recipient must be a partner or an account registered in TwinFlow' }, 403);
      return true;
    }
    const cfg = loadSmtpConfig();
    if (!cfg) {
      sendJson(res, { ok: false, error: 'SMTP not configured — create smtp-config.json (see smtp-config.example.json)' }, 503);
      return true;
    }
    try {
      const nodemailer = (await import('nodemailer')).default;
      const transport = cfg.test
        ? nodemailer.createTransport({ jsonTransport: true }) // test mode: pretend-send
        : nodemailer.createTransport({
            host: cfg.host,
            port: cfg.port || 465,
            secure: cfg.secure !== false,
            auth: { user: cfg.user, pass: cfg.pass },
          });
      // authenticate/send via the single configured account (SPF/DKIM valid), but
      // show the logged-in user as the sender and route replies to their own email
      const senderName = (user?.name || user?.username || 'TwinFlow').replace(/["\r\n]/g, '');
      const configuredFrom = cfg.from || cfg.user || 'twinflow@localhost'; // test mode has neither
      const fromAddr = configuredFrom.match(/<([^>]+)>/)?.[1] || configuredFrom;
      const mail = {
        from: `"${senderName} via TwinFlow" <${fromAddr}>`,
        to, subject, text,
      };
      if (user?.email) mail.replyTo = user.email;
      const info = await transport.sendMail(mail);
      console.log(`[email] sent to ${to} as ${senderName}${cfg.test ? ' (test mode)' : ''} — ${subject}`);
      // The guia mail has always been recorded; this one left only a console line, so a
      // send was invisible to the administrator inside the app. Mail leaving the company
      // under its own domain is exactly the kind of act the log exists for.
      logConfig('email.sent', { kind: 'state' },
        { to: String(to), subject: String(subject), chars: String(text).length, test: !!cfg.test }, user);
      sendJson(res, { ok: true, test: !!cfg.test, messageId: info.messageId });
    } catch (e) {
      console.error('[email] failed:', e.message);
      sendJson(res, { ok: false, error: e.message }, 500);
    }
    return true;
  }
  return false;
}

// applied to every response. CSP keeps 'unsafe-inline' (the app uses inline styles
// and login.html an inline script) and 'wasm-unsafe-eval' (the IFC viewer runs
// WebAssembly); it still blocks external scripts, framing and object embeds. The
// jsdelivr allowance covers web-ifc's CDN fallback when the vendored wasm is missing.
const CSP = [
  "default-src 'self'",
  // 'unsafe-eval' is required by the vendored web-ifc WASM glue (embind's invoker
  // functions are built with `new Function(...)`, not covered by 'wasm-unsafe-eval')
  // — without it the IFC/QTO feature (the app's core function) cannot load any model
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  // the crane weather window and address geocoding call Open-Meteo; leaving these
  // out silently broke both (fetches failed with the CSP as the only clue)
  "connect-src 'self' https://cdn.jsdelivr.net https://api.open-meteo.com https://geocoding-api.open-meteo.com",
  "worker-src 'self' blob:",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
].join('; ');
function setSecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(self)');
  res.setHeader('Content-Security-Policy', CSP);
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
}
// Static compression for the Node server. Only text types benefit — the .wasm and
// images are already compact, and compressing them would burn CPU for nothing.
// Small files are skipped too: below ~1 KB the header overhead outweighs the saving.
const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml))/;
const COMPRESS_MIN = 1024;
async function maybeCompress(req, res, data, type, headers) {
  if (data.length < COMPRESS_MIN || !COMPRESSIBLE.test(type)) return data;
  const accepts = String(req.headers['accept-encoding'] || '');
  const enc = /\bbr\b/.test(accepts) ? 'br' : /\bgzip\b/.test(accepts) ? 'gzip' : null;
  if (!enc) return data;
  try {
    const zlib = await import('node:zlib');
    const { promisify } = await import('node:util');
    const out = enc === 'br'
      ? await promisify(zlib.brotliCompress)(data)
      : await promisify(zlib.gzip)(data);
    headers['Content-Encoding'] = enc;
    headers.Vary = 'Accept-Encoding'; // caches must key on the encoding
    return out;
  } catch { return data; } // compression is an optimisation, never a failure mode
}

// server code, configs, secrets, VCS and dependency internals must never be served.
// `models` is here for a different reason than the rest: those files are not secrets
// of the app, they are the CLIENT's drawing set. /api/ifc/<id> checks the session and
// the project scope before handing one over; serving the same bytes from /models/<id>.ifc
// walked straight past that check. Anyone who knew (or guessed) a project id could
// download it with no session at all.
//
// `.mjs` is blocked by EXTENSION, not by naming the files. It used to list serve.mjs and
// db.mjs one by one, which meant every server module written afterwards started life
// readable: train-log.mjs since 1.7.0, xlsx-stock.mjs the day it was added. A denylist
// that has to be remembered is a denylist that will be forgotten. Nothing the browser
// loads is .mjs — the client is .js throughout — so the extension is a safe boundary,
// and a new server module is now protected the moment it exists.
const BLOCKED_STATIC = /(^\/(data|models|node_modules)\/)|(^|\/)\.[^/]|\.mjs$|(^|\/)(package(-lock)?\.json|smtp-config[^/]*\.json|boot-error\.txt|start-twinflow\.bat)$/i;

const httpServer = createServer(async (req, res) => {
  try {
    setSecurityHeaders(req, res);
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // "/twinflow" (no trailing slash) would make the browser resolve relative
    // css/js URLs against the domain root — redirect to the canonical form
    if (BASE_PATH && path === BASE_PATH) {
      // The redirect used to go out with no Content-Type at all, and nginx fills that
      // gap with its default: application/octet-stream. Chrome ignores the type on a
      // 301 and follows the Location; Safari on iOS does not — it reads "binary file"
      // and offers to SAVE it, as a download named after the last path segment. So
      // anyone opening <server>/twinflow on an iPhone, without the trailing
      // slash, was asked to save a file called "twinflow" instead of seeing the app.
      // Declaring the type (and giving the body the browsers that ignore redirects
      // would show) keeps this a navigation everywhere.
      res.writeHead(301, {
        Location: BASE_PATH + '/',
        'Content-Type': 'text/html; charset=utf-8',
      });
      res.end(`<!doctype html><meta charset="utf-8"><title>TwinFlow</title>`
        + `<a href="${BASE_PATH}/">TwinFlow</a>`);
      return;
    }
    if (BASE_PATH && path.startsWith(BASE_PATH)) path = path.slice(BASE_PATH.length) || '/';
    if (path.startsWith('/api/')) {
      // the server listens immediately (so Passenger sees it as started) but holds
      // API calls for the ~1–2s it takes to load the SQLite DB — the client retries
      if (!dbReady) { sendJson(res, { ok: false, error: 'starting' }, 503); return; }
      if (await handleApi(req, res, path, getUser(req))) return;
    }
    if (path === '/') path = '/index.html';
    // Never serve credentials, the raw databases, server code or VCS/dep internals.
    //
    // The denylist is applied to the RESOLVED path, not the requested one, and that
    // order is the whole security of this branch. It used to test the raw decoded
    // path, and `%2f` walked straight past it: decodeURIComponent turns
    // `/%2fdata/twinflow.db` into `//data/twinflow.db`, whose double slash misses the
    // `^/data/` anchor — and then join+normalize collapsed it back to the real file,
    // which was read and returned to a caller with no session at all. The database
    // holds every password hash AND the live session tokens, so that single request
    // was a complete authentication bypass. Verified by request, not by reading.
    //
    // Normalising first removes the whole class: any encoding that resolves to the
    // same file is tested as that file.
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    const rel = '/' + file.slice(root.length).replace(/\\/g, '/').replace(/^\/+/, '');
    if (BLOCKED_STATIC.test(rel)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(file);
    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type };
    // vendored libraries never change in place — let the browser cache them hard;
    // everything else must revalidate so app updates reach every device immediately
    headers['Cache-Control'] = path.startsWith('/vendor/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    // Compress text on the way out. In production nginx already does this (and does
    // it better, with Brotli), so this changes nothing there — it is for running the
    // app directly on Node, where three.js and web-ifc were being sent raw: 6.4 MB
    // instead of ~600 KB.
    const body = await maybeCompress(req, res, data, type, headers);
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

// Listen FIRST, then load the database in the background. This is deliberate:
// Passenger/CloudLinux kills the process if it doesn't start listening within a
// short spawn timeout, and loading a large SQLite DB can exceed it. Static files
// serve immediately; API calls return 503 "starting" until dbReady flips true.
httpServer.listen(port, () => {
  console.log(`TwinFlow listening on http://localhost:${port} — loading database…`);
});
(async () => {
  try {
    await bootDatabase();
    dbReady = true;
    const cfg = loadSmtpConfig();
    console.log('[boot] database ready — accepting API traffic');
    console.log(cfg
      ? `[email] SMTP configured (${cfg.test ? 'TEST MODE — emails are not really sent' : cfg.host}) from ${CONFIG_PATH}`
      : `[email] SMTP not configured (looked in ${CONFIG_PATH}) — "Email factory" will open the local mail app instead`);
    // the one way this change can bite: the variable is set but the file was never
    // moved, and email quietly stops working. Name both paths so it is obvious.
    if (!cfg && CONFIG_PATH !== LEGACY_CONFIG_PATH && existsSync(LEGACY_CONFIG_PATH)) {
      console.warn(`[email] TWINFLOW_SMTP_CONFIG points at ${CONFIG_PATH}, which is missing or invalid,`
        + ` but ${LEGACY_CONFIG_PATH} still exists — move it to the new path`);
    }
  } catch (e) {
    try {
      writeFileSync(join(root, 'boot-error.txt'),
        new Date().toISOString() + '\n' + (e.stack || e.message || String(e)) + '\n');
    } catch { /* read-only fs */ }
    console.error('[boot] failed:', e);
    // stay alive so the error is observable and static files still serve; API stays 503
  }
})();
