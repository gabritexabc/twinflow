// pdf.js — a very small PDF writer, no dependencies.
//
// WHY THIS EXISTS RATHER THAN A LIBRARY
// The host cannot run `npm install` and nothing here is built, so every dependency has
// to be vendored by hand and carried in the deploy. A purchase-order note and a goods
// document are a heading, a few labelled values and one table — that is a few hundred
// lines of PDF, against ~350 KB of somebody else's code fetched by every phone on site.
// The same reasoning produced the dependency-free .xlsx reader.
//
// WHAT IT DELIBERATELY DOES NOT DO
// No images, no embedded fonts, no wrapping inside a table cell (long text is truncated
// with an ellipsis), no vector drawing beyond horizontal rules. It writes the documents
// this app has. If a document ever needs more than that, this is the wrong file to grow
// — that is the day to reach for a real library.
//
// FONTS: the base-14 Helvetica, which every reader has, so nothing is embedded. The
// encoding is WinAnsi: it covers Portuguese accents and Ø, which is the whole alphabet
// this app writes. Characters outside it are mapped where there is an obvious
// equivalent (the dashes and quotes we actually use) and otherwise replaced, because a
// silently corrupt byte in a printed document is worse than a visible '?'.

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 42;

// Codes that differ from Latin-1 in WinAnsiEncoding. Only the ones this app produces:
// the em dash and the curly quotes come from the interface copy.
const WINANSI = new Map([
  ['—', 0x97], ['–', 0x96], ['‘', 0x91], ['’', 0x92],
  ['“', 0x93], ['”', 0x94], ['…', 0x85], ['•', 0x95],
  ['€', 0x80], ['™', 0x99],
]);

const toWinAnsi = (str) => {
  const out = [];
  for (const ch of String(str ?? '')) {
    const mapped = WINANSI.get(ch);
    if (mapped !== undefined) { out.push(mapped); continue; }
    const code = ch.codePointAt(0);
    // 0x7F–0x9F are control slots in WinAnsi; anything above 0xFF has no single byte
    out.push(code <= 0xFF && !(code >= 0x7F && code <= 0x9F) ? code : 0x3F); // '?'
  }
  return out;
};

// Escapes for a PDF literal string, applied to the already-encoded bytes.
const pdfString = (str) => {
  const bytes = toWinAnsi(str);
  let s = '';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5C) s += '\\'; // ( ) \
    s += String.fromCharCode(b);
  }
  return `(${s})`;
};

// Character widths in 1/1000 em. Exact for the characters that decide alignment —
// every digit in Helvetica is 556, and the separators are 278 — so numeric columns line
// up truly. Letters use a single average, which is why this is only used for truncating
// and right-aligning, never for justifying text.
const WIDTHS = { ' ': 278, '.': 278, ',': 278, '-': 333, ':': 278, '/': 278, '%': 889, 'Ø': 778 };
const charWidth = (ch) => (ch >= '0' && ch <= '9' ? 556 : (WIDTHS[ch] ?? (ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? 667 : 500)));
export const textWidth = (str, size) => [...String(str ?? '')].reduce((n, c) => n + charWidth(c), 0) * size / 1000;

const truncate = (str, size, max) => {
  let s = String(str ?? '');
  if (textWidth(s, size) <= max) return s;
  while (s.length && textWidth(s + '…', size) > max) s = s.slice(0, -1);
  return s + '…';
};

// ---------------------------------------------------------------- page building

class Page {
  constructor() { this.ops = []; this.y = A4.h - MARGIN; }
  text(str, x, size = 10, { bold = false, gray = 0 } = {}) {
    this.ops.push(`BT /${bold ? 'FB' : 'FR'} ${size} Tf ${gray} g ${x.toFixed(2)} ${this.y.toFixed(2)} Td ${pdfString(str)} Tj ET`);
  }
  textRight(str, xRight, size = 10, opts = {}) {
    this.text(str, xRight - textWidth(str, size), size, opts);
  }
  rule(gray = 0.75) {
    this.ops.push(`${gray} G 0.6 w ${MARGIN} ${(this.y + 4).toFixed(2)} m ${(A4.w - MARGIN).toFixed(2)} ${(this.y + 4).toFixed(2)} l S`);
  }
  down(n) { this.y -= n; }
  get room() { return this.y - MARGIN; }
}

/**
 * doc = {
 *   title, subtitle?, warning?,          // warning prints in red — used by the guia
 *   blocks?: [{ label, lines: [] }],     // side-by-side identity boxes
 *   meta?: [[label, value], ...],        // label/value pairs, two per row
 *   table?: { columns: [{ label, width, align }], rows: [[cell, ...]] },
 *   notes?: [], footer?
 * }
 */
