// db.mjs — SQLite persistence for TwinFlow (sql.js: pure WASM, no native builds,
// works on any Node — including shared hosting where `npm install` is unavailable).
//
// Design: serve.mjs keeps working on in-memory objects (appState / usersDb);
// this module loads them from data/twinflow.db at boot and rewrites the tables
// on every save. The DB file is exported atomically (tmp + rename) and backed
// up daily to data/backups/, keeping the last 14 copies.
//
// First boot on an existing installation migrates data/state.json and
// data/users.json automatically, then renames them to *.migrated (kept as a
// safety copy — delete them manually once you trust the DB).

import initSqlJs from 'sql.js';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, readdirSync, unlinkSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
// TWINFLOW_DATA_DIR moves the database off the web root. On this host the web
// server serves static files itself, so anything under the app folder is one
// .htaccess mistake away from being downloadable — and this file holds password
// hashes AND live session tokens. Unset, everything behaves exactly as before.
const LEGACY_DATA_DIR = join(root, 'data');
const DATA_DIR = process.env.TWINFLOW_DATA_DIR || LEGACY_DATA_DIR;
const DB_PATH = join(DATA_DIR, 'twinflow.db');
const BACKUP_DIR = join(DATA_DIR, 'backups');
const BACKUP_KEEP = 14;

export const dataDir = () => DATA_DIR;

