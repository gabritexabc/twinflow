// Boot TwinFlow against a throwaway instance. Run: node tools/run-test-server.mjs [port]
//
// One command, one guarantee: NOTHING here reads from or writes to the real data/ and
// models/ folders. Data and uploaded models live in <repo>/.test-instance/<port>/
// (gitignored), the database starts empty, and the first boot seeds admin/admin.
//
// The server has FOUR doors back into the real folders, all of them safety nets for
// operators, all of them wrong for a test instance. Each one is closed here, and each
// was learnt by watching it open:
//  1. db.mjs adoptLegacyDatabase() copies the real twinflow.db into any new data dir
//     on first boot. Closed by writing a database file first.
//  2. db.mjs migrateFromJson() — when the database LOOKS empty (loadAppState null) it
//     goes hunting for pre-SQLite state.json in the real data/ folder, ingests it and
//     RENAMES the real file to *.migrated. A truly empty file is not enough; the seeded
//     `meta rev=0` row below is what makes the database count as non-empty.
//  3. The same migration for users.json — with password hashes and live session tokens,
//     and the same rename of the real file. loadUsersDb() is only non-null once a user
//     row exists, which a fresh instance cannot have, so this door is closed from the
//     other side: a marker users.json INSIDE the instance satisfies the migration, is
//     renamed inside the instance, and the admin/admin seed then persists a real row so
//     the door never reopens.
//  4. serve.mjs adoptLegacyModels() copies every real .ifc not present in the instance's
//     models dir. Closed by zero-byte markers with the same names — inert, because the
//     empty database has no project referencing them.
// The env vars must be set BEFORE serve.mjs loads (it reads them at module evaluation),
// hence the dynamic import at the bottom.
//
// The instance dir is scoped by PORT so two concurrent test servers get two instances —
// with a shared dir, every save in one silently erased the other's writes (sql.js holds
// the whole DB in memory and exports the entire file).
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// the same resolution serve.mjs uses, so the dir always matches the port actually served
const port = Number(process.env.PORT) || Number(process.argv[2]) || 8123;
const instance = join(root, '.test-instance', String(port));
const dataDir = join(instance, 'data');
const modelsDir = join(instance, 'models');
mkdirSync(dataDir, { recursive: true });
mkdirSync(modelsDir, { recursive: true });

const dbPath = join(dataDir, 'twinflow.db');
if (!existsSync(dbPath)) {
  const { default: initSqlJs } =
    await import(pathToFileURL(join(root, 'node_modules/sql.js/dist/sql-wasm.js')).href);
  const SQL = await initSqlJs({ locateFile: (f) => join(root, 'node_modules/sql.js/dist', f) });
  const db = new SQL.Database();
  // rev=0 makes loadAppState() treat the database as present-but-empty rather than
  // absent — which is what keeps migrateFromJson() away from the real state.json
  db.run("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT); INSERT INTO meta VALUES ('rev','0');");
  writeFileSync(dbPath, Buffer.from(db.export()));
  console.log('[test] empty database written (blocks adoption and state.json migration):', dbPath);
}
const usersMarker = join(dataDir, 'users.json');
if (!existsSync(usersMarker) && !existsSync(usersMarker + '.migrated')) {
  writeFileSync(usersMarker, JSON.stringify({ users: [], sessions: {} }));
  console.log('[test] users.json marker written (absorbs the users migration in here)');
}

const realModels = join(root, 'models');
if (existsSync(realModels)) {
  let markers = 0;
  for (const f of readdirSync(realModels)) {
    if (!f.endsWith('.ifc') || existsSync(join(modelsDir, f))) continue;
    writeFileSync(join(modelsDir, f), ''); // blocks adoption of the real model
    markers++;
  }
  if (markers) console.log(`[test] ${markers} zero-byte marker(s) written so the real models are not copied in`);
}

process.env.TWINFLOW_DATA_DIR = dataDir;
process.env.TWINFLOW_MODELS_DIR = modelsDir;
console.log(`[test] instance: ${instance}`);
// serve.mjs takes the port from PORT or argv[2]; argv passes straight through, so
// `node tools/run-test-server.mjs 8199` serves on 8199. Default: 8123.
await import(pathToFileURL(join(root, 'serve.mjs')).href);
