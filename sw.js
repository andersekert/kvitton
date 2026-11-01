// Makes the app work offline abroad. Bump VERSION whenever a file changes.
const VERSION = 'kvitton-7';
const PROFILE = '/profil/v1.css';
const FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'parser.js',
  'store.js',
  'documents.js',
  'scanner.js',
  'crop-editor.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/tesseract.min.js',
  'vendor/worker.min.js',
  'vendor/tesseract-core-simd-lstm.wasm.js',
  'vendor/tesseract-core-lstm.wasm.js',
  'vendor/lang/swe.traineddata.gz',
  'vendor/lang/eng.traineddata.gz',
  'vendor/pdf.min.js',
  'vendor/pdf.worker.min.js',
  PROFILE,
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== VERSION).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

// The shared profile and its font stay current online, and the last copy is used offline.
async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname === PROFILE || url.hostname.startsWith('fonts.')) {
    event.respondWith(networkFirst(event.request));
    return;
  }
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((hit) => hit ?? fetch(event.request)),
  );
});