let db = null;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta        (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS projects    (id TEXT PRIMARY KEY, name TEXT, data TEXT);
  CREATE TABLE IF NOT EXISTS orders      (id TEXT PRIMARY KEY, code TEXT, project_id TEXT, status TEXT, need_by TEXT, data TEXT);
  CREATE TABLE IF NOT EXISTS parties     (id TEXT PRIMARY KEY, type TEXT, data TEXT);
  CREATE TABLE IF NOT EXISTS components  (id TEXT PRIMARY KEY, name TEXT, data TEXT);
  CREATE TABLE IF NOT EXISTS stock_moves (id TEXT PRIMARY KEY, ts TEXT, component_id TEXT, type TEXT, data TEXT);
  CREATE TABLE IF NOT EXISTS procurement (id TEXT PRIMARY KEY, component_id TEXT, supplier_id TEXT, status TEXT, data TEXT);
  CREATE TABLE IF NOT EXISTS users       (id TEXT PRIMARY KEY, username TEXT, role TEXT, data TEXT);
  CREATE TABLE IF NOT EXISTS sessions    (token TEXT PRIMARY KEY, user_id TEXT, created_at TEXT);
`;

export async function openDb() {
  const SQL = await initSqlJs({
    locateFile: (f) => join(root, 'node_modules', 'sql.js', 'dist', f),
  });
  mkdirSync(DATA_DIR, { recursive: true });
  adoptLegacyDatabase();
  db = existsSync(DB_PATH) ? new SQL.Database(readFileSync(DB_PATH)) : new SQL.Database();
  db.exec(SCHEMA);
  return db;
}

// Setting TWINFLOW_DATA_DIR without moving the file first would boot an EMPTY
// database and look exactly like total data loss. So the first boot at a new
// location copies the existing database across instead of starting blank. It is
// a COPY, never a move: if anything goes wrong the original is still there, and
// the operator deletes it by hand once the new location is proven.
function adoptLegacyDatabase() {
  if (DATA_DIR === LEGACY_DATA_DIR) return;
  if (existsSync(DB_PATH)) return;                    // new location already live
  const legacyDb = join(LEGACY_DATA_DIR, 'twinflow.db');
  if (!existsSync(legacyDb)) return;                  // nothing to adopt (fresh install)
  copyFileSync(legacyDb, DB_PATH);
  console.log(`[db] adopted the existing database from ${legacyDb} → ${DB_PATH}`);
  console.log('[db] the original was COPIED, not moved — delete it by hand once this location is proven');
}

function rows(sql) {
  const out = [];
  const stmt = db.prepare(sql);
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

// ---------- load (boot) ----------

export function loadAppState(defaults) {
  const meta = Object.fromEntries(rows('SELECT k, v FROM meta').map(r => [r.k, r.v]));
  const projects = rows('SELECT data FROM projects').map(r => JSON.parse(r.data));
  const orders = rows('SELECT data FROM orders').map(r => JSON.parse(r.data));
  const parties = rows('SELECT data FROM parties').map(r => JSON.parse(r.data));
  const components = rows('SELECT data FROM components').map(r => JSON.parse(r.data));
  const stockMoves = rows('SELECT data FROM stock_moves').map(r => JSON.parse(r.data));
  const procurement = rows('SELECT data FROM procurement').map(r => JSON.parse(r.data));
  if (!projects.length && !orders.length && !parties.length && meta.rev === undefined) return null; // empty DB
  return {
    ...defaults,
    rev: Number(meta.rev || 0),
    seq: Number(meta.seq || 1),
    sdWaivedAt: meta.sdWaivedAt || null, // one-time shop-drawings waiver marker
    pdScopedAt: meta.pdScopedAt || null, // one-time project-director scoping marker
    resetAt: meta.resetAt || null,       // set when the data was deliberately erased
    descMergedAt: meta.descMergedAt || null, // one-time component name/description merge
    typesMappedAt: meta.typesMappedAt || null, // one-time free-text type -> closed list
    projects,
    orders,
    parties: parties.length ? parties : defaults.parties,
    components,
    stockMoves,
    procurement,
  };
}

export function loadUsersDb() {
  const users = rows('SELECT data FROM users').map(r => JSON.parse(r.data));
  if (!users.length) return null; // empty DB
  const sessions = {};
  for (const s of rows('SELECT token, user_id, created_at FROM sessions')) {
    sessions[s.token] = { userId: s.user_id, createdAt: s.created_at };
  }
  return { users, sessions };
}

// ---------- save ----------
// State is small (hundreds of rows), so the simplest CORRECT strategy wins:
// rewrite the tables inside one transaction, then export the file atomically.

export function persistAppState(appState) {
  db.exec('BEGIN');
  try {
    // lowStockAlertedAt / lowFactoryAlertedAt are still DELETED but no longer written:
    // the two standalone stock emails became sections of the per-person daily digest, so
    // their clocks are gone. Keeping them in the delete list purges the old rows on the
    // first save instead of leaving values nothing reads.
    // every key written below MUST be in this delete list: meta.k is a PRIMARY KEY, so
    // a key that is inserted but not first deleted throws on the SECOND save and takes
    // the whole transaction — and therefore all persistence — down with it
    db.run('DELETE FROM meta WHERE k IN (\'rev\',\'seq\',\'lowStockAlertedAt\',\'lowFactoryAlertedAt\',\'sdWaivedAt\',\'pdScopedAt\',\'resetAt\',\'descMergedAt\',\'typesMappedAt\')');
    db.run('INSERT INTO meta (k, v) VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)',
      ['rev', String(appState.rev), 'seq', String(appState.seq),
       'sdWaivedAt', appState.sdWaivedAt || '',
       'pdScopedAt', appState.pdScopedAt || '',
       'resetAt', appState.resetAt || '',
       'descMergedAt', appState.descMergedAt || '',
       'typesMappedAt', appState.typesMappedAt || '']);
    db.run('DELETE FROM projects');
    for (const p of appState.projects) {
      db.run('INSERT INTO projects (id, name, data) VALUES (?, ?, ?)', [p.id, p.name || '', JSON.stringify(p)]);
    }
    db.run('DELETE FROM orders');
    for (const o of appState.orders) {
      db.run('INSERT INTO orders (id, code, project_id, status, need_by, data) VALUES (?, ?, ?, ?, ?, ?)',
        [o.id, o.code || '', o.projectId || '', o.status || '', o.needBy || '', JSON.stringify(o)]);
    }
    db.run('DELETE FROM parties');
    for (const p of appState.parties) {
      db.run('INSERT INTO parties (id, type, data) VALUES (?, ?, ?)', [p.id, p.type || '', JSON.stringify(p)]);
    }
    db.run('DELETE FROM components');
    for (const c of appState.components || []) {
      db.run('INSERT INTO components (id, name, data) VALUES (?, ?, ?)', [c.id, c.name || '', JSON.stringify(c)]);
    }
    db.run('DELETE FROM stock_moves');
    for (const m of appState.stockMoves || []) {
      db.run('INSERT INTO stock_moves (id, ts, component_id, type, data) VALUES (?, ?, ?, ?, ?)',
        [m.id, m.ts || '', m.componentId || '', m.type || '', JSON.stringify(m)]);
    }
    db.run('DELETE FROM procurement');
    for (const po of appState.procurement || []) {
      // component_id is an index column from when an order held exactly one reference.
      // An order with lines has no single component, and picking the first one would be
      // a lie that a future query would believe — so it is left empty and the lines live
      // in `data` with everything else. The column stays because dropping it would mean
      // a schema migration on a table whose only reader is this file.
      db.run('INSERT INTO procurement (id, component_id, supplier_id, status, data) VALUES (?, ?, ?, ?, ?)',
        [po.id, '', po.supplierId || '', po.status || '', JSON.stringify(po)]);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  exportDbFile();
}

export function persistUsersDb(usersDb) {
  db.exec('BEGIN');
  try {
    db.run('DELETE FROM users');
    for (const u of usersDb.users) {
      db.run('INSERT INTO users (id, username, role, data) VALUES (?, ?, ?, ?)',
        [u.id, u.username, u.role, JSON.stringify(u)]);
    }
    db.run('DELETE FROM sessions');
    for (const [token, s] of Object.entries(usersDb.sessions)) {
      db.run('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)',
        [token, s.userId, s.createdAt || '']);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  exportDbFile();
}

// atomic export — a crash mid-write can never leave a half-written database
function exportDbFile() {
  const buf = Buffer.from(db.export());
  writeFileSync(DB_PATH + '.tmp', buf);
  renameSync(DB_PATH + '.tmp', DB_PATH);
}

// ---------- one-time migration from the JSON files ----------

// wants: { state, users } — migrate only what is actually missing from the DB,
// so a stale leftover JSON can never overwrite newer rows
export function migrateFromJson(defaults, wants = { state: true, users: true }) {
  // the pre-SQLite JSON files were always written next to the app, so look there
  // too when the data directory has since been moved off the web root
  const pick = (name) => {
    const here = join(DATA_DIR, name);
    return existsSync(here) ? here : join(LEGACY_DATA_DIR, name);
  };
  const statePath = pick('state.json');
  const usersPath = pick('users.json');
  let appState = null, usersDb = null;
  if (wants.state && existsSync(statePath)) {
    try {
      appState = { ...defaults, ...JSON.parse(readFileSync(statePath, 'utf8')) };
      persistAppState(appState);
      renameSync(statePath, statePath + '.migrated');
      console.log('[db] migrated state.json → twinflow.db (original kept as state.json.migrated)');
    } catch (e) { console.error('[db] state.json migration failed:', e.message); }
  }
  if (wants.users && existsSync(usersPath)) {
    try {
      usersDb = JSON.parse(readFileSync(usersPath, 'utf8'));
      persistUsersDb(usersDb);
      renameSync(usersPath, usersPath + '.migrated');
      console.log('[db] migrated users.json → twinflow.db (original kept as users.json.migrated)');
    } catch (e) { console.error('[db] users.json migration failed:', e.message); }
  }
  return { appState, usersDb };
}

// ---------- daily backups ----------

export function backupNow() {
  try {
    if (!existsSync(DB_PATH)) return;
    mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const target = join(BACKUP_DIR, `twinflow-${stamp}.db`);
    copyFileSync(DB_PATH, target); // same-day restarts just refresh today's copy
    const old = readdirSync(BACKUP_DIR).filter(f => f.startsWith('twinflow-')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - BACKUP_KEEP))) {
      unlinkSync(join(BACKUP_DIR, f));
    }
    console.log('[db] backup written:', target);
  } catch (e) { console.error('[db] backup failed:', e.message); }
}

export function scheduleBackups() {
  backupNow();
  setInterval(backupNow, 24 * 60 * 60 * 1000).unref?.();
}
