const CACHE="dealflow-v48-notifications";
const STATIC=["/manifest.webmanifest","/icons/icon-192.png","/icons/icon-512.png","/icons/apple-touch-icon.png"];

self.addEventListener("install",event=>{
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(STATIC)));
});

self.addEventListener("activate",event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET") return;
  const url=new URL(event.request.url);
  if(url.pathname.startsWith("/api/")) return;

  if(event.request.mode==="navigate"){
    event.respondWith(
      fetch(event.request)
        .then(response=>{
          const copy=response.clone();
          caches.open(CACHE).then(cache=>cache.put("/",copy));
          return response;
        })
        .catch(()=>caches.match("/") || caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached=>{
      const network=fetch(event.request).then(response=>{
        if(response.ok && url.origin===location.origin){
          const copy=response.clone();
          caches.open(CACHE).then(cache=>cache.put(event.request,copy));
        }
        return response;
      }).catch(()=>cached);
      return cached || network;
    })
  );
});

self.addEventListener("push",event=>{
  let data={title:"DealFlow",body:"You have a follow-up due.",url:"/?view=today",tag:"dealflow-followup"};
  try{ if(event.data) data={...data,...event.data.json()}; }catch(e){}
  event.waitUntil(self.registration.showNotification(data.title,{
    body:data.body,
    icon:"/icons/icon-192.png",
    badge:"/icons/icon-192.png",
    tag:data.tag||"dealflow-followup",
    renotify:true,
    data:{url:data.url||"/?view=today"}
  }));
});

self.addEventListener("notificationclick",event=>{
  event.notification.close();
  const target=new URL(event.notification.data?.url||"/?view=today",self.location.origin).href;
  event.waitUntil((async()=>{
    const windows=await clients.matchAll({type:"window",includeUncontrolled:true});
    for(const client of windows){
      if("focus" in client){
        await client.focus();
        if("navigate" in client) await client.navigate(target);
        return;
      }
    }
    if(clients.openWindow) return clients.openWindow(target);
  })());
});
