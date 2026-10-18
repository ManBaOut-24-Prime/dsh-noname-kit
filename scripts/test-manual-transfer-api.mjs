import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=fs.readFileSync(path.join(root,'index.js'),'utf8');
const start=source.indexOf("if (req.method === 'POST' && url.pathname === '/noname-kit-api/online/command') {");
const end=source.indexOf("if (req.method === 'GET' && url.pathname === '/noname-kit-api/extension') {",start);
assert.ok(start>=0&&end>start,'actual command route boundaries exist');
const route=source.slice(start,end);
let passed=0,failed=0;
const valid=()=>({peerId:'当前客机',scope:{carrierSessionId:'当前房间',partyEpoch:0}});
async function invoke(args,{body={action:'batch_request',args},state={}}={}){
 const calls={queued:[],revoke:0,writes:0,settings:0};
 const trap=()=>{calls.writes++;throw Error('command must not invoke file or configuration writes');};
 const sandbox={serializedBody:JSON.stringify(body),req:{method:'POST'},url:{pathname:'/noname-kit-api/online/command'},nonameDir:'unused-game-root',
  json:(status,value)=>({status,value:JSON.parse(JSON.stringify(value))}),
  bridge:{snapshot:()=>({state}),pushCommand:(action,value)=>{calls.queued.push({action,args:JSON.parse(JSON.stringify(value))});return {id:'queued-command'};}},
  revokeBatch:()=>{calls.revoke++;},writeJsonAtomicSync:trap,writeFileSync:trap,writeSettingsFile:trap,
  readSettingsFile:()=>{calls.settings++;throw Error('manual transfer request must not read settings');},settingsPath:'unused-settings',console:{log:trap,warn:trap,error:trap}};
 const result=await vm.runInNewContext('(async()=>{const requestBody=JSON.parse(serializedBody);async function readBody(){return requestBody;}\n'+route+'\n})()',sandbox,{timeout:3000});
 return {result,calls};
}
async function test(name,fn){try{await fn();passed++;console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name+': '+error.message);}}
function noWrites(calls){assert.equal(calls.revoke,0);assert.equal(calls.writes,0);assert.equal(calls.settings,0);}
for(const [name,args] of [['current peer and scope',valid()],['maximum bounded identifiers',{peerId:'p'.repeat(160),scope:{carrierSessionId:'s'.repeat(160),partyEpoch:Number.MAX_SAFE_INTEGER}}]]){
 await test('valid '+name+' is queued without changing its payload',async()=>{const {result,calls}=await invoke(args);assert.equal(result.status,200);assert.equal(result.value.ok,true);assert.deepEqual(calls.queued,[{action:'batch_request',args}]);noWrites(calls);});
}
await test('stale bridge availability is not substituted for runtime authority',async()=>{const args=valid(),{result,calls}=await invoke(args,{state:{transferScope:{carrierSessionId:'older-room',partyEpoch:99},transferAvailable:false}});assert.equal(result.status,200);assert.deepEqual(calls.queued,[{action:'batch_request',args}]);noWrites(calls);});
const invalid=[
 ['missing arguments',undefined],['null arguments',null],['array arguments',[]],['string arguments','peer'],
 ['missing peer',{scope:valid().scope}],['empty peer',{peerId:'',scope:valid().scope}],['numeric peer',{peerId:1,scope:valid().scope}],['oversized peer',{peerId:'p'.repeat(161),scope:valid().scope}],
 ['missing scope',{peerId:'peer'}],['null scope',{peerId:'peer',scope:null}],['array scope',{peerId:'peer',scope:[]}],['string scope',{peerId:'peer',scope:'scope'}],
 ['missing carrier session',{peerId:'peer',scope:{partyEpoch:0}}],['empty carrier session',{peerId:'peer',scope:{carrierSessionId:'',partyEpoch:0}}],['numeric carrier session',{peerId:'peer',scope:{carrierSessionId:1,partyEpoch:0}}],['oversized carrier session',{peerId:'peer',scope:{carrierSessionId:'s'.repeat(161),partyEpoch:0}}],
 ['missing epoch',{peerId:'peer',scope:{carrierSessionId:'scope'}}],['negative epoch',{peerId:'peer',scope:{carrierSessionId:'scope',partyEpoch:-1}}],['fractional epoch',{peerId:'peer',scope:{carrierSessionId:'scope',partyEpoch:0.5}}],['unsafe epoch',{peerId:'peer',scope:{carrierSessionId:'scope',partyEpoch:Number.MAX_SAFE_INTEGER+1}}],['string epoch',{peerId:'peer',scope:{carrierSessionId:'scope',partyEpoch:'0'}}],['null epoch',{peerId:'peer',scope:{carrierSessionId:'scope',partyEpoch:null}}],
 ['extra scope field',{peerId:'peer',scope:{...valid().scope,path:'extension/包'}}],
 ...['path','folder','names','extensions','files','yes','legacy','protocol','session','peerSession','proposal','digest'].map(key=>['extra '+key,{...valid(),[key]:key==='yes'?true:key==='names'||key==='extensions'||key==='files'?['任意包']:'injected'}]),
];
for(const [name,args] of invalid)await test('rejects '+name+' without queueing or writing',async()=>{const {result,calls}=await invoke(args);assert.equal(result.status,400);assert.equal(result.value.ok,false);assert.deepEqual(calls.queued,[]);noWrites(calls);});
await test('legacy transfer remains rejected and cannot be selected through the new command',async()=>{const {result,calls}=await invoke(null,{body:{action:'transfer_pack',args:{name:'任意包'}}});assert.equal(result.status,409);assert.equal(result.value.code,'TRANSFER_PAUSED');assert.deepEqual(calls.queued,[]);noWrites(calls);});
const bridgeSource=fs.readFileSync(path.join(root,'online-kernel/src/bridge.js'),'utf8');
const dispatchStart=bridgeSource.indexOf('async function dispatch(cmd) {'),dispatchEnd=bridgeSource.indexOf('/* 命令执行报错',dispatchStart);
assert.ok(dispatchStart>=0&&dispatchEnd>dispatchStart,'actual bridge dispatcher boundaries exist');
const dispatchCode=bridgeSource.slice(dispatchStart,dispatchEnd)+'\ndispatch';
await test('carrier override receives the unchanged manual command before ordinary routing',async()=>{const cmd={id:'queued-command',action:'batch_request',args:valid()};let received;
 const dispatch=vm.runInNewContext(dispatchCode,{commandOverride:async value=>{received=value;return 'carrier-result';}});
 assert.equal(await dispatch(cmd),'carrier-result');assert.equal(received,cmd);assert.equal(received.args,cmd.args);
});
await test('ordinary game dispatcher rejects manual transfer without opening an engine or disk path',async()=>{let touched=0;const trap=new Proxy({},{get(){touched++;throw Error('ordinary dispatch must stop before engine or disk access');}});
 const dispatch=vm.runInNewContext(dispatchCode,{commandOverride:null,nnk:trap});
 await assert.rejects(dispatch({action:'batch_request',args:valid()}),/插件房间/);assert.equal(touched,0);
});
console.log(JSON.stringify({passed,failed,kind:'actual-http-command-handler',realNetwork:false,gameWrites:false},null,2));
if(failed)process.exitCode=1;
