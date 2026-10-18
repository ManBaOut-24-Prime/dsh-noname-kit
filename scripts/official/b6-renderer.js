(async function() {
  const testPaths=require(require('node:path').join(require('node:process').env.NNK_SOURCE_ROOT,'scripts','fixtures','test-paths.cjs'));

  const {lib,game,ui,get,_status,ai}=await import('/noname.js');await import('/noname/init/polyfill.js');
  const {security}=await import('/noname/util/sandbox/security.js');lib.node={};await security.initSecurity({lib,game,ui,get,_status,ai});
  const fs=require('node:fs'),process=require('node:process'),crypto=require('node:crypto'),root=process.env.NNK_SOURCE_ROOT;
  const checks=[],check=(name,fn)=>{try{if(!fn())throw new Error('assertion failed');checks.push({name,passed:true})}catch(e){checks.push({name,passed:false,error:e.stack})}};
  const fixture=fs.mkdtempSync(testPaths.tempPrefix("b6-official-"));
  for(const name of ['甲包','乙包']){fs.mkdirSync(fixture+'/extension/'+name,{recursive:true});fs.writeFileSync(fixture+'/extension/'+name+'/extension.js','top-level code '+name);fs.writeFileSync(fixture+'/extension/'+name+'/data.json','data')}
  const before=fs.readFileSync(fixture+'/extension/甲包/extension.js');
  const realTimer=window.setTimeout,deadlines=new Map();let seq=100000;
  window.setTimeout=(fn,ms)=>{if(ms===120000){deadlines.set(++seq,fn);return seq}return realTimer(fn,ms)};
  const clear=window.clearTimeout;window.clearTimeout=id=>{if(deadlines.has(id))deadlines.delete(id);else clear(id)};
  const wait=async(fn)=>{for(let i=0;i<500;i++){if(fn())return;await new Promise(r=>realTimer(r,10))}throw new Error('Timed out')};
  lib.configprefix='b6-probe-';lib.config={mode:'connect',mode_config:{},connect_nickname:'Host probe'};lib.configOL={mode:'single',number:2};lib.status.reload=1;lib.db=undefined;
  lib.node={clients:[],observing:[]};ui.create.roomInfo=ui.create.chat=()=>{};game.roomId='b6-probe';game.online=false;
  function side(){const events=[],nnk={env:{lib,game,ui,get,_status,ai},state:{},modules:{bridge:{emit:(type,data)=>events.push({type,data})},config:{get:()=>300},compat:{gameRoot:()=>fixture}}};window.__nnk__=nnk;for(const file of ['consent','rtc','transfer'])(0,eval)(fs.readFileSync(root+'/online-kernel/src/'+file+'.js','utf8'));return{nnk,api:nnk.modules.consent,events}}
  const host=side(),guest=side();const a=new RTCPeerConnection({iceServers:[]}),b=new RTCPeerConnection({iceServers:[]});a.onicecandidate=e=>{if(e.candidate)b.addIceCandidate(e.candidate)};b.onicecandidate=e=>{if(e.candidate)a.addIceCandidate(e.candidate)};
  const channel=a.createDataChannel('nnk-link');let remote;b.ondatachannel=e=>{remote=e.channel;guest.s=new guest.nnk.modules.rtc.FakeWebSocket(remote)};
  const offer=await a.createOffer();await a.setLocalDescription(offer);await b.setRemoteDescription(offer);const answer=await b.createAnswer();await b.setLocalDescription(answer);await a.setRemoteDescription(answer);
  await wait(()=>channel.readyState==='open'&&remote?.readyState==='open');host.s=new host.nnk.modules.rtc.HostBridge(channel);
  await new Promise(r=>realTimer(r,100));check('real Chromium RTC connection opened',()=>channel.readyState==='open'&&remote.readyState==='open');
  let hostNative=0,guestNative=0;lib.message.server.nnk_b6_probe=function(value){if(value===7)hostNative++};lib.message.client.nnk_b6_probe=function(value){if(value===9)guestNative++};
  guest.s.onmessage=ev=>{const data=JSON.parse(ev.data);if(data[0]==='nnk_b6_probe')lib.element.ws.onmessage.call(guest.s,ev)};
  lib.init.connection(host.s);const nativeClient=lib.node.clients.at(-1);
  check('actual official lib.init.connection created Client',()=>nativeClient instanceof lib.element.Client&&nativeClient.ws===host.s);
  guest.s.send('["nnk_b6_probe",7]');host.s.send('["nnk_b6_probe",9]');await wait(()=>hostNative===1&&guestNative===1);
  check('native server and Guest ws message dispatch remain usable',()=>hostNative===1&&guestNative===1);
  check('real FS metadata proposal accepted',()=>!!host.api);await host.api.propose(nativeClient,['甲包','乙包']);await wait(()=>guest.api.snapshot()[0]?.status==='pending');
  let q=guest.api.snapshot()[0],binding=Object.fromEntries(['session','peerSession','proposal','digest'].map(k=>[k,q[k]]));
  check('complete two-extension proposal has actual hashes',()=>q.batch.count===4&&q.batch.extensions[0].files.every(f=>/^[a-f0-9]{64}$/.test(f.sha256)));
  check('no implicit authorization on receipt',()=>q.status==='pending'&&host.api.snapshot()[0].status==='pending');
  check('stale proposal ignored',()=>guest.api.decide({...binding,proposal:'0'.repeat(32),yes:true})===false);
  check('Guest explicit yes accepted locally',()=>guest.api.decide({...binding,yes:true})===true);await wait(()=>guest.api.snapshot()[0].status==='authorized_paused');
  check('actual RTC result acknowledges exact batch on both peers',()=>host.api.snapshot()[0].status==='authorized_paused'&&guest.api.snapshot()[0].status==='authorized_paused');
  check('authorization is not publication or file-write success',()=>guest.api.snapshot()[0].transferPaused&&before.equals(fs.readFileSync(fixture+'/extension/甲包/extension.js')));
  guest.api.cancel(binding);await wait(()=>host.api.snapshot()[0].status==='cancelled');check('cancel leaves native engine Client connected',()=>!nativeClient.closed&&channel.readyState==='open');
  await host.api.propose(nativeClient,['甲包']);await wait(()=>guest.api.snapshot()[0].status==='pending');q=guest.api.snapshot()[0];binding=Object.fromEntries(['session','peerSession','proposal','digest'].map(k=>[k,q[k]]));guest.api.decide({...binding,yes:false});await wait(()=>host.api.snapshot()[0].status==='declined');
  check('refusal propagates through real RTC without ending normal connection',()=>guest.api.snapshot()[0].status==='declined'&&!nativeClient.closed);
  await host.api.propose(nativeClient,['乙包']);await wait(()=>guest.api.snapshot()[0].status==='pending');for(const fn of [...deadlines.values()])fn();await wait(()=>host.api.snapshot()[0].status==='expired');check('bounded timeout is explicit on both sides',()=>guest.api.snapshot()[0].status==='expired');
  const nativeClose=lib.element.Client.prototype.close;let closes=0;lib.element.Client.prototype.close=function(){closes++;return nativeClose.apply(this,arguments)};
  channel.close();await wait(()=>nativeClient.closed);check('protocol tap preserves actual native Client.close exactly once',()=>closes===1&&!lib.node.clients.includes(nativeClient));
  guest.s.dispose();a.close();b.close();check('all protocol deadline timers released',()=>deadlines.size===0);
  const sourceHashes=Object.fromEntries(['extension.js','src/consent.js','src/rtc.js','src/bridge.js','src/manifest.js'].map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(root+'/online-kernel/'+file)).digest('hex')]));
  return {ok:checks.every(c=>c.passed),checks,engineVersion:/version:\s*"([^"]+)"/.exec(fs.readFileSync(process.env.NNK_ENGINE_ROOT+'/game/update.js','utf8'))?.[1],fixture,sourceHashes,note:'Actual official ESM security, Client connection/message/close; real Chromium RTC pair. Consent metadata only, no file transport/writes. UI acceptance and cross-machine networking not exercised.'};
})()
