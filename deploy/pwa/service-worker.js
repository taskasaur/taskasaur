const VERSION='__TASKASAUR_BUILD__',SHELL='taskasaur-shell-'+VERSION,ASSETS='taskasaur-assets-'+VERSION;
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const response=await fetch('/offline-assets.json',{cache:'no-store'});if(!response.ok)throw new Error('Offline asset manifest unavailable');
  const manifest=await response.json(),shell=await caches.open(SHELL),assets=await caches.open(ASSETS);
  await shell.addAll(['/','/manifest.webmanifest','/taskasaur_icon.png']);
  for(let index=0;index<manifest.files.length;index+=6)await assets.addAll(manifest.files.slice(index,index+6));
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  await self.clients.claim();
  // Preserve office-engine caches: unsynced files may still depend on that engine version.
  for(const key of await caches.keys())if((key.startsWith('taskasaur-shell-')||key.startsWith('taskasaur-assets-'))&&![SHELL,ASSETS].includes(key))await caches.delete(key);
})()));
self.addEventListener('message',event=>{
  if(event.data?.type==='offline-status')event.waitUntil((async()=>{
    const cache=await caches.open(SHELL);event.ports[0]?.postMessage({ready:Boolean(await cache.match('/')),version:VERSION});
  })());
});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  if(url.pathname.startsWith('/office-engine/'))return; // The editor owns its versioned, explicitly installed asset set.
  event.respondWith((async()=>{
    const cache=await caches.open(event.request.mode==='navigate'?SHELL:ASSETS),saved=await cache.match(event.request);
    if(saved&&event.request.mode!=='navigate')return saved;
    try{const response=await fetch(event.request);if(response.ok&&response.type==='basic')await cache.put(event.request,response.clone());return response;}
    catch(error){if(saved)return saved;if(event.request.mode==='navigate'){const shell=await (await caches.open(SHELL)).match('/');if(shell)return shell;}throw error;}
  })());
});
