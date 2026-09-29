// アプリを更新したら VERSION を上げる（app.js の APP_VERSION と揃える）
const VERSION = '1.2.2';
const CACHE_NAME = 'mahjong-record-' + VERSION;
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  // HTTPキャッシュを通さず最新を取得して、このバージョン専用のキャッシュに入れる
  event.waitUntil(caches.open(CACHE_NAME).then(cache =>
    cache.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' })))));
  // 初回インストール時はそのまま有効化。更新時はアプリの「更新する」ボタンを待つ
  if (!self.registration.active) self.skipWaiting();
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 同一オリジンはこのバージョンのキャッシュから返す（バージョン混在を防ぐ）。無ければネットワーク
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
  );
});
