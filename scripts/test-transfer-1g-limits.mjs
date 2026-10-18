import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import testPaths from './fixtures/test-paths.cjs';
const require=createRequire(import.meta.url),lib=path.join(testPaths.sourceRoot(),'online-kernel','lib');
const {MAX_BYTES,MAX_AUTHORIZATION_MS,validGrantExpiry}=require(path.join(lib,'transfer-policy.cjs'));
const {normalize,manifestDigest}=require(path.join(lib,'batch-files.cjs'));
const {CarrierFileService}=require(path.join(lib,'carrier-file-service.cjs'));
const {createCarrierFiles}=require(path.join(lib,'carrier-files.cjs'));
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
const row=(size,file='extension.js')=>({path:file,size,sha256:'0'.repeat(64)});
const batch=(size,extra=0)=>({extensions:[{name:'BoundaryA',files:[row(size)]},{name:'BoundaryB',files:[row(extra)]}]});

await test('native hard limits are exactly 1 GiB and 15 minutes',()=>{
 assert.equal(MAX_BYTES,1073741824);assert.equal(MAX_AUTHORIZATION_MS,900000);
});
await test('full manifest accepts the aggregate 1 GiB boundary without allocating its content',()=>{
 const normalized=normalize(batch(MAX_BYTES-1,1));assert.equal(normalized.total,MAX_BYTES);assert.equal(normalized.count,2);
});
await test('aggregate over 1 GiB by one byte is rejected across different extensions',()=>{
 assert.throws(()=>normalize(batch(MAX_BYTES,1)),/limit/);
});
await test('an oversized single file is rejected before filesystem access',()=>{
 assert.throws(()=>normalize(batch(MAX_BYTES+1)),/limit/);
});
await test('raising the byte limit retains negative, unsafe, alias and traversal rejection',()=>{
 for(const size of [-1,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>normalize(batch(size)),/manifest/);
 for(const file of ['../escape','C:/escape','folder/../escape'])assert.throws(()=>normalize({extensions:[{name:'Safe',files:[row(0),row(1,file)]}]}));
 assert.throws(()=>normalize({extensions:[{name:'Safe',files:[row(0),row(1,'EXTENSION.js')]}]}));
});
await test('the original 4096-file count cap still applies independently of byte size',()=>{
 const files=Array.from({length:4096},(_,i)=>row(0,i?'empty-'+i: 'extension.js'));
 assert.equal(normalize({extensions:[{name:'Safe',files}]}).count,4096);
 assert.throws(()=>normalize({extensions:[{name:'Safe',files:[...files,row(0,'extra')]}]}),/limit/);
});
await test('native expiry allows exactly 15 minutes and rejects extension beyond it',()=>{
 const now=1792317600000;
 assert.equal(validGrantExpiry(now+900000,now),true);assert.equal(validGrantExpiry(now+900001,now),false);
 assert.equal(validGrantExpiry(now,now),false);assert.equal(validGrantExpiry(now-1,now),false);
 for(const expires of [NaN,Infinity,String(now+1),now+0.5,Number.MAX_SAFE_INTEGER+1])assert.equal(validGrantExpiry(expires,now),false);
});
await test('legacy configuration keeps its 300 MiB default and saved lower capacity',()=>{
 const nnk={modules:{},env:{lib:{config:{}},game:{saveConfig(){throw Error('configuration must not be rewritten');}}},state:{}};
 const context={window:{__nnk__:nnk,crypto:webcrypto},console,TextEncoder,Uint8Array,setTimeout,clearTimeout};
 for(const name of ['config','consent','transfer'])runInNewContext(fs.readFileSync(path.join(lib,'../src',name+'.js'),'utf8'),context);
 assert.equal(nnk.modules.config.get('transferLimitMB'),300);
 assert.throws(()=>nnk.modules.consent.normalize(batch(300*1048576+1)),/上限/);
 nnk.env.lib.config.nnk_transferLimitMB=128;
 assert.equal(nnk.modules.config.get('transferLimitMB'),128);
 assert.equal(nnk.modules.consent.normalize(batch(128*1048576)).total,128*1048576);
 assert.throws(()=>nnk.modules.consent.normalize(batch(128*1048576+1)),/上限/);
 nnk.env.lib.config.nnk_transferLimitMB=1024;
 assert.equal(nnk.modules.consent.normalize(batch(MAX_BYTES)).total,MAX_BYTES);
 nnk.env.lib.config.nnk_transferLimitMB=2048;
 assert.throws(()=>nnk.modules.consent.normalize(batch(MAX_BYTES+1)),/上限/);
 assert.equal(nnk.modules.transfer.paused,true);
});

const originalNow=Date.now;let now=1792317600000;
Date.now=()=>now;
function grant(data=batch(1),duration=900000){return {session:'1'.repeat(32),peerSession:'2'.repeat(32),proposal:'3'.repeat(32),digest:manifestDigest(data),expires:now+duration,batch:data};}
function serviceFixture(){
 const actor={},state={opens:0,closes:0,captured:null};
 const service=new CarrierFileService({getDisk:()=>({source:async(value)=>{state.opens++;state.captured=value;return {read:async()=>Buffer.from([0]),close:async()=>{state.closes++;return {status:'closed'};}};}})});
 return {actor,state,service};
}
try{
 await test('native service rejects an overlong grant before creating a file task',async()=>{
  const {actor,state,service}=serviceFixture();
  await assert.rejects(service.request(actor,'file_source',{jobId:'a'.repeat(32),grant:grant(batch(1),900001)}),/授权/);
  assert.equal(service.jobs.size,0);assert.equal(state.opens,0);await service.close();
 });
 await test('native service accepts exact 1 GiB metadata with an exact 15-minute grant',async()=>{
  const {actor,state,service}=serviceFixture();
  await service.request(actor,'file_source',{jobId:'b'.repeat(32),grant:grant(batch(MAX_BYTES))});
  assert.equal(state.captured.batch.total,MAX_BYTES);assert.equal(state.captured.expires,now+900000);await service.close();
 });
 await test('native service independently rejects a one-byte oversized manifest',async()=>{
  const {actor,state,service}=serviceFixture(),value=grant();value.batch=batch(MAX_BYTES,1);
  await assert.rejects(service.request(actor,'file_source',{jobId:'c'.repeat(32),grant:value}),/limit/);
  assert.equal(state.opens,0);assert.equal(service.jobs.size,0);await service.close();
 });
 await test('a repeated job cannot replace the captured expiry or renew its authorization',async()=>{
  const {actor,state,service}=serviceFixture(),jobId='d'.repeat(32),value=grant();
  await service.request(actor,'file_source',{jobId,grant:value});const expires=state.captured.expires;
  now+=1000;value.expires=now+900000;
  await assert.rejects(service.request(actor,'file_source',{jobId,grant:value}),/已结束|标识/);
  assert.equal(state.captured.expires,expires);assert.equal(state.opens,1);await service.close();
 });
 await test('native reads stop at the original expiry even when the caller mutates its input grant',async()=>{
  const {actor,state,service}=serviceFixture(),jobId='e'.repeat(32),value=grant();
  await service.request(actor,'file_source',{jobId,grant:value});const expires=state.captured.expires;
  value.expires+=900000;now=expires;
  await assert.rejects(service.request(actor,'file_read',{jobId,index:0,offset:0,length:1}),/到期/);
  await service.close();assert.equal(state.closes,1);
 });
 await test('the 32768-byte native chunk boundary is unchanged for 1 GiB grants',async()=>{
  const {actor,service}=serviceFixture(),jobId='f'.repeat(32);
  await service.request(actor,'file_source',{jobId,grant:grant(batch(MAX_BYTES))});
  await assert.rejects(service.request(actor,'file_read',{jobId,index:0,offset:0,length:32769}),/范围/);await service.close();
 });
 await test('direct carrier storage rejects overlong grants before acquiring its safety gate',async()=>{
  let acquired=0;const disk=createCarrierFiles({root:testPaths.testPath('native-limit-no-files'),version:'1.11.6',acquireGate:async()=>{acquired++;throw Error('test-gate-boundary');},verifyGate:async()=>({valid:true}),releaseGate:async()=>({released:true})});
  const context={peerId:'peer',owner:{},connectionSessionId:'connection',scope:'scope',isAuthorized:()=>true};
  await assert.rejects(disk.source(grant(batch(1),900001),context),/授权/);assert.equal(acquired,0);
  await assert.rejects(disk.source(grant(batch(1)),context),/test-gate-boundary/);assert.equal(acquired,1);
 });
}finally{Date.now=originalNow;}
console.log(JSON.stringify({passed,kind:'native metadata and service boundaries; not physical transfer evidence'}));
