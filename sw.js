const CACHE='walkie-shell-v2';
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(['./','./assets/app.js','./assets/app.css','./manifest.webmanifest']))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))));
self.addEventListener('fetch',event=>{const u=new URL(event.request.url); if(u.pathname.includes('/api/')) return; event.respondWith(caches.match(event.request).then(r=>r||fetch(event.request)));});
