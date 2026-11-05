import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const root = 'dist';
const files = readdirSync(root, { recursive: true })
  .filter((file) => /\.(html|js|css|svg|woff2)$/.test(file) && file !== 'sw.js')
  .map((file) => file.replaceAll('\\', '/'));
const hash = createHash('sha256');
for (const file of files.sort()) hash.update(readFileSync(join(root, file)));
const version = hash.digest('hex').slice(0, 16);
writeFileSync(
  join(root, 'sw.js'),
  `// Generated public-shell cache. Never cache API responses, credentials, or records.
const CACHE = 'medimart-shell-${version}';
const FILES = ${JSON.stringify(files.map((file) => `./${file}`))};
const URLS = new Set(FILES.map(path => new URL(path, self.registration.scope).href));
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('medimart-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.open(CACHE).then(cache => cache.match('./index.html')).then(response => response || Response.error())));
  } else if (URLS.has(request.url)) {
    event.respondWith(caches.open(CACHE).then(cache => cache.match(request)).then(response => response || fetch(request)));
  }
});
`,
);
console.log(
  `Prepared public offline shell (${files.length} assets, version ${version}). No API caching.`,
);
