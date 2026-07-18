// Service worker AI-dhésif : installabilité (PWA) + secours hors-ligne.
// Stratégie : RÉSEAU D'ABORD, toujours — chaque déploiement est visible immédiatement.
// Le cache ne sert QUE si le réseau est indisponible (poseur sur chantier sans réseau).
const CACHE = 'aidhesif-shell-v1';
const SHELL = ['/app', '/logo.svg', '/manifest.webmanifest', '/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Les appels API restent réseau pur (les données hors-ligne viennent du stockage local de l'app)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/webhooks/')) return;
  e.respondWith(
    fetch(e.request).then(r => {
      // met à jour le cache du shell au passage
      if (r.ok && (SHELL.includes(url.pathname) || url.pathname === '/app')) {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return r;
    }).catch(() =>
      caches.match(e.request).then(hit => hit || (e.request.mode === 'navigate' ? caches.match('/app') : Response.error()))
    )
  );
});
