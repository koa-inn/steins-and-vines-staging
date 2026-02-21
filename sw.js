/* Service Worker — Steins & Vines */
var CACHE_VERSION = '20260221T181100176';
var STATIC_CACHE = 'sv-static-' + CACHE_VERSION;
var IMAGES_CACHE = 'sv-images-' + CACHE_VERSION;
var FONTS_CACHE  = 'sv-fonts-' + CACHE_VERSION;
var MAX_IMAGES = 200;

var PRECACHE_URLS = [
  '/',
  '/index.html',
  '/products.html',
  '/reservation.html',
  '/about.html',
  '/contact.html',
  '/404.html',
  '/css/styles.min.css',
  '/js/main.min.js',
  '/js/sheets-config.js',
  '/manifest.json',
  '/favicon.ico',
  '/images/SV_Logo_Wordmark_green.svg',
  '/images/SV_Logo_PrimaryCircle_offwhite.svg',
  '/images/Icon_green.svg',
  '/images/Icon_offwhite.svg'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(function(cache) {
      return cache.addAll(PRECACHE_URLS);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) {
          return key.indexOf('sv-') === 0 &&
            key !== STATIC_CACHE &&
            key !== IMAGES_CACHE &&
            key !== FONTS_CACHE;
        }).map(function(key) {
          return caches.delete(key);
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

function trimCache(cacheName, maxItems) {
  caches.open(cacheName).then(function(cache) {
    cache.keys().then(function(keys) {
      if (keys.length > maxItems) {
        cache.delete(keys[0]).then(function() {
          trimCache(cacheName, maxItems);
        });
      }
    });
  });
}

self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;

  // Never cache admin or batch pages
  if (url.pathname.indexOf('admin') !== -1 || url.pathname.indexOf('batch') !== -1) return;

  // Network only for API calls
  if (url.hostname.indexOf('railway.app') !== -1 ||
      url.hostname.indexOf('googleapis.com') !== -1 && url.pathname.indexOf('/css') === -1) return;

  // Google Fonts — runtime cache-first
  if (url.hostname.indexOf('fonts.googleapis.com') !== -1 ||
      url.hostname.indexOf('fonts.gstatic.com') !== -1) {
    event.respondWith(
      caches.open(FONTS_CACHE).then(function(cache) {
        return cache.match(event.request).then(function(cached) {
          if (cached) return cached;
          return fetch(event.request).then(function(response) {
            cache.put(event.request, response.clone());
            return response;
          });
        });
      })
    );
    return;
  }

  // Product images — runtime cache-first, max 200
  if (url.pathname.indexOf('/images/products/') !== -1) {
    event.respondWith(
      caches.open(IMAGES_CACHE).then(function(cache) {
        return cache.match(event.request).then(function(cached) {
          if (cached) return cached;
          return fetch(event.request).then(function(response) {
            cache.put(event.request, response.clone());
            trimCache(IMAGES_CACHE, MAX_IMAGES);
            return response;
          });
        });
      })
    );
    return;
  }

  // Everything else (same-origin static) — cache-first, offline fallback
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) return cached;
      return fetch(event.request).catch(function() {
        if (event.request.headers.get('accept').indexOf('text/html') !== -1) {
          return caches.match('/404.html');
        }
      });
    })
  );
});
