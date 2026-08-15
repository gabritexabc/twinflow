// Give every entity in an IFC file its own GlobalId. Run: node tools/fix-guids.mjs <in.ifc> <out.ifc>
//
// Why this exists: some IFC exporters (and quick test-model generators) write the SAME
// GlobalId on every entity. GlobalId is the only per-element identity TwinFlow has — it
// is what a production request snapshots, what the QR label carries, and what the status
// colours and the 4D replay look elements up by. With one id shared by the whole model,
// none of that can work: every element resolves to the same record and the viewer paints
// a uniform grey.
//
// This rewrites attribute 1 (the GlobalId) of every entity line, leaving geometry,
// relationships (which reference by expressID, not GlobalId) and quantities untouched.
// The output ids are valid compressed IFC GUIDs: 22 chars over the base-64 alphabet,
// first char '0'..'3' (it only carries 2 of the 128 bits).
//
// NOTE if a model is already imported into TwinFlow: fixing the FILE is not enough.
// The project's groups and any orders snapshotted the old ids into the database, so the
// model must be re-imported (or the stored ids repaired) for the identities to line up.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node tools/fix-guids.mjs <in.ifc> <out.ifc>');
  process.exit(1);
}

// the IFC GlobalId alphabet (ISO 10303-21 compressed GUID)
const A = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
let counter = 0;
function nextId() {
  let v = ++counter, s = '';
  while (v > 0) { s = A[v % 64] + s; v = Math.floor(v / 64); }
  return '0' + s.padStart(21, '0'); // 22 chars, first char '0' = always a valid GUID
}

const src = readFileSync(inPath, 'utf8');
const before = new Set();
// attribute 1 of an entity line, when it looks like a GlobalId
const out = src.replace(/^(#\d+\s*=\s*IFC[A-Z0-9]+\(\s*)'([0-9A-Za-z_$]{22})'/gm, (_, head, id) => {
  before.add(id);
  // replacer FUNCTION on purpose: the GUID alphabet includes '$', which a replacement
  // TEMPLATE would interpret ($' = "everything after the match") and corrupt the line
  return `${head}'${nextId()}'`;
});

const after = new Set([...out.matchAll(/^#\d+\s*=\s*IFC[A-Z0-9]+\(\s*'([0-9A-Za-z_$]{22})'/gm)].map((m) => m[1]));
if (after.size !== counter) {
  console.error(`id collision or corrupted line (${counter} rewritten, ${after.size} distinct) — nothing written`);
  process.exit(1);
}
writeFileSync(outPath, out);
console.log(`${inPath}: ${counter} entities carried ${before.size} distinct GlobalId(s)`);
console.log(`${outPath}: ${after.size} distinct GlobalId(s)`);
