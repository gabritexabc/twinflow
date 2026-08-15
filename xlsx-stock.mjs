// Reading a warehouse spreadsheet, without a dependency.
//
// The production host cannot run `npm install`, so a spreadsheet library was never
// an option. It turns out not to be needed: an .xlsx IS a zip of XML, and Node
// already ships the two things required to open one — `zlib` to inflate the
// entries and enough string handling to walk machine-generated XML. What follows
// is deliberately the smallest reader that answers one question: what are the
// cells of the first sheet? No formulas, no styles, no dates-as-numbers.
//
// The second half maps those cells onto the app's component model. That mapping
// is the part that carries domain judgement, so it is written to be read.
import zlib from 'node:zlib';

// ---------- the zip half ----------

// Entries are located through the central directory rather than by scanning for
// local headers: when a writer streams its output the local header carries zeroed
// sizes and the real ones arrive in a trailing descriptor. The central directory
// is always authoritative.
function unzip(buf) {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (no zip directory found)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged .xlsx file (bad directory entry)');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    // the local header's own name/extra lengths are the ones that matter here:
    // the central directory's extra field is frequently a different size
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compressedSize);

    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, zlib.inflateRawSync(raw));
    // anything else (bzip2, lzma) is not produced by Excel or LibreOffice — skipped

    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ---------- the xml half ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s) => s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
  if (e[0] !== '#') return ENTITIES[e] ?? m;
  const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return Number.isFinite(code) ? String.fromCodePoint(code) : m;
});

// A shared string can be split across several runs (<r><t>PARA</t></r><r><t>FUSO</t></r>)
// when part of the text was formatted differently. Concatenating every <t> inside
// the <si> is what puts the word back together.
function readSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) =>
    [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join(''));
}

