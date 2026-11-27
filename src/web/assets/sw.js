// 只缓存静态资源，页面与 /api 一律走网络（配置随时会变，缓存界面会让人抓狂）
// v3：只预缓存"路径固定、内容稳定"的两样。app.css / app.js 的请求带 ?v=<codehash>，
// 预缓存裸路径永远命不中（白占空间），它们交给下面的 runtime 缓存按完整 URL 收。
const CACHE = 'cfp-static-v3';
const ASSETS = ['/assets/icon.svg', '/assets/offline.html'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 导航请求失败（断网/隧道断）时给一个能看懂的离线页，而不是浏览器的白屏
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/assets/offline.html').then((hit) => hit
      || new Response('<!doctype html><meta charset="utf-8"><p style="font:16px system-ui;padding:24px">现在没有网络，连不上面板。</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))));
    return;
  }
  if (e.request.method !== 'GET' || !url.pathname.startsWith('/assets/')) return;
  if (url.pathname.startsWith('/assets/sw.js')) return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
    return res;
  }).catch(() => hit)));
});
