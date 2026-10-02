/* Taskasaur local-engine bridge. Loaded after upstream initialization and before src/main.js. */
(() => {
  const params=new URLSearchParams(location.search),session=params.get('taskasaurSession');
  if(!session)return;
  const origin=location.origin,path=params.get('file_path').replace(/^file:\/\//,'');
  const send=(type,data={})=>parent.postMessage({type,session,...data},origin);
  let module,loaded=false;
  window.createEmscriptenModule=(kind,descriptor)=>{
    // The pinned upstream factory only supplies these two properties. Own the
    // factory here so initialization does not depend on another deferred script.
    module={arguments:[kind,descriptor],uno_scripts:[]};
    module.preRun=[()=>{
      module.addRunDependency('taskasaur-file');
      module.addRunDependency('taskasaur-ui-patches');
      Promise.all([
        ['sheetviewbox.ui','modules/scalc/ui'],
        ['themeselectorpanel.ui','svx/ui'],
      ].map(async([name,folder])=>{
        const response=await fetch('/office-patches/'+name);
        if(!response.ok) throw new Error('Required office resource could not be loaded');
        const xml=await response.text(),directory='/instdir/share/config/soffice.cfg/'+folder;
        module.FS.mkdirTree(directory);module.FS.writeFile(directory+'/'+name,xml);
      })).then(()=>module.removeRunDependency('taskasaur-ui-patches')).catch(error=>send('taskasaur.office.error',{message:String(error)}));
      send('taskasaur.office.load');
    }];
    module.onAbort=reason=>send('taskasaur.office.error',{message:String(reason)});
    return module;
  };
  window.addEventListener('message',event=>{
    if(event.source!==parent||event.origin!==origin||event.data?.session!==session)return;
    const message=event.data;
    if(message.type==='taskasaur.office.bytes'&&!loaded&&module){
      try{module.FS.mkdirTree('/taskasaur');module.FS.writeFile(path,new Uint8Array(message.bytes));loaded=true;module.removeRunDependency('taskasaur-file');}
      catch(error){send('taskasaur.office.error',{message:String(error)});}
    }
    if(message.type==='taskasaur.office.save'&&loaded&&window.app?.map){
      const map=window.app.map;
      const listener=result=>{
        if(result.commandName!=='.uno:Save')return;
        map.off('commandresult',listener);
        if(!result.success){send('taskasaur.office.error',{message:'The document engine could not save this file.'});return;}
        try{const bytes=module.FS.readFile(path).slice();parent.postMessage({type:'taskasaur.office.saved',session,requestId:message.requestId,bytes:bytes.buffer},origin,[bytes.buffer]);}
        catch(error){send('taskasaur.office.error',{message:String(error)});}
      };
      map.on('commandresult',listener);map.save(false,false);
    }
  });
  let subscribed=false;
  const timer=setInterval(()=>{
    if(!window.app?.map)return;
    if(!subscribed){subscribed=true;window.app.map.on('updatemodificationindicator',event=>{if(event.status==='MODIFIED')send('taskasaur.office.dirty');});}
    if(window.app.map._docLoaded && window.app.map.getDocType()) {clearInterval(timer);send('taskasaur.office.opened');}
  },100);
})();
