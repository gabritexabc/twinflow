// i18n.js — translation lookup. The dictionaries themselves live in js/lang/<code>.js
// and are fetched one at a time: shipping both was 81 KB on every page load, half of
// which no account could ever use.
//
// Each user's language preference is stored on their account (server-side) so it
// follows them across devices.
//
// The two dictionaries are kept key-for-key identical (704 keys), which is what makes
// loading only one safe — there is nothing to fall back to. `t()` returns the key
// itself if one is ever missing, and says so in the console, so a gap is visible in
// testing rather than silently blank on screen.

export const LANGS = { en: 'English', pt: 'Português' };

const loaders = {
  en: () => import('./lang/en.js'),
  pt: () => import('./lang/pt.js'),
};

let currentLang = 'en';
let dict = {};       // the active dictionary; empty until setLang() resolves
const missing = new Set(); // report each absent key once, not on every render

// async now: the caller must await it before rendering anything translated
export async function setLang(lang) {
  const code = loaders[lang] ? lang : 'en';
  const mod = await loaders[code]();
  dict = mod.default;
  currentLang = code;
  document.documentElement.lang = code;
  // remember it for the next visit: index.html preloads this file before app.js
  // runs, which removes the extra round trip for everyone but a first-time user
  try { localStorage.setItem('twinflow.lang', code); } catch { /* private mode */ }
  return code;
}

export function getLang() {
  return currentLang;
}

export function t(key, vars) {
  let str = dict[key];
  if (str === undefined) {
    if (!missing.has(key)) { missing.add(key); console.warn('[i18n] chave em falta:', key, '(' + currentLang + ')'); }
    str = key;
  }
  if (vars) {
    for (const [k, v] of Object.entries(vars)) str = str.replaceAll(`{${k}}`, v);
  }
  return str;
}
