// Checks the translation dictionaries. Run: npm run check
//
// This exists because the same class of mistake reached production twice in one day.
// A single malformed string — an unescaped apostrophe, a line break inside a quoted
// value — stops the whole module from parsing. `i18n.js` awaits that import, so when
// it throws the active dictionary stays empty and `t()` returns EVERY key instead of
// its text: the entire interface becomes raw keys like `dashboard.kpi.projects`, for
// whichever language was broken.
//
// Two checks that already existed did NOT catch it, which is the reason for this file:
//   * `node --check file.js` passes. It does not evaluate the file as an ES module,
//     so the broken string is never read.
//   * comparing the KEYS of en against pt passes too. Both dictionaries had the key;
//     what was malformed was the value.
// The only honest check is to import them the way the browser does — hence `import`
// below rather than any amount of reading and regexing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import en from '../js/lang/en.js';
import pt from '../js/lang/pt.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

// ---------- 1. both dictionaries loaded, key-for-key ----------
// Loading only one dictionary per session is what makes this strict rule necessary:
// there is nothing to fall back to, so a key present in one and absent in the other
// is a blank screen for half the users.
const a = Object.keys(en), b = Object.keys(pt);
const onlyEn = a.filter(k => !(k in pt));
const onlyPt = b.filter(k => !(k in en));
if (onlyEn.length) problems.push(`keys only in en: ${onlyEn.join(', ')}`);
if (onlyPt.length) problems.push(`keys only in pt: ${onlyPt.join(', ')}`);
const nonString = a.filter(k => typeof en[k] !== 'string' || typeof pt[k] !== 'string');
if (nonString.length) problems.push(`values that are not strings: ${nonString.join(', ')}`);

// ---------- 2. every key the code asks for actually exists ----------
// Parity only compares the two dictionaries with each other. A key missing from BOTH
// passes that check and still prints raw on screen, so compare against the code too.
// login.html carries its own inline dictionary and is deliberately not scanned.
const SOURCES = ['js/app.js', 'index.html'];
const used = new Map();
const prefixes = new Set();
for (const f of SOURCES) {
  const src = readFileSync(join(root, f), 'utf8');
  for (const m of src.matchAll(/\bt\(\s*'([^']+)'\s*\+/g)) prefixes.add(m[1]); // t('unit.' + u)
  for (const m of src.matchAll(/\bt\(\s*'([^']+)'\s*[,)]/g)) if (!used.has(m[1])) used.set(m[1], f);
  for (const m of src.matchAll(/data-i18n="([^"]+)"/g)) if (!used.has(m[1])) used.set(m[1], f);
}
for (const [k, f] of used) {
  if (!(k in en) || !(k in pt)) problems.push(`${f} uses t('${k}') — missing from ${!(k in en) ? 'en' : ''}${!(k in en) && !(k in pt) ? ' and ' : ''}${!(k in pt) ? 'pt' : ''}`);
}
// a dynamic prefix with no keys at all means a whole family renders as raw keys
for (const p of prefixes) {
  if (!a.some(k => k.startsWith(p))) problems.push(`t('${p}' + …) has no keys in en`);
  if (!b.some(k => k.startsWith(p))) problems.push(`t('${p}' + …) has no keys in pt`);
}

// ---------- 3. placeholders must match between the two ----------
// {n} in one language and {count} in the other silently prints the placeholder.
for (const k of a) {
  if (!(k in pt)) continue;
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
  if (ph(en[k]) !== ph(pt[k])) problems.push(`${k}: placeholders differ — en{${ph(en[k])}} pt{${ph(pt[k])}}`);
}

// ---------- 4. every client module actually parses ----------
// The dictionaries above are caught by importing them. The rest of the client cannot
// be imported here — app.js touches `document` at load — so each file is parsed by a
// separate `node --check`, and the EXIT CODE is what counts.
//
// That distinction is the whole point of this section. `node --check` reports a broken
// file correctly; what failed, repeatedly, was running it inside a shell loop that
// printed "syntax OK" afterwards no matter what. A check whose result is not acted on
// is decoration.
// The trap, measured rather than assumed: `node --check` returns **0** for a BROKEN
// `.js` file that contains `import` statements — which is every client file here. It
// only reports the error when the file is unambiguously a module, so each one is
// copied to a temporary `.mjs` and checked there. Verified: the same broken content
// gives exit 0 as `.js` and exit 1 as `.mjs`.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const probe = mkdtempSync(join(tmpdir(), 'tf-parse-'));
try {
  for (const f of ['js/app.js', 'js/store.js', 'js/i18n.js', 'js/viewer.js', 'js/ifc.js', 'js/files.js', 'js/ifc-worker.js', 'sw.js']) {
    const as_mjs = join(probe, f.replace(/[\\/]/g, '_') + '.mjs');
    writeFileSync(as_mjs, readFileSync(join(root, f), 'utf8'));
    const r = spawnSync(process.execPath, ['--check', as_mjs], { encoding: 'utf8' });
    if (r.status !== 0) {
      const line = (r.stderr || '').split('\n').find(l => /Error/.test(l)) || `exit ${r.status}`;
      problems.push(`${f} does not parse: ${line.trim()}`);
    }
  }
} finally { rmSync(probe, { recursive: true, force: true }); }

console.log(`i18n: ${a.length} keys, ${used.size} referenced from code, ${prefixes.size} dynamic prefixes`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log('i18n: OK');
