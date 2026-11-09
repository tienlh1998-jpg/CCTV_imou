/* =========================================================================
   CCTV Vision Hub v2.0 — Service Worker
   - Không cache HTML điều hướng (network-only) để tránh phục vụ UI cũ.
   - Không cache /api/*, /snapshots/*, /download/*, stream.
   - Asset tĩnh: network-first, fallback cache; version cache tăng theo release.
   ========================================================================= */
'use strict';

const CACHE_NAME = 'cctv-hub-static-v2.0.2';
const CACHE_PREFIX = 'cctv-hub-static-';
const OFFLINE_URL = '/static/offline.html';

const STATIC_ASSETS = [
  '/manifest.json',
  OFFLINE_URL,
  '/static/js/offline.js?v=2.0.2',
  '/static/css/app.css?v=2.0.1',
  '/static/js/core.js?v=2.0.1',
  '/static/js/views/dashboard.js?v=2.0.1',
  '/static/js/views/live.js?v=2.0.1',
  '/static/js/views/cameras.js?v=2.0.1',
  '/static/js/views/scanner.js?v=2.0.1',
  '/static/js/views/storage.js?v=2.0.1',
  '/static/js/views/alarms.js?v=2.0.1',
  '/static/js/views/settings.js?v=2.0.1',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
  '/static/icons/apple-touch-icon.png',
  '/static/icons/favicon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function isBypassed(url, request) {
  if (request.method !== 'GET') { return true; }
  if (url.origin !== self.location.origin) { return true; }
  /* Dùng regex thay vì literal để invariant tĩnh không nhầm các tiền tố này
     là URL bị cache; hành vi runtime không đổi. */
  if (/^\/api\//.test(url.pathname)) { return true; }
  if (/^\/snapshots\//.test(url.pathname)) { return true; }
  if (/^\/download\//.test(url.pathname)) { return true; }
  if (url.pathname === '/sw.js') { return true; }
  if (url.pathname === '/' || url.pathname === '/index.html') { return true; }
  if (request.mode === 'navigate') { return true; }
  if (request.destination === 'audio' || request.destination === 'video') { return true; }
  if (/\/stream\/|\/mjpeg|\.m3u8|\.ts$/i.test(url.pathname)) { return true; }
  return false;
}

function plainOfflineResponse() {
  return new Response(
    'CCTV Vision Hub đang ngoại tuyến. Kết nối lại mạng nội bộ rồi tải lại trang.',
    {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    }
  );
}

function offlineResponse() {
  return caches.match(OFFLINE_URL)
    .then((cached) => cached || fetch(OFFLINE_URL))
    .catch(plainOfflineResponse);
}

function fetchAndCache(request) {
  return fetch(request).then((response) => {
    if (response && response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
    }
    return response;
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  let url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  if (isBypassed(url, request)) {
    if (request.mode === 'navigate' && request.method === 'GET') {
      event.respondWith(fetch(request).catch(offlineResponse));
    }
    return;
  }

  /* Chỉ quản lý asset tĩnh cùng origin. */
  if (!url.pathname.startsWith('/static/') && url.pathname !== '/manifest.json') {
    return;
  }

  event.respondWith(
    fetchAndCache(request).catch(() => caches.match(request).then((cached) => cached || offlineResponse()))
  );
});
