// train-log.mjs — append-only decision log, deliberately OUTSIDE the operational
// database.
//
// Why not in twinflow.db: persistAppState rewrites every table and re-exports the
// whole SQLite file on each change (measured at ~217 ms of blocked event loop with
// 5000 orders). Growing that file with a record per action would make the app slower
// exactly as the history — the thing we want to grow — gets bigger. Here every write
// is an append of one line to a file nothing else reads.
//
// Format: JSON Lines, one self-describing event per line, rotated monthly. It is the
// format training pipelines expect, it streams, and a corrupt line costs one record
// rather than the file.
//
// Failure is always silent. A logging problem must never stop somebody dispatching a
// load — the events are valuable, the work is essential.

import { appendFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const SCHEMA_VERSION = 1;

let dir = null;
let queue = Promise.resolve(); // serialises appends so lines can never interleave
let dropped = 0;

export function initTrainingLog(directory) {
  dir = directory;
  mkdir(dir, { recursive: true }).catch((e) => {
    console.error('[training] cannot create the log directory, logging disabled:', e.message);
    dir = null;
  });
  return dir;
}

export const trainingDir = () => dir;

// events-2026-07.jsonl — monthly files keep any single file readable and make it
// trivial to hand over or delete one period
const fileFor = (d) => `events-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}.jsonl`;

export function logEvent(event, fields) {
  if (!dir) return;
  const now = new Date();
  const line = JSON.stringify({
    v: SCHEMA_VERSION,
    ts: now.toISOString(),
    event,          // stable key, never a display string
    ...fields,
  }) + '\n';
  // chained, not awaited by the caller: the request never waits on the log
  queue = queue
    .then(() => appendFile(join(dir, fileFor(now)), line, 'utf8'))
    .catch((e) => {
      if (!dropped) console.error('[training] append failed, events are being dropped:', e.message);
      dropped++;
    });
}

export function droppedCount() { return dropped; }

// newest last, so a concatenated export reads chronologically
export async function listLogFiles() {
  if (!dir) return [];
  try {
    const names = (await readdir(dir)).filter(f => /^events-\d{4}-\d{2}\.jsonl$/.test(f)).sort();
    const out = [];
    for (const name of names) {
      try { out.push({ name, path: join(dir, name), size: (await stat(join(dir, name))).size }); }
      catch { /* vanished between readdir and stat */ }
    }
    return out;
  } catch { return []; }
}
