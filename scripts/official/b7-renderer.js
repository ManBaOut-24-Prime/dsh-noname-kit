(async function() {
  const {lib,game,ui,get,_status,ai,rootURL}=await import('/noname.js');await import('/noname/init/polyfill.js');
  const {security}=await import('/noname/util/sandbox/security.js');lib.node={};await security.initSecurity({lib,game,ui,get,_status,ai});
  const {get:getConfig,has}=await import('/noname/util/config.js');const {importExtension}=await import('/noname/init/import.js');
  const fs=require('node:fs'),process=require('node:process'),crypto=require('node:crypto'),root=process.env.NNK_ENGINE_ROOT,fixture=process.env.NNK_GATE_ROOT;
  const options=window.__gateOptions;window.__b7Counts={};window.__b7Trace=[];
  window.confirm=()=>false;window.alert=()=>{};
  lib.configprefix='b7-gate-';lib.config={extensions:[],plays:[],all:{plays:[],stockextension:[]},brokenFile:[],mode:'connect',mode_config:{},extension_auto_import:false};lib.status.reload=1;lib.db=undefined;
  function code(name,kind) {
    return `export const type='extension';\nwindow.__b7Counts[${JSON.stringify(name)}]={top:1,factory:0,precontent:0};window.__b7Trace.push(${JSON.stringify(name+':top')});\nexport default function(){window.__b7Counts[${JSON.stringify(name)}].factory++;window.__b7Trace.push(${JSON.stringify(name+':factory')});return {name:${JSON.stringify(name)},editable:false,config:{},package:{},precontent:function(){window.__b7Counts[${JSON.stringify(name)}].precontent++;window.__b7Trace.push(${JSON.stringify(name+':precontent')});${kind==='recovery'?'window.__b7RecoverySaw=JSON.parse(JSON.stringify(window.__b7Counts));':''}}};}\n`;
  }
  const suffix=options.policy+'-'+options.launch,names=['B7-'+suffix+'-A','B7-'+suffix+'-B'];
  for(const name of names){fs.mkdirSync(fixture+'/extension/'+name,{recursive:true});fs.writeFileSync(fixture+'/extension/'+name+'/extension.js',code(name,'new'))}
  fs.writeFileSync(fixture+'/pending-journal.json',JSON.stringify({pending:true,extensions:names}));
  localStorage.removeItem(lib.configprefix+'disable_extension');
  if(options.policy==='staging') {
    // Staging alone isolates bytes, before any publication into formal extension/.
    for(const name of names){fs.mkdirSync(fixture+'/stage/'+name,{recursive:true});fs.renameSync(fixture+'/extension/'+name+'/extension.js',fixture+'/stage/'+name+'/extension.js')}
    lib.config.extensions=[];
  } else {
    lib.config.extensions=names.slice();for(const name of names)lib.config['extension_'+name+'_enable']=!options.policy.startsWith('disabled')&&options.policy!=='stock-disabled';
    if(options.policy==='stock-disabled')lib.config.all.stockextension=names.slice();
    if(options.policy==='late-recovery') {
      const recovery='B7-'+suffix+'-Recovery';fs.mkdirSync(fixture+'/extension/'+recovery,{recursive:true});fs.writeFileSync(fixture+'/extension/'+recovery+'/extension.js',code(recovery,'recovery'));
      lib.config.extensions.push(recovery);lib.config['extension_'+recovery+'_enable']=true;
    }
  }
  if(options.policy==='disabled-compat'||options.policy==='disabled-guarded') {
    _status.connectMode=true;window.__nnk__={env:{lib,game,ui,get,_status,ai},state:{},modules:{bridge:{emit(){}},config:{get:k=>k==='unlockBlock'?[]:k==='onlineName'||k==='onlineAvatar'?'':true}}};
    if(options.policy==='disabled-guarded') {
      lib.config.nnk_pendingBatch={v:1,id:'a'.repeat(32),extensions:names.slice()};
      (0,eval)(fs.readFileSync(process.env.NNK_SOURCE_ROOT+'/scripts/official/b7-config-candidate.js','utf8'));window.__nnk__.modules.isolation.install();
    }
    (0,eval)(fs.readFileSync(process.env.NNK_SOURCE_ROOT+'/online-kernel/src/compat.js','utf8'));window.__nnk__.modules.compat.install();
  }
  // The engine function is private. Execute its unmodified body with its real ESM dependencies.
  const source=fs.readFileSync(root+'/noname/init/index.js','utf8'),a=source.indexOf('async function getExtensionList()'),z=source.indexOf('\nfunction initSheet()',a);
  if(a<0||z<a)throw new Error('Cannot locate official extension discovery function');
  const body=source.slice(a,z),listFunction=new Function('lib','game','get$1','has','get','rootURL','return ('+body+')')(lib,game,getConfig,has,get,rootURL);
  let initiallySkipped=false,flagCleared=false;
  if(options.policy==='global-disable') {
    localStorage.setItem(lib.configprefix+'disable_extension','true');initiallySkipped=(await listFunction()).length===0;
    // Real official onfree treats this as a temporary boot flag, not a durable transaction lock.
    lib.onfree=[];game.syncMenu=false;_status.new_tutorial=true;lib.init.onfree();flagCleared=localStorage.getItem(lib.configprefix+'disable_extension')===null;
  }
  const discovered=await listFunction();for(const name of discovered)await importExtension(name);
  if(_status.extensionLoading)await Promise.all(_status.extensionLoading);
  // Clear the engine import guard while retaining module cache: if compat re-enabled a disabled
  // extension, a second official import executes its file for the first time.
  if(options.policy==='disabled-compat'||options.policy==='disabled-guarded') { _status.extensionLoading=[];_status.extensionLoaded=[];for(const name of discovered)await importExtension(name);await Promise.all(_status.extensionLoading); }
  const affected=Object.fromEntries(names.map(name=>[name,window.__b7Counts[name]||{top:0,factory:0,precontent:0}]));
  const totals=Object.values(affected).reduce((a,c)=>({top:a.top+c.top,factory:a.factory+c.factory,precontent:a.precontent+c.precontent}),{top:0,factory:0,precontent:0});
  const expected=['disabled','disabled-compat','disabled-guarded','staging'].includes(options.policy)?{top:0,factory:0,precontent:0}:options.policy==='stock-disabled'?{top:2,factory:2,precontent:0}:{top:2,factory:2,precontent:2};
  const observed=JSON.stringify(totals)===JSON.stringify(expected)&&(options.policy!=='global-disable'||initiallySkipped&&flagCleared)&&(options.policy!=='late-recovery'||window.__b7RecoverySaw[names[0]]?.precontent===1);
  return {...options,observed,isolationPassed:totals.top===0&&totals.factory===0&&totals.precontent===0,affected,totals,initiallySkipped,flagCleared,recoverySaw:window.__b7RecoverySaw||null,trace:window.__b7Trace,discovered,
    pendingJournalStillExists:fs.existsSync(fixture+'/pending-journal.json'),engineVersion:/version:\s*"([^"]+)"/.exec(fs.readFileSync(root+'/game/update.js','utf8'))?.[1],discoveryHash:crypto.createHash('sha256').update(body).digest('hex'),
    engineSourceHashes:Object.fromEntries(['noname/init/index.js','noname/init/import.js','noname/game/index.js','noname/library/init/index.js'].map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(root+'/'+file)).digest('hex')])),fixture};
})()
