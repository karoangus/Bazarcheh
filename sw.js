/* =========================================================
   بازارچه دارک وب — Service Worker (PWA)
   استراتژی:
   - پوسته اپ (shell) از قبل کش می‌شه → آفلاین باز می‌شه
   - ناوبری: network-first با fallback به کش (آپدیت‌ها می‌رسن)
   - فایل‌های استاتیک هم‌اوریجین: cache-first + کش در پس‌زمینه
   - API سوپابیس/توابع: هرگز کش نمی‌شن (بازی آنلاین باید همیشه تازه باشه)
   ========================================================= */
const CACHE = 'bazarcheh-v13.0.2';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './vendor/supabase.js',
  './vendor/fonts/Vazirmatn-Light.woff2',
  './vendor/fonts/Vazirmatn-Regular.woff2',
  './vendor/fonts/Vazirmatn-Medium.woff2',
  './vendor/fonts/Vazirmatn-SemiBold.woff2',
  './vendor/fonts/Vazirmatn-Bold.woff2',
  './vendor/fonts/Vazirmatn-ExtraBold.woff2',
  './vendor/fonts/Vazirmatn-Black.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // POSTهای بازی (توابع سوپابیس) دست‌نخورده

  const url = new URL(req.url);

  // API و توابع سوپابیس: فقط شبکه (داده بازی باید همیشه تازه باشه)
  if (url.hostname.endsWith('supabase.co')) return;

  // ناوبری: network-first تا نسخه جدید سریع برسه، fallback به کش برای آفلاین
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // بقیه GETهای هم‌اوریجین: cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        });
      })
    );
  }
});
