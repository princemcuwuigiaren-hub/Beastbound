// Beastbound service worker (same strategy as the Canon one).
//
//  - The app SHELL (index.html, manifest.json, icons) is served network-first.
//    Every deploy is picked up on the next load that has connectivity: no
//    version bump and no cache clearing. The saved copy only exists so the
//    game can still open with no network.
//  - Google Fonts are served cache-first (their URLs never change).
//  - Everything else goes straight to the network, untouched.
//
// Bump SHELL_CACHE_NAME only when PRECACHE_URLS changes. Ordinary edits to
// index.html need no bump.
//
// Player progress (shards, collection, equipped beasts, FX setting) lives in
// localStorage, not in these caches, so updating or clearing the shell never
// touches it.

const SHELL_CACHE_NAME = 'beastbound-shell-v1';

const PRECACHE_URLS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  'https://fonts.googleapis.com/css2?family=Cinzel:wght@500;800&display=swap'
];

const VENDOR_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE_NAME).then((cache) =>
      // addAll() is all-or-nothing, so cache each URL on its own: one failed
      // font request must not sink offline support for everything else.
      Promise.all(PRECACHE_URLS.map((url) =>
        cache.add(new Request(url, { cache: 'reload' })).catch((e) => {
          console.warn('Beastbound SW: precache skipped for', url, e && e.message);
        })
      ))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      // Only ever touch this game's own caches: on a shared address (for example
      // two repos under one github.io name) other apps keep theirs.
      Promise.all(names.filter((n) => n.startsWith('beastbound-') && n !== SHELL_CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Reserved hosting paths (Firebase Hosting's /__/ helpers) bypass the worker.
  if (url.origin === self.location.origin && url.pathname.startsWith('/__/')) return;

  // Only GETs are ever handled here.
  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate' || url.origin === self.location.origin) {
    event.respondWith(networkFirst(event.request, event));
    return;
  }

  if (VENDOR_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  event.respondWith(fetch(event.request));
});

// How long the shell waits on the network before falling back to the saved
// copy. On a good connection the fresh build wins. On a slow one the game opens
// from the saved copy right away and the newer build is used on the next launch.
const SHELL_NETWORK_TIMEOUT_MS = 2500;

async function shellSignature(resp) {
  const h = resp.headers.get('etag') || resp.headers.get('last-modified');
  if (h) return 'h:' + h;
  try { return 'n:' + (await resp.clone().arrayBuffer()).byteLength; } catch (e) { return ''; }
}

// Tells every open window that a newer build has finished downloading, so the
// game can offer a Reload instead of staying on the old build unnoticed.
async function notifyUpdateReady() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  windows.forEach((c) => c.postMessage({ type: 'beastbound-update-ready' }));
}

async function networkFirst(request, event) {
  const cache = await caches.open(SHELL_CACHE_NAME);
  const shellUrl = new URL('./index.html', self.registration.scope).href;
  const isNav = request.mode === 'navigate';
  // The game is ONE page. Whatever address a launch used (site root, index.html,
  // either with a ?query), it is saved to and served from that single entry.
  const fromCache = async () => {
    if (isNav) {
      const shell = await cache.match(shellUrl);
      if (shell) return shell;
    }
    return cache.match(request, { ignoreSearch: true });
  };

  let servedSavedCopy = false;
  const networkPromise = fetch(request, { cache: 'no-cache' }).then(async (fresh) => {
    // Only real, successful responses are saved, so a 404/500 can never
    // overwrite a good saved copy.
    if (fresh && fresh.ok) {
      let changed = false;
      if (isNav) {
        try {
          const old = await cache.match(shellUrl);
          if (old) {
            const [a, b] = await Promise.all([shellSignature(old), shellSignature(fresh)]);
            changed = !!a && !!b && a !== b;
          }
        } catch (e) { /* can't compare: just don't announce */ }
      }
      const saved = cache.put(isNav ? shellUrl : request, fresh.clone()).then(() => {
        if (changed && servedSavedCopy) return notifyUpdateReady();
      }).catch((e) => {
        console.warn('Beastbound SW: could not save', request.url, e && e.message);
      });
      if (event && event.waitUntil) event.waitUntil(saved);
    }
    return fresh;
  });
  networkPromise.catch(() => {});
  if (event && event.waitUntil) event.waitUntil(networkPromise.catch(() => {}));

  const cached = await fromCache();
  if (!cached) return networkPromise; // first ever load: nothing saved, so wait

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), SHELL_NETWORK_TIMEOUT_MS));
  try {
    const winner = await Promise.race([networkPromise, timeout]);
    if (winner && winner.ok) return winner;
  } catch (e) { /* offline or failed: use the saved copy */ }
  servedSavedCopy = true;
  return cached;
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && fresh.ok) cache.put(request, fresh.clone());
  return fresh;
}
