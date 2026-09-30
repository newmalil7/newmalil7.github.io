/* AI 瞭望台 · Service Worker
   静态资源 cache-first，数据文件 network-first（保证每天 9 点拿到最新） */

const VERSION = 'aih-v5';
const STATIC = [
  './',
  './index.html',
  './assets/styles.css',
  './assets/app.js',
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png',
  './data/sources.json',
  './data/curriculum.json',
  './data/glossary.json',
  './data/profiles.json',
  './data/weekly.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(STATIC).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // 数据文件：强制走网络（no-store），保证每天 9 点后拿到的是新内容。
  // 缓存只作离线兜底，且按「去掉查询串的路径」存，避免前端加时间戳导致缓存膨胀。
  if (url.pathname.includes('/data/')) {
    const key = new Request(url.origin + url.pathname);
    e.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(key, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(key).then((r) => r || Response.error()))
    );
    return;
  }

  // 静态资源：缓存优先
  e.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
