(async function(){
  const {lib,game,ui,get,_status,ai,rootURL}=await import('/noname.js');await import('/noname/init/polyfill.js');
  const {security}=await import('/noname/util/sandbox/security.js');lib.node={};await security.initSecurity({lib,game,ui,get,_status,ai});
  const {get:getConfig,has,load:loadConfig}=await import('/noname/util/config.js'),{importExtension}=await import('/noname/init/import.js');
  const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),process=require('node:process');
  const source=process.env.NNK_SOURCE_ROOT,fixture=process.env.NNK_B8_ROOT,runtime=require(source+'/online-kernel/lib/batch-runtime.cjs');
  const checks=[],check=(name,fn)=>{try{if(!fn())throw Error('assertion failed');checks.push({name,passed:true})}catch(error){checks.push({name,passed:false,error:error.stack})}};
  const wait=async fn=>{for(let i=0;i<3000;i++){if(fn())return;await new Promise(r=>setTimeout(r,10))}throw Error('RTC/files timeout')};
  window.confirm=()=>false;window.alert=()=>{};window.__b8Counts={};
  const names=['B8-A','B8-B'];
  const code=name=>`export const type='extension';window.__b8Counts[${JSON.stringify(name)}]={top:1,factory:0,precontent:0};export default function(){window.__b8Counts[${JSON.stringify(name)}].factory++;return {name:${JSON.stringify(name)},config:{},package:{},precontent:function(){window.__b8Counts[${JSON.stringify(name)}].precontent++}}}`;
  for(const name of names){fs.mkdirSync(fixture+'/host/extension/'+name,{recursive:true});fs.writeFileSync(fixture+'/host/extension/'+name+'/extension.js',code(name));fs.writeFileSync(fixture+'/host/extension/'+name+'/data.bin',Buffer.alloc(70000,name==='B8-A'?7:9))}
  fs.mkdirSync(fixture+'/guest/extension/B8-A',{recursive:true});fs.writeFileSync(fixture+'/guest/extension/B8-A/extension.js','old A');fs.writeFileSync(fixture+'/guest/extension/B8-A/personal','retain');
  lib.configprefix='b8-probe-';lib.config={mode:'connect',mode_config:{},extensions:[],plays:[],all:{stockextension:[],plays:[]},brokenFile:[],extension_auto_import:false};lib.configOL={mode:'single',number:2};lib.status.reload=0;
  await lib.init.promises.js('game','update');lib.version=window.noname_update.version;
  for(const role of ['host','guest']){
    const dir=fixture+'/'+role+'/extension/联机助手/lib';fs.mkdirSync(dir,{recursive:true});
    for(const f of ['batch-runtime.cjs','batch-wire.cjs','batch-files.cjs','batch-acl.ps1','batch-lock.ps1'])fs.copyFileSync(source+'/online-kernel/lib/'+f,dir+'/'+f);
  }
  window.__nnk__={env:{lib,game,ui,get,_status,ai},state:{},modules:{compat:{gameRoot:()=>fixture+'/guest'}}};
  (0,eval)(fs.readFileSync(source+'/online-kernel/src/batch.js','utf8'));
  check('exact production module loads in official renderer and remains paused with zero file owner',()=>window.__nnk__.modules.batch.paused&&window.__nnk__.modules.batch.capability===0&&!fs.existsSync(fixture+'/guest/nnk-batches/active'));
  lib.db=await new Promise((resolve,reject)=>{const req=indexedDB.open('b8-'+crypto.randomUUID(),1);req.onupgradeneeded=()=>req.result.createObjectStore('config');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
  lib.status.reload=0;
  await game.putDB('config','extensions',[]);await game.putDB('config','unrelated_probe','preserve');
  lib.node={clients:[],observing:[]};ui.create.roomInfo=ui.create.chat=()=>{};game.roomId='b8-probe';game.online=false;game.phaseNumber=0;
  function side(role){const events=[],nnk={env:{lib,game,ui,get,_status,ai},state:{},modules:{bridge:{emit:(type,data)=>events.push({type,data})},config:{get:()=>300},compat:{gameRoot:()=>fixture+'/'+role}}};window.__nnk__=nnk;for(const file of ['consent','rtc','transfer'])(0,eval)(fs.readFileSync(source+'/online-kernel/src/'+file+'.js','utf8'));
    // Explicit isolated candidate activation; the shipped src/batch.js stays paused.
    nnk.modules.batch=runtime.createRuntime(nnk,{enabled:true,storage:localStorage});return {nnk,events};}
  const host=side('host'),guest=side('guest'),a=new RTCPeerConnection({iceServers:[]}),b=new RTCPeerConnection({iceServers:[]});a.onicecandidate=e=>{if(e.candidate)b.addIceCandidate(e.candidate)};b.onicecandidate=e=>{if(e.candidate)a.addIceCandidate(e.candidate)};
  const channel=a.createDataChannel('nnk-link');let remote;b.ondatachannel=e=>{remote=e.channel;guest.s=new guest.nnk.modules.rtc.FakeWebSocket(remote)};
  const offer=await a.createOffer();await a.setLocalDescription(offer);await b.setRemoteDescription(offer);const answer=await b.createAnswer();await b.setLocalDescription(answer);await a.setRemoteDescription(answer);await wait(()=>channel.readyState==='open'&&remote?.readyState==='open');host.s=new host.nnk.modules.rtc.HostBridge(channel);await new Promise(r=>setTimeout(r,100));
  check('actual Chromium WebRTC DataChannels opened',()=>channel.readyState==='open'&&remote.readyState==='open');
  let hostNative=0,guestNative=0;lib.message.server.nnk_b8_probe=function(v){if(v===7)hostNative++};lib.message.client.nnk_b8_probe=function(v){if(v===9)guestNative++};guest.s.onmessage=ev=>lib.element.ws.onmessage.call(guest.s,ev);lib.init.connection(host.s);const client=lib.node.clients.at(-1);
  guest.s.send('["nnk_b8_probe",7]');host.s.send('["nnk_b8_probe",9]');await wait(()=>hostNative===1&&guestNative===1);
  check('actual official Client and ws dispatch preserved',()=>client instanceof lib.element.Client&&client.ws===host.s);
  await host.nnk.modules.consent.propose(client,names);await wait(()=>guest.nnk.modules.consent.snapshot()[0]?.status==='pending');
  let q=guest.nnk.modules.consent.snapshot()[0],binding=Object.fromEntries(['session','peerSession','proposal','digest'].map(k=>[k,q[k]]));
  check('metadata only before Guest local Yes',()=>!fs.existsSync(fixture+'/guest/nnk-batches/active')&&fs.readFileSync(fixture+'/guest/extension/B8-A/extension.js','utf8')==='old A');
  check('only bound local boolean Yes accepted',()=>!guest.nnk.modules.consent.decide({...binding,yes:'true'})&&guest.nnk.modules.consent.decide({...binding,yes:true}));
  try{await wait(()=>guest.nnk.modules.batch.snapshot()[0]?.status==='committed');await wait(()=>host.nnk.modules.batch.snapshot()[0]?.status==='committed')}
  catch(error){throw Error(error.message+' '+JSON.stringify({guest:guest.nnk.modules.batch.snapshot(),host:host.nnk.modules.batch.snapshot(),events:guest.events.slice(-4)}))}
  check('both RTC peers report one full committed batch',()=>guest.nnk.modules.batch.snapshot()[0].received===q.batch.total&&host.nnk.modules.batch.snapshot()[0].digest===q.digest);
  check('all formal files equal actual Host bytes',()=>names.every(name=>['extension.js','data.bin'].every(file=>fs.readFileSync(fixture+'/host/extension/'+name+'/'+file).equals(fs.readFileSync(fixture+'/guest/extension/'+name+'/'+file)))));
  check('unrelated local file preserved and transaction owner released',()=>fs.readFileSync(fixture+'/guest/extension/B8-A/personal','utf8')==='retain'&&!fs.existsSync(fixture+'/guest/nnk-batches/active'));
  check('official config loader reads both durable enables',()=>true);checks.at(-1).passed=(await loadConfig('extension_B8-A_enable','config'))===true&&(await loadConfig('extension_B8-B_enable','config'))===true;
  const stored=await game.getDB('config','extensions');check('official DB API sees entire extension list and unrelated config',()=>stored.includes('B8-A')&&stored.includes('B8-B')&&(lib.config.extensions.includes('B8-B')));check('unrelated config retained',()=>true);checks.at(-1).passed=(await game.getDB('config','unrelated_probe'))==='preserve';
  const initSource=fs.readFileSync(process.env.NNK_ENGINE_ROOT+'/noname/init/index.js','utf8'),i=initSource.indexOf('async function getExtensionList()'),z=initSource.indexOf('\nfunction initSheet()',i);
  const listFunction=new Function('lib','game','get$1','has','get','rootURL','return ('+initSource.slice(i,z)+')')(lib,game,getConfig,has,get,rootURL);
  const list=await listFunction();check('actual official discovery selects both only after full activation',()=>names.every(n=>list.includes(n)));
  for(const name of names)await importExtension(name);await Promise.all(_status.extensionLoading||[]);
  check('actual top-level, native factory and native precontent execute full new versions',()=>names.every(n=>window.__b8Counts[n]?.top===1&&window.__b8Counts[n]?.factory===1&&window.__b8Counts[n]?.precontent===1));
  _status.over=false;guest.nnk.state.guest={session:{wasIn:true}};check('guard rejects native reload during an active engine session',()=>guest.nnk.modules.batch.reload(binding)===false&&!_status.reloading);guest.nnk.state.guest=null;
  guest.nnk.modules.consent.cancel(binding);await new Promise(r=>setTimeout(r,100));check('late cancel preserves committed outcome and active native Client',()=>guest.nnk.modules.batch.snapshot()[0].status==='committed'&&!client.closed&&channel.readyState==='open');
  const guestSource=fs.readFileSync(source+'/online-kernel/src/guest.js','utf8'),gi=guestSource.indexOf('function connectNow(force)'),gz=guestSource.indexOf('\n\tfunction ',gi+12),previousWs=game.ws;
  const admit=new Function('nnk','guestState','bridgeApi','return ('+guestSource.slice(gi,gz)+')')(guest.nnk,{session:{fake:guest.s}},()=>({emit(){}}));admit(true);
  check('actual Guest admission refuses old in-memory extensions until fresh boot while native Client stays connected',()=>!guest.nnk.modules.batch.canEnter(guest.s)&&game.ws===previousWs&&!client.closed&&channel.readyState==='open');
  // Force a genuine IndexedDB abort. No partial enable/list updates may survive.
  const previousDb=lib.db;lib.db={transaction(){const tx=previousDb.transaction(['config'],'readwrite',{durability:'strict'});queueMicrotask(()=>tx.abort());return tx}};
  let failed=false;try{await runtime.activate(guest.nnk,['B8-C','B8-D'],localStorage)}catch(error){failed=true}lib.db=previousDb;
  check('aborted real IDB activation does not mutate in-memory configuration',()=>failed&&!lib.config.extensions.includes('B8-C'));
  check('aborted real IDB activation leaves neither partial enable nor extension list',()=>true);checks.at(-1).passed=(await game.getDB('config','extension_B8-C_enable'))===undefined&&!(await game.getDB('config','extensions')).includes('B8-C');
  let reloads=0;const nativeReload=new Function('_status','lib','window','localStorage','return ({'+game.reload.toString()+'}).reload')(_status,lib,{location:{reload:()=>reloads++}},localStorage);
  guest.nnk.env={...guest.nnk.env,game:Object.assign(Object.create(game),{reload:nativeReload})};
  check('actual native reload is allowed after full durable config with only location I/O redirected',()=>guest.nnk.modules.batch.reload(binding)&&reloads===1&&_status.reloading===true);
  game.saveConfig('b8_after_reload_probe',true);
  check('native saveConfig reload guard did not skip earlier full-batch enable',()=>lib.config['extension_B8-A_enable']===true&&lib.config['extension_B8-B_enable']===true&&lib.config.b8_after_reload_probe===undefined);_status.reloading=false;
  channel.close();await wait(()=>client.closed);guest.s.dispose();a.close();b.close();lib.db.close();
  check('B0 legacy transfer pause remains active in candidate run',()=>host.nnk.modules.transfer.paused===true&&guest.nnk.modules.transfer.paused===true&&host.nnk.modules.transfer.start(names)===0);
  const sourceHashes=Object.fromEntries(['extension.js','src/batch.js','src/guest.js','src/consent.js','src/rtc.js','lib/batch-runtime.cjs','lib/batch-wire.cjs','lib/batch-files.cjs','lib/batch-acl.ps1','lib/batch-lock.ps1'].map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(source+'/online-kernel/'+f)).digest('hex')]));
  return {ok:checks.every(c=>c.passed),checks,fixture,sourceHashes,counts:window.__b8Counts,candidateActivatedOnlyInProbe:true,note:'Actual official ESM security/Client/ws/config loader/IndexedDB strict activation/discovery/import and Chromium RTC. Shipped content module and legacy remain paused. No GUI or cross-machine network acceptance.'};
})()
