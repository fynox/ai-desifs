// Service worker minimal : rend le site installable comme une appli (PWA).
// Volontairement SANS cache : toutes les requêtes passent par le réseau,
// pour que chaque déploiement soit visible immédiatement (pas de version figée).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* réseau uniquement */ });
