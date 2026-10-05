const CACHE='sweeplab-shell-v2';
const SHELL=['/','/manifest.webmanifest','/icon.svg'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin)return;
  if(u.pathname.startsWith('/api/'))return;
  if(e.request.mode==='navigate'){
    e.respondWith(fetch(e.request).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put('/',copy));return r}).catch(()=>caches.match('/')));
    return;
  }
  e.respondWith(fetch(e.request).then(r=>{if(r.ok){const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy))}return r}).catch(()=>caches.match(e.request)));
});
self.addEventListener('push',e=>{let d={title:'SweepLab',body:'New setup'};try{d=e.data.json()}catch{}e.waitUntil(self.registration.showNotification(d.title||'SweepLab',{body:d.body||'',tag:d.tag||'sweeplab',data:{url:d.url||'/'}}))});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{for(const c of list){if('focus'in c)return c.focus()}return clients.openWindow((e.notification.data&&e.notification.data.url)||'/')}))});
