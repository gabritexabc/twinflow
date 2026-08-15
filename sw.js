// TwinFlow service worker — installable app shell, network FIRST.
//
// The strategy is deliberate and it is the conservative one. A cache-first worker makes an
// app feel instant and makes a deploy a lottery: the phone keeps running yesterday's code
// until something evicts it. That has already cost this project data once — a cached
// store.js imported a dataset without the `procurement` field and the server stored an
// empty list — and a service worker would have made that failure survive a reload.
//
// So: every request goes to the network first. The cache is written on the way past, and
// read ONLY when the network fails. Online, the worker is invisible and a deploy lands on
// the next load, exactly as it does today. Offline, the app opens on the last code it saw
// and paints from the state store.js keeps in localStorage, instead of the browser's
// dinosaur.
//
// Nothing under api/ is ever cached: responses there are per-account, and a phone on a
// building site is not always in the same pocket.

const CACHE = 'twinflow-shell';

// Everything needed to open the app with no network. The 3D stack (6.4 MB of three.js and
// web-ifc) is deliberately absent — it is loaded on demand even online, and pre-caching it
// would mean a 6 MB download to install an app most people open to check a delivery date.
const SHELL = [
  './',
  'index.html',
  'login.html',
  'css/styles.css',
  'js/app.js',
  'js/store.js',
  'js/i18n.js',
  'js/files.js',
  // small, and the one document you need on a site with no signal is the goods document
  'js/pdf.js',
  'js/lang/pt.js',
  'js/lang/en.js',
  'vendor/fonts/inter-var.woff2',
  'vendor/fonts/plex-var.woff2',
  'manifest.json',
  'icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  // addAll fails the whole install if any single file 404s, which would leave the app with
  // no worker at all and no clue why. Each file is fetched on its own and a miss is
  // survivable: network-first means the cache is a fallback, never the source of truth.
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch { /* not fatal — it will be cached on first successful fetch */ }
    }));
    await self.skipWaiting(); // a new deploy should not wait for every tab to close
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // never touch writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // Open-Meteo, jsdelivr: not ours
  if (url.pathname.includes('/api/')) return;             // per-account data, never cached

  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      // Only a real success is worth keeping. An error page cached as the app shell is
      // the kind of thing that outlives the outage that caused it.
      if (fresh && fresh.ok && fresh.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      // A navigation with nothing cached for that exact URL still deserves the app rather
      // than a browser error — index.html is the shell for every view.
      if (req.mode === 'navigate') {
        const shell = await caches.match('index.html') || await caches.match('./');
        if (shell) return shell;
      }
      throw new Error('offline and not cached');
    }
  })());
});