// "BC" -> 54. Cell references are the only reliable way to know which column a
// value belongs to, because empty cells are simply absent from the XML.
function colToIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function readSheet(xml, shared) {
  const rows = [];
  for (const [, attrs, body] of xml.matchAll(/<row([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNum = Number(attrs.match(/\br="(\d+)"/)?.[1]) || rows.length + 1;
    const cells = [];
    // the attribute capture must be lazy: a greedy [^>]* eats the slash of a
    // self-closing <c r="A2"/>, the alternation then falls through to the ">"
    // branch, and the search for </c> runs on across the following cells — and
    // across rows. An empty cell is exactly where a spreadsheet import goes
    // quietly wrong, so this stays explicit.
    for (const [, cAttrs, cBody] of body.matchAll(/<c([^>]*?)\s*(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = cAttrs.match(/\br="([A-Z]+)\d+"/)?.[1];
      const type = cAttrs.match(/\bt="([^"]+)"/)?.[1];
      const idx = ref ? colToIndex(ref) : cells.length;
      let value = null;
      if (cBody) {
        if (type === 'inlineStr') {
          value = [...cBody.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join('');
        } else {
          const v = cBody.match(/<v>([\s\S]*?)<\/v>/)?.[1];
          if (v != null) {
            if (type === 's') value = shared[Number(v)] ?? '';
            else if (type === 'str' || type === 'e') value = unescapeXml(v);
            else value = Number(v);
          }
        }
      }
      cells[idx] = value === '' ? null : value;
    }
    rows[rowNum - 1] = cells;
  }
  // a sheet with gaps leaves holes in the array; callers want a dense list
  return [...rows].map((r) => r || []);
}

// Reads the FIRST sheet of a workbook. Returns rows of raw cell values.
export function readWorkbook(buf) {
  const files = unzip(buf);
  const shared = readSharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8'));
  // the sheet is usually sheet1.xml, but the name follows creation order, not
  // display order — take whichever worksheet sorts first rather than assuming
  const sheetName = [...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if (!sheetName) throw new Error('The file has no worksheet');
  return readSheet(files.get(sheetName).toString('utf8'), shared);
}

// ---------- the warehouse half ----------

// Headers are matched without accents or case, so "DESCRIÇÃO" and "descricao"
// both land. Each app field lists the spreadsheet headings that mean it.
const HEADER_ALIASES = {
  ref: ['REFERENCIA', 'REF', 'CODIGO'],
  shortName: ['DESCRICAO CURTA', 'NOME', 'DESIGNACAO'],
  longName: ['DESCRICAO'],
  type: ['TIPO', 'FAMILIA'],
  size: ['MEDIDA', 'DIMENSAO', 'TAMANHO'],
  standard: ['NORMA'],
  brand: ['MARCA', 'FABRICANTE'],
  qty: ['QNT (UN)', 'QNT', 'QTD', 'QUANTIDADE'],
  location: ['LOCALIZACAO', 'LOCAL', 'PALETE'],
};

const plain = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip the combining accents NFD just split off
  .replace(/\s+/g, ' ').trim().toUpperCase();

function mapHeaders(headerRow) {
  const map = {};
  headerRow.forEach((cell, i) => {
    const h = plain(cell);
    if (!h) return;
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[field] !== undefined) continue;
      if (aliases.includes(h)) { map[field] = i; return; }
    }
  });
  // DESCRICAO CURTA also matches DESCRICAO by prefix in careless sheets; the
  // exact-match table above avoids that, but guard the outcome anyway
  if (map.shortName !== undefined && map.shortName === map.longName) delete map.longName;
  return map;
}

// What a reference DOES, as opposed to what it is called. Three answers, closed:
//   material   — ends up built into the works and does not come back
//   equipment  — a tool or machine that goes out and returns
//   consumable — used up in the doing
export const TYPES = ['material', 'equipment', 'consumable'];

// The warehouse's spreadsheet says FIXAÇÃO, CALÇOS, SELANTE… — sixteen families that
// describe the article, not its behaviour. This table is the bridge, and it lives here
// so a sheet imported next year is classified by the same rule as the rows already in
// the database. Anything unlisted arrives unclassified rather than guessed: an empty
// field invites somebody to answer it, a wrong one does not.
const TYPE_FROM_FAMILY = {
  'FIXACAO': 'consumable', 'SOLDA': 'consumable', 'BUCHA QUIMICA': 'consumable',
  'SELANTE': 'consumable', 'SILICONE': 'consumable', 'SELICONE': 'consumable',
  'ESPUMA': 'consumable', 'FITA ADV': 'consumable', 'FITA EXP': 'consumable',
  'AUTOADESIVA': 'consumable',
  'CALCOS': 'material', 'TUBO': 'material', 'VARAO': 'material',
  'MEMBRANA': 'material', 'ISOLAMENTO': 'material', 'ESTRUTURA MADEIRA': 'material',
  'COFRAGEM': 'equipment',
};

export function mapType(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return '';
  if (TYPES.includes(v)) return v;              // already classified
  return TYPE_FROM_FAMILY[plain(v)] || '';
}

// Small, specific corrections agreed with the warehouse. Deliberately NOT a
// general-purpose cleaner: anything not listed here is imported exactly as typed,
// because guessing at a reference is worse than carrying its typo forward.
function normalise(field, raw) {
  let v = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!v) return '';
  if (field === 'location') {
    // PALETE 9 sorts and reads apart from PALETE 09; multi-pallet entries
    // ("PALETE 10/21/25") are left exactly as written
    v = v.replace(/^PALETE\s+(\d)$/i, (m, d) => `PALETE 0${d}`);
  }
  if (field === 'standard') {
    v = v.replace(/^DIN\s+/i, 'DIN').replace(/-\s+/g, '-');
  }
  if (field === 'type') {
    if (plain(v) === 'SELICONE') v = 'SILICONE';
  }
  return v;
}

// Quantities arrive as numbers, except where somebody wrote the unit into the
// cell ("700m"). That is a legible answer, so it is read rather than rejected.
const UNIT_WORDS = { UN: 'un', UNI: 'un', KG: 'kg', M: 'm', ML: 'm', MT: 'm', M2: 'm2', M3: 'm3', L: 'L', LT: 'L' };
// `unitStated` separates "the sheet says metres" from "the sheet said nothing and 'un'
// is this reader's default". They used to be indistinguishable, so a re-import rewrote a
// curated 'kg' back to 'un' on every ordinary numeric cell — silently reinterpreting
// every stored quantity and every ledger line for that reference.
function readQty(raw) {
  if (raw == null || raw === '') return { qty: 0, unit: 'un', blank: true, unitStated: false };
  if (typeof raw === 'number') return { qty: raw, unit: 'un', unitStated: false };
  const s = String(raw).replace(',', '.').trim();
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*([A-Za-z2-3]*)$/);
  if (!m) return { qty: 0, unit: 'un', unreadable: String(raw), unitStated: false };
  const word = m[2].toUpperCase();
  const unit = UNIT_WORDS[word] || 'un';
  // stated only when a unit was actually written AND recognised — "700x" names no unit
  return { qty: Number(m[1]), unit, unitStated: !!word && !!UNIT_WORDS[word] };
}

// The two description columns become ONE name. Where the sheet says the same
// thing twice — which it does for most rows — the name is just that. Where they
// differ, both are kept, because each half is load-bearing: six rows of this
// warehouse are all "CHAPA PILARES 1cm" and only the hole pattern in DESCRIÇÃO
// tells them apart, while the pattern alone would never say it is a plate.
export function mergeName(short, long) {
  const a = String(short ?? '').replace(/\s+/g, ' ').trim();
  const b = String(long ?? '').replace(/\s+/g, ' ').trim();
  if (!a) return b;
  if (!b || plain(a) === plain(b)) return a;
  // one already contains the other — repeating it reads as a stutter
  if (plain(b).includes(plain(a))) return b;
  if (plain(a).includes(plain(b))) return a;
  return `${a} — ${b}`;
}

// The identity of a row, and the most consequential decision in this file.
//
// Location belongs in it: the same reference on two pallets is two things to
// count, and merging them throws a location away. The name carries what used to
// be a separate description, so the distinctions that used to live there still
// separate two rows that would otherwise collide.
//
// It also makes a re-import of the same sheet match what it created the first
// time, instead of doubling the warehouse.
const rowKey = (r) => [plain(r.ref || r.name), plain(r.size), plain(r.location)].join('|');

// The same key, for a component already in the database. Exported because the
// migration that merged the two description columns has to recompute every
// stored key — an identity that no longer matches what the sheet produces would
// make the next import duplicate the entire warehouse instead of updating it.
export const componentKey = (c) => rowKey(c);

/**
 * Turns sheet rows into a plan the server can apply.
 * Never writes anything — the caller decides whether to commit.
 */
export function planStockImport(sheetRows, existingComponents = []) {
  const rows = sheetRows.filter((r) => r.some((c) => c != null && c !== ''));
  if (!rows.length) throw new Error('The sheet is empty');

  const cols = mapHeaders(rows[0]);
  if (cols.shortName === undefined && cols.longName === undefined) {
    throw new Error('No description column found (expected DESCRIÇÃO CURTA or DESCRIÇÃO)');
  }

  const at = (row, field) => (cols[field] === undefined ? '' : row[cols[field]]);
  // A component created by an import REMEMBERS the row it came from. Matching on
  // that first means somebody can move a reference to another pallet, or correct
  // its description, without the next import of the same sheet failing to
  // recognise it and creating a second copy. The computed key is the fallback,
  // for references that were entered by hand before this existed.
  const byKey = new Map();
  for (const c of existingComponents) {
    byKey.set(rowKey(c), c);
    if (c.importKey) byKey.set(c.importKey, c);
  }

  const items = [];
  const skipped = [];
  const seen = new Map();

  rows.slice(1).forEach((row, i) => {
    const sheetRow = i + 2; // 1-based, and the header took row 1
    const name = mergeName(normalise('name', at(row, 'shortName')), normalise('name', at(row, 'longName')));
    if (!name) { skipped.push({ sheetRow, reason: 'noName' }); return; }

    const { qty, unit, blank, unreadable, unitStated } = readQty(at(row, 'qty'));
    const item = {
      sheetRow,
      name,
      ref: normalise('ref', at(row, 'ref')),
      type: mapType(normalise('type', at(row, 'type'))),
      size: normalise('size', at(row, 'size')),
      standard: normalise('standard', at(row, 'standard')),
      brand: normalise('brand', at(row, 'brand')),
      location: normalise('location', at(row, 'location')),
      unit,
      unitStated,
      qty,
      notes: [],
    };
    if (blank) item.notes.push('blankQty');
    if (unreadable) item.notes.push('unreadableQty');

    const key = rowKey(item);
    const clash = seen.get(key);
    if (clash) { skipped.push({ sheetRow, reason: 'duplicateOf', of: clash }); return; }
    seen.set(key, sheetRow);

    item.importKey = key;
    const existing = byKey.get(key);
    item.action = existing ? 'update' : 'create';
    if (existing) item.id = existing.id;
    items.push(item);
  });

  return {
    items,
    skipped,
    summary: {
      rows: rows.length - 1,
      create: items.filter((x) => x.action === 'create').length,
      update: items.filter((x) => x.action === 'update').length,
      skipped: skipped.length,
      flagged: items.filter((x) => x.notes.length).length,
      openingQty: items.filter((x) => x.action === 'create').reduce((s, x) => s + x.qty, 0),
    },
    columns: Object.keys(cols),
  };
}
