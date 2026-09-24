self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
self.addEventListener("push",e=>{let d={title:"SweepLab",body:"New setup"};try{d=e.data.json()}catch{}e.waitUntil(self.registration.showNotification(d.title||"SweepLab",{body:d.body||"",tag:d.tag||"sweeplab",data:{url:d.url||"/"}}))});
self.addEventListener("notificationclick",e=>{e.notification.close();e.waitUntil(clients.openWindow((e.notification.data&&e.notification.data.url)||"/"))});