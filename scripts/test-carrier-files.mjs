import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {tempPrefix,sourceRoot}=require('./fixtures/test-paths.cjs');
const lib=path.join(sourceRoot(),'online-kernel','lib');
const {createCarrierFiles,manifestDigest}=require(path.join(lib,'carrier-files.cjs'));
const {CarrierFileService}=require(path.join(lib,'carrier-file-service.cjs'));
const {createCarrierFilesProxy}=require(path.join(lib,'carrier-files-proxy.cjs'));
const base=fs.mkdtempSync(tempPrefix('carrier-files-')),results=[];
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function check(name,value){assert.ok(value,name);results.push(name);console.log('PASS '+name);}
function root(name){const r=path.join(base,name);fs.mkdirSync(path.join(r,'extension'),{recursive:true});return r;}
function file(r,ext,name,value){const f=path.join(r,'extension',ext,...name.split('/'));fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,value);}
function bytes(r,ext,name){return fs.readFileSync(path.join(r,'extension',ext,...name.split('/')));}
function gate(r){
 const state={current:null,acquired:0,released:0,verifyCount:0,denyVerify:0,blocked:false};
 return {state,
  acquireGate({phase}){assert.ok(['source','receive'].includes(phase));assert.equal(state.current,null);state.acquired++;const token=crypto.randomBytes(16).toString('hex'),folder=path.join(r,'nnk-batches','gates');fs.mkdirSync(folder,{recursive:true});const cancelFile=path.join(folder,token+'.cancel'),fd=fs.openSync(cancelFile,'wx+');fs.writeSync(fd,Buffer.from([0]));fs.fsyncSync(fd);state.current={token,cancelFile,cancelIno:String(fs.fstatSync(fd,{bigint:true}).ino),fd};return {token,cancelFile,cancelIno:state.current.cancelIno};},
  verifyGate(token){assert.equal(token,state.current.token);state.verifyCount++;if(state.denyVerify===state.verifyCount)throw Error('native gate revoked');return {valid:true};},
  releaseGate(token,{recoveryRequired}){assert.equal(token,state.current.token);const g=state.current;fs.writeSync(g.fd,Buffer.from([1]),0,1,0);if(recoveryRequired||fs.existsSync(path.join(r,'nnk-batches','active'))){state.blocked=true;return {released:false,recoveryRequired:true};}fs.closeSync(g.fd);fs.unlinkSync(g.cancelFile);state.current=null;state.released++;return {released:true};}
 };
}
function disk(r,g=gate(r),stockExtensions=[]){return {api:createCarrierFiles({root:r,version:'1.11.6',stockExtensions,...g}),gate:g};}
function grant(batch){return {session:'1'.repeat(32),peerSession:'2'.repeat(32),proposal:crypto.randomBytes(16).toString('hex'),digest:manifestDigest(batch),expires:Date.now()+180000,batch};}
function context(extra={}){return {peerId:'peer',owner:{},connectionSessionId:'connection',scope:'scope',isAuthorized:()=>true,...extra};}
async function upload(receiver,batch,from){let index=0;for(const e of batch.extensions)for(const f of e.files){const b=bytes(from,e.name,f.path);for(let offset=0;offset<b.length||offset===0;offset+=32768){const end=Math.min(offset+32768,b.length);await receiver.chunk(index,offset,b.subarray(offset,end),end===b.length);if(end===b.length)break;}index++;}}
async function synthetic(){
 const actor={},other={},events=new EventEmitter();let closes=0,aborts=0,commits=0,resolveInit;
 const batch={extensions:[{name:'合成包',files:[{path:'extension.js',size:3,sha256:sha(Buffer.from('abc'))}]}]};
 const fake={collect:async()=>batch,source:async()=>({read:async()=>Buffer.from('abc'),close:async()=>{closes++;return {status:'closed'};}}),receiver:async()=>({chunk:async()=>{},commit:async(_live,done)=>{commits++;const r={status:'committed',id:'3'.repeat(32)};done(r);return {...r,activated:false};},abort:async()=>{aborts++;return {status:'rolled_back'};}})};
 const service=new CarrierFileService({getDisk:()=>fake,emit:(_actor,detail)=>events.emit('nnk-transfer-file-event',{},detail)});
 const native={request:(action,args)=>service.request(actor,action,args[0])};
 const proxy=createCarrierFilesProxy({native,ipc:events});
 await assert.rejects(service.request(actor,'file_collect',{jobId:'a'.repeat(32),names:['合成包'],unexpected:1}),/参数/);check('native service rejects extra argument keys',true);
 const directId='b'.repeat(32);await service.request(actor,'file_source',{jobId:directId,grant:grant(batch)});
 await assert.rejects(service.request(other,'file_read',{jobId:directId,index:0,offset:0,length:3}),/其他窗口/);check('actual actor ownership prevents cross-window file access',true);
 await assert.rejects(service.request(actor,'file_read',{jobId:directId,index:0,offset:0,length:32769}),/范围/);check('native file read is bounded by approved manifest and chunk size',true);
 await service.request(actor,'file_close',{jobId:directId});await assert.rejects(service.request(actor,'file_source',{jobId:directId,grant:grant(batch)}),/已结束/);check('closed job identifiers cannot be reused',true);
 const recvId='c'.repeat(32);await service.request(actor,'file_receiver',{jobId:recvId,grant:grant(batch)});
 await assert.rejects(service.request(actor,'file_chunk',{jobId:recvId,index:0,offset:0,bytes:'YWJj\n',end:true}),/编码/);await service.request(actor,'file_abort',{jobId:recvId});check('native service rejects noncanonical base64',true);
 const source=await proxy.source(grant(batch),context());assert.equal((await source.read(0,0,3)).toString(),'abc');await source.close();check('renderer proxy reads through native service without renderer Workers',true);
 let notified=0;const receiver=await proxy.receiver(grant(batch),context());await receiver.chunk(0,0,Buffer.from('abc'),true);const result=await receiver.commit(()=>true,()=>notified++);assert.equal(result.status,'committed');assert.equal(result.activated,false);assert.equal(notified,1);assert.equal(commits,1);check('commit event and response notify once and retain activation boundary',true);
 assert.equal((await receiver.abort()).status,'committed');check('proxy cancellation after final commit retains the committed receipt',true);
 const originalReceiver=fake.receiver;fake.receiver=async()=>({commit:async(_live,done)=>{done({status:'committed',id:'4'.repeat(32)});throw Object.assign(Error('late IPC failure'),{code:'BATCH_RECOVERY_REQUIRED'});},abort:async()=>({status:'committed',id:'4'.repeat(32)})});
 let lateNotified=0;const late=await proxy.receiver(grant(batch),context());const lateResult=await late.commit(()=>true,()=>lateNotified++);assert.equal(lateResult.status,'committed');assert.match(lateResult.warning,/收尾未确认/);assert.equal(lateResult.activated,false);assert.equal(lateNotified,1);assert.equal((await late.abort()).status,'committed');fake.receiver=originalReceiver;check('a late commit receipt survives a failed final response without a false rollback',true);
 let authorized=true;const revoked=await proxy.source(grant(batch),context({isAuthorized:()=>authorized}));authorized=false;await new Promise(r=>setTimeout(r,250));await revoked.close();check('renderer authorization revocation cancels the native job',closes>=3);
 fake.source=()=>new Promise(r=>{resolveInit=r;});const pendingId='d'.repeat(32),pending=service.request(actor,'file_source',{jobId:pendingId,grant:grant(batch)});await Promise.resolve();const cancelling=service.request(actor,'file_cancel',{jobId:pendingId});resolveInit({close:async()=>{closes++;return {status:'closed'};}});await assert.rejects(pending,/取消/);await cancelling;check('cancellation during initialization waits for owned cleanup',true);
 const uncertain=createCarrierFilesProxy({ipc:new EventEmitter(),native:{request:async(action)=>{throw Object.assign(Error(action==='file_cancel'?'cleanup unknown':'init cancelled'),{code:action==='file_cancel'?'BATCH_RECOVERY_REQUIRED':'BATCH_CANCELLED'});}}});
 await assert.rejects(uncertain.source(grant(batch),context()),e=>e.code==='BATCH_RECOVERY_REQUIRED');await uncertain.dispose();check('unconfirmed initialization cleanup stays recovery-required',true);
 let commitReply,commitEntered,stillAuthorized=true,cancelNotified=0;const entered=new Promise(r=>{commitEntered=r;}),receipt={status:'committed',id:'5'.repeat(32)};
 const responseOnly=createCarrierFilesProxy({ipc:new EventEmitter(),native:{request:async(action)=>{if(action==='file_receiver')return {ready:true};if(action==='file_commit'){commitEntered();return new Promise(r=>{commitReply=r;});}if(action==='file_cancel')return receipt;throw Error('unexpected response-only action');}}});
 const responseReceiver=await responseOnly.receiver(grant(batch),context({isAuthorized:()=>stillAuthorized}));const committing=responseReceiver.commit(()=>true,()=>cancelNotified++);await entered;stillAuthorized=false;await new Promise(r=>setTimeout(r,250));assert.equal((await responseReceiver.abort()).status,'committed');commitReply({...receipt,activated:false});assert.equal((await committing).status,'committed');assert.equal(cancelNotified,1);await responseOnly.dispose();check('a committed cancel response preserves durable truth when its event is missing',true);
 await proxy.dispose();await service.close();check('service and proxy dispose their own resources',aborts===1);
}
async function crashProbe(){
 const ownRoot=root('crash-only'),g=gate(ownRoot);file(ownRoot,'测试包甲','extension.js','crash-input');const d=disk(ownRoot,g),batch=await d.api.collect(['测试包甲']);
 const threads=require('node:worker_threads'),Original=threads.Worker;let captured;
 threads.Worker=class extends Original{constructor(...args){super(...args);captured=this;}};
 let source;try{source=await d.api.source(grant(batch),context());}finally{threads.Worker=Original;}
 await captured.terminate();await new Promise(r=>setTimeout(r,30));await assert.rejects(source.read(0,0,1),e=>e.code==='BATCH_RECOVERY_REQUIRED');
 assert.equal(g.state.blocked,true);assert.ok(g.state.current);console.log(JSON.stringify({crashFailClosed:true,fixtureRoot:ownRoot}));
}
if(process.argv.includes('--crash-worker')){await crashProbe();}
else{
await synthetic();
if(process.platform==='win32'&&!process.argv.includes('--service-only')){
 const from=root('sender'),to=root('receiver');
 file(from,'测试包甲','extension.js','new-alpha');file(from,'测试包甲','数据/empty.txt','');file(from,'测试包甲','数据/large.bin',Buffer.alloc(70000,7));file(from,'测试包乙','extension.js','new-beta');
 file(to,'测试包甲','extension.js','old-alpha');file(to,'测试包甲','local-extra.txt','preserved');file(to,'测试包乙','extension.js','old-beta');
 const sender=disk(from),receiverDisk=disk(to),batch=await sender.api.collect(['测试包乙','测试包甲']);check('bounded readonly collection hashes every selected file',batch.extensions.length===2&&batch.count===4&&batch.total===70017);
 const denied=disk(from,gate(from),['测试包甲']);await assert.rejects(denied.api.collect(['测试包甲']),/内置/);check('official stock names remain excluded case-insensitively',true);
 await assert.rejects(sender.api.source({...grant(batch),expires:Date.now()-1},context()),/到期/);check('expired consent cannot acquire a file gate',sender.gate.state.acquired===0);
 const source=await sender.api.source(grant(batch),context());let index=0;for(const e of batch.extensions)for(const f of e.files){assert.deepEqual(await source.read(index,0,Math.min(32768,f.size)),bytes(from,e.name,f.path).subarray(0,32768));index++;}await source.close();check('source uses the manifest order and gate spans its full lifetime',sender.gate.state.acquired===1&&sender.gate.state.released===1);
 const racingSource=await sender.api.source(grant(batch),context());const reads=Array.from({length:8},()=>racingSource.read(0,0,1).then(()=>null,e=>e));await racingSource.close();const readOutcomes=await Promise.all(reads);assert.ok(readOutcomes.every(e=>!e||e.code!=='BATCH_RECOVERY_REQUIRED'));check('concurrent source read failures and close share one confirmed cleanup',sender.gate.state.current===null&&!sender.gate.state.blocked);
 const racingReceiver=await receiverDisk.api.receiver(grant(batch),context());const racingIndex=batch.extensions.flatMap(e=>e.files).findIndex(f=>f.size===0);const racingChunk=racingReceiver.chunk(racingIndex,0,Buffer.alloc(0),true).then(()=>null,e=>e);await racingReceiver.abort();assert.notEqual((await racingChunk)?.code,'BATCH_RECOVERY_REQUIRED');check('concurrent chunk failure and abort share one confirmed rollback',receiverDisk.gate.state.current===null&&!receiverDisk.gate.state.blocked);
 const bad=await receiverDisk.api.receiver(grant(batch),context());await assert.rejects(bad.chunk(0,0,Buffer.from('bad'),true),/manifest|size|digest|File|文件|end|length/i);check('a corrupt or truncated received file rolls back without publication',bytes(to,'测试包甲','extension.js').toString()==='old-alpha'&&!fs.existsSync(path.join(to,'nnk-batches','active')));
 const cancelled=await receiverDisk.api.receiver(grant(batch),context());const emptyIndex=batch.extensions.flatMap(e=>e.files).findIndex(f=>f.size===0);await cancelled.chunk(emptyIndex,0,Buffer.alloc(0),true);await cancelled.abort();check('explicit abort preserves the previous full generation',bytes(to,'测试包乙','extension.js').toString()==='old-beta'&&!fs.existsSync(path.join(to,'nnk-batches','active')));
 const deniedGate=receiverDisk.gate;deniedGate.state.denyVerify=deniedGate.state.verifyCount+3;
 const prepared=await receiverDisk.api.receiver(grant(batch),context());await upload(prepared,batch,from);await assert.rejects(prepared.commit(()=>true),/revoked/);check('native revocation after prepare prevents publication and confirms rollback',bytes(to,'测试包甲','extension.js').toString()==='old-alpha'&&bytes(to,'测试包乙','extension.js').toString()==='old-beta'&&!fs.existsSync(path.join(to,'nnk-batches','active')));deniedGate.state.denyVerify=0;
 const concurrent=await receiverDisk.api.receiver(grant(batch),context());await upload(concurrent,batch,from);const stopped=concurrent.commit(()=>false);const aborting=concurrent.abort();await assert.rejects(stopped,/取消|到期/);await aborting;check('concurrent cancel and commit wait for confirmed rollback',bytes(to,'测试包甲','extension.js').toString()==='old-alpha'&&!fs.existsSync(path.join(to,'nnk-batches','active')));
 const complete=await receiverDisk.api.receiver(grant(batch),context());await upload(complete,batch,from);check('all received bytes stay isolated until commit',bytes(to,'测试包甲','extension.js').toString()==='old-alpha');
 let ticks=0,notification=0;const timer=setInterval(()=>ticks++,20);let result;try{result=await complete.commit(()=>true,r=>{assert.equal(r.status,'committed');notification++;});}finally{clearInterval(timer);}
 assert.equal(result.status,'committed');assert.equal(result.activated,false);assert.equal(notification,1);for(const e of batch.extensions)for(const f of e.files)assert.equal(sha(bytes(to,e.name,f.path)),f.sha256);
 check('multiple extensions publish the authorized full generation',true);check('local extra files survive and activation is left explicit',bytes(to,'测试包甲','local-extra.txt').toString()==='preserved');check('filesystem publication keeps the carrier event loop responsive',ticks>5);
 const after=await complete.abort();check('abort after durable commit reports committed instead of rollback',after.status==='committed'&&after.id===result.id);check('completed publication releases gate and active journal',receiverDisk.gate.state.current===null&&!fs.existsSync(path.join(to,'nnk-batches','active')));
 const releaseRoot=root('release-warning'),releaseGate=gate(releaseRoot),originalRelease=releaseGate.releaseGate;
 const releaseDisk=createCarrierFiles({root:releaseRoot,version:'1.11.6',stockExtensions:[],...releaseGate,releaseGate(...args){originalRelease(...args);throw Error('injected release notification failure');}});
 const warned=await releaseDisk.receiver(grant(batch),context());await upload(warned,batch,from);const warnedResult=await warned.commit(()=>true);
 assert.equal(warnedResult.status,'committed');assert.equal(warnedResult.activated,false);assert.match(warnedResult.warning,/收尾未确认/);
 for(const e of batch.extensions)for(const f of e.files)assert.equal(sha(bytes(releaseRoot,e.name,f.path)),f.sha256);
 check('post-commit gate errors retain durable files and explicitly prevent automatic activation',true);
 const hard=root('hardlink');file(hard,'测试包甲','extension.js','entry');fs.linkSync(path.join(hard,'extension','测试包甲','extension.js'),path.join(hard,'extension','测试包甲','linked.js'));await assert.rejects(disk(hard).api.collect(['测试包甲']),/硬链接/);check('readonly collection rejects hardlinked source files',true);
 const crash=await promisify(execFile)(process.execPath,[fileURLToPath(import.meta.url),'--crash-worker'],{windowsHide:true,timeout:45000,env:process.env});assert.match(crash.stdout,/"crashFailClosed":true/);check('a crashed worker keeps the native gate blocked until process recovery',true);
}
console.log(JSON.stringify({passed:results.length,fixtureRoot:base,checks:results},null,2));
}
