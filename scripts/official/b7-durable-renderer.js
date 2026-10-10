(async function() {
  const {lib,game,ui,get,_status,ai,rootURL}=await import('/noname.js');await import('/noname/init/polyfill.js');
  const {security}=await import('/noname/util/sandbox/security.js');lib.node={};await security.initSecurity({lib,game,ui,get,_status,ai});
  const {get:getConfig,has,set}=await import('/noname/util/config.js');const {importExtension}=await import('/noname/init/import.js');
  const fs=require('node:fs'),crypto=require('node:crypto'),process=require('node:process');
  const o=window.__gateOptions,fixture=o.fixture,names=['B7-durable-A','B7-durable-B'];
  window.confirm=()=>false;window.alert=()=>{};window.__b7Counts={};window.__b7Trace=[];
  lib.configprefix='b7-durable-';lib.assetURL='/';lib.status.reload=0;
  // Only I/O providers are redirected. These private function bodies and all their
  // engine dependencies execute unchanged, including native config import/decode/save.
  game.promises.checkFile=async name=>fs.existsSync(fixture+'/'+name)?1:0;
  game.promises.readFileAsText=async name=>fs.readFileSync(fixture+'/'+name,'utf8');
  game.promises.removeFile=async name=>fs.unlinkSync(fixture+'/'+name);
  const source=fs.readFileSync(o.engineRoot+'/noname/init/index.js','utf8');
  function extract(start,end){const a=source.indexOf(start),z=source.indexOf(end,a);if(a<0||z<a)throw Error('Official function not found');return source.slice(a,z)}
  const configBody=extract('async function loadConfig()','\nasync function loadCss()');
  const discoveryBody=extract('async function getExtensionList()','\nfunction initSheet()');
  const load=new Function('lib','game','get$1','set','return ('+configBody+')')(lib,game,getConfig,set);
  const discover=new Function('lib','game','get$1','has','get','rootURL','return ('+discoveryBody+')')(lib,game,getConfig,has,get,rootURL);
  await load();lib.config.extension_auto_import=false;
  function write(name,generation){fs.mkdirSync(fixture+'/extension/'+name,{recursive:true});fs.writeFileSync(fixture+'/extension/'+name+'/extension.js',`export const type='extension';\nwindow.__b7Counts[${JSON.stringify(name)}]={generation:${JSON.stringify(generation)},top:1,factory:0,precontent:0};\nexport default function(){window.__b7Counts[${JSON.stringify(name)}].factory++;return {name:${JSON.stringify(name)},config:{},package:{},precontent:function(){window.__b7Counts[${JSON.stringify(name)}].precontent++}}}\n`)}
  function install(){window.__nnk__={env:{lib,game,ui,get,_status,ai},state:{},modules:{}};(0,eval)(fs.readFileSync(o.sourceRoot+'/scripts/official/b7-config-candidate.js','utf8'));window.__nnk__.modules.isolation.install();return window.__nnk__.modules.isolation}
  let lock;
  if(o.phase==='seed'){
    await game.promises.saveConfig('extensions',names);for(const name of names)await game.promises.saveConfig('extension_'+name+'_enable',true);
    if(o.createRestoreConfig){const before={extensions:names,extension_auto_import:false};for(const name of names)before['extension_'+name+'_enable']=true;fs.writeFileSync(fixture+'/restore-config.txt',lib.init.encode(JSON.stringify({config:before,data:{}})))}
    return {ok:true,seeded:true};
  }
  if(o.phase==='lock'){
    for(const name of names)write(name,'old');
    fs.mkdirSync(fixture+'/old',{recursive:true});for(const name of names)fs.copyFileSync(fixture+'/extension/'+name+'/extension.js',fixture+'/old/'+name+'.js');
    const before={extensions:names,extension_auto_import:false};for(const name of names)before['extension_'+name+'_enable']=true;
    fs.writeFileSync(fixture+'/restore-config.txt',lib.init.encode(JSON.stringify({config:before,data:{}})));
    lock=await install().lock('a'.repeat(32),names);
    fs.writeFileSync(fixture+'/pending-journal.json',JSON.stringify({v:1,pending:true,extensions:names,old:Object.fromEntries(names.map(n=>[n,crypto.createHash('sha256').update(fs.readFileSync(fixture+'/old/'+n+'.js')).digest('hex')]))}));
    // A deliberate partial publication in the test fixture, after strict oncomplete.
    write(names[0],'new');
    return {ok:true,lock,strictDurability:true,flags:Object.fromEntries(names.map(n=>[n,lib.config['extension_'+n+'_enable']])),waitingForWholeProcessKill:true};
  }
  const markerBeforeImport=lib.config.nnk_pendingBatch||null;
  const flags=Object.fromEntries(names.map(n=>[n,lib.config['extension_'+n+'_enable']]));
  const importErrors=[],list=await discover();for(const name of list){try{await importExtension(name)}catch(e){importErrors.push({name,error:String(e)})}}if(_status.extensionLoading)await Promise.all(_status.extensionLoading);
  // This is intentionally late: the real kernel can appear after affected names.
  if(o.phase==='restart'){
    const isolation=install();for(const name of names)await game.promises.saveConfig('extension_'+name+'_enable',true);
    _status.extensionLoaded=[];_status.extensionLoading=[];for(const name of list)await importExtension(name);await Promise.all(_status.extensionLoading);
    if(names.some(n=>lib.config['extension_'+n+'_enable']!==false))throw Error('Re-enable guard failed');
  }
  const counts=Object.fromEntries(names.map(n=>[n,window.__b7Counts[n]||{top:0,factory:0,precontent:0}]));
  return {ok:true,phase:o.phase,flags,markerBeforeImport,counts,importErrors,unfinishedNewTop:Object.values(counts).filter(c=>c.generation==='new').reduce((a,c)=>a+c.top,0),
    pendingJournalStillExists:fs.existsSync(fixture+'/pending-journal.json'),configHash:crypto.createHash('sha256').update(configBody).digest('hex'),discoveryHash:crypto.createHash('sha256').update(discoveryBody).digest('hex')};
})()
