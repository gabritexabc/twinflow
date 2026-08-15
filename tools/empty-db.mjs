// Write an EMPTY but valid twinflow.db into a directory. Run: node tools/empty-db.mjs <dataDir>
//
// Why this has to exist: pointing TWINFLOW_DATA_DIR at a new folder does NOT give a
// clean instance on its own — two of db.mjs's operator safety nets fill it with the
// real data instead:
//   * adoptLegacyDatabase() copies the real twinflow.db in when none exists. A database
//     file existing first is what stops it.
//   * migrateFromJson() runs whenever the database LOOKS empty (no rows, no rev) and
//     falls back to the REAL data/ folder for pre-SQLite state.json / users.json —
//     ingesting them and renaming the real files to *.migrated. The seeded `meta rev=0`
//     row below makes the database count as present-but-empty, which turns the state
//     search off; the users.json marker written beside the database absorbs the users
//     migration inside this directory.
//
// For a one-command test instance, see tools/run-test-server.mjs, which does all this
// and the models-dir isolation too.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node tools/empty-db.mjs <dataDir>');
  process.exit(1);
}

// the no-op path must not need node_modules: check before touching sql.js
mkdirSync(dir, { recursive: true });
const path = join(dir, 'twinflow.db');
if (existsSync(path)) {
  console.log('already there, leaving it alone:', path);
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { default: initSqlJs } =
  await import(pathToFileURL(join(root, 'node_modules/sql.js/dist/sql-wasm.js')).href);
const SQL = await initSqlJs({ locateFile: (f) => join(root, 'node_modules/sql.js/dist', f) });

const db = new SQL.Database();
db.run("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT); INSERT INTO meta VALUES ('rev','0');");
writeFileSync(path, Buffer.from(db.export()));
console.log('empty database written (blocks adoption and state.json migration):', path);

const usersMarker = join(dir, 'users.json');
if (!existsSync(usersMarker) && !existsSync(usersMarker + '.migrated')) {
  writeFileSync(usersMarker, JSON.stringify({ users: [], sessions: {} }));
  console.log('users.json marker written (absorbs the users migration in here):', usersMarker);
}