export function buildPdf(doc) {
  const pages = [];
  let p = new Page();
  pages.push(p);
  const newPage = () => { p = new Page(); pages.push(p); return p; };
  const usable = A4.w - MARGIN * 2;

  p.text(doc.title, MARGIN, 16, { bold: true });
  p.down(20);
  if (doc.subtitle) { p.text(doc.subtitle, MARGIN, 9, { gray: 0.4 }); p.down(16); }
  if (doc.warning) {
    p.ops.push(`0.7 0.1 0.1 rg`);
    p.text(doc.warning, MARGIN, 8.5, { bold: true });
    p.ops.push(`0 g`);
    p.down(18);
  }

  for (const pair of chunk(doc.blocks || [], 2)) {
    const top = p.y;
    let lowest = top;
    pair.forEach((b, i) => {
      const x = MARGIN + i * (usable / 2);
      p.y = top;
      p.text(b.label.toUpperCase(), x, 7.5, { gray: 0.45 });
      p.down(11);
      for (const line of b.lines.filter(Boolean)) {
        p.text(truncate(line, 9.5, usable / 2 - 12), x, 9.5);
        p.down(11);
      }
      lowest = Math.min(lowest, p.y);
    });
    p.y = lowest;
    p.down(8);
  }

  for (const pair of chunk(doc.meta || [], 2)) {
    const top = p.y;
    pair.forEach(([label, value], i) => {
      const x = MARGIN + i * (usable / 2);
      p.y = top;
      p.text(label.toUpperCase(), x, 7.5, { gray: 0.45 });
      p.down(11);
      p.text(truncate(value, 9.5, usable / 2 - 12), x, 9.5);
    });
    p.y = top - 24;
  }

  if (doc.table) {
    const { columns, rows } = doc.table;
    const total = columns.reduce((n, c) => n + c.width, 0);
    const xs = [];
    let acc = MARGIN;
    for (const c of columns) { xs.push(acc); acc += (c.width / total) * usable; }
    const colW = (i) => (columns[i].width / total) * usable;

    const header = () => {
      p.down(6);
      columns.forEach((c, i) => {
        const s = 8;
        if (c.align === 'right') p.textRight(c.label.toUpperCase(), xs[i] + colW(i) - 4, s, { gray: 0.45 });
        else p.text(c.label.toUpperCase(), xs[i], s, { gray: 0.45 });
      });
      p.down(4);
      p.rule();
      p.down(12);
    };
    header();
    for (const row of rows) {
      if (p.room < 60) { newPage(); header(); }
      row.forEach((cell, i) => {
        const s = 9.5;
        const txt = String(cell ?? '');
        if (columns[i].align === 'right') p.textRight(txt, xs[i] + colW(i) - 4, s);
        else p.text(truncate(txt, s, colW(i) - 8), xs[i], s);
      });
      p.down(14);
    }
    p.down(2);
    p.rule(0.85);
    p.down(14);
  }

  for (const note of (doc.notes || []).filter(Boolean)) {
    if (p.room < 40) newPage();
    p.text(truncate(note, 9, usable), MARGIN, 9, { gray: 0.3 });
    p.down(12);
  }
  if (doc.footer) {
    if (p.room < 40) newPage();
    p.down(6);
    p.text(truncate(doc.footer, 8, usable), MARGIN, 8, { gray: 0.5 });
  }

  return assemble(pages);
}

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// ---------------------------------------------------------------- file assembly
//
// The cross-reference table stores a BYTE offset per object, so everything is measured
// in bytes and not in characters. Every string written here is Latin-1 by construction
// (pdfString already reduced the text), so one char is one byte — but the offsets are
// still accumulated from encoded lengths rather than string lengths, because the day
// that stops being true is the day the file silently stops opening.
function assemble(pages) {
  // NOT toWinAnsi. By this point every string has already been through pdfString, which
  // returned bytes carried as chars — an em dash is already the single char 0x97. Running
  // the WinAnsi mapping again would see 0x97 as an unencodable control slot and replace
  // it with '?', which is exactly what it did: every dash in every document came out as a
  // question mark. Encode once, at the boundary; here the chars ARE the bytes.
  const enc = (s) => {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
    return out;
  };
  const parts = [];
  let length = 0;
  const push = (s) => { const b = enc(s); parts.push(b); length += b.length; };

  const objects = [];   // index → body string
  const offsets = [];

  const pageIds = pages.map((_, i) => 5 + i * 2);
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  objects[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`;
  pages.forEach((pg, i) => {
    const id = pageIds[i];
    const stream = pg.ops.join('\n');
    objects[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] `
      + `/Resources << /Font << /FR 3 0 R /FB 4 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objects[id + 1] = `<< /Length ${enc(stream).length} >>\nstream\n${stream}\nendstream`;
  });

  push('%PDF-1.4\n');
  for (let i = 1; i < objects.length; i++) {
    if (!objects[i]) continue;
    offsets[i] = length;
    push(`${i} 0 obj\n${objects[i]}\nendobj\n`);
  }
  const xrefAt = length;
  const count = objects.length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let i = 1; i < count; i++) {
    push(objects[i] ? `${String(offsets[i]).padStart(10, '0')} 00000 n \n` : `0000000000 65535 f \n`);
  }
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  const bytes = new Uint8Array(length);
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  return new Blob([bytes], { type: 'application/pdf' });
}

// Hands the file to the browser. On a phone this opens the share sheet / Files, which
// is what "save the PDF" means there — the same reason printing was never the answer.
export function downloadPdf(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
