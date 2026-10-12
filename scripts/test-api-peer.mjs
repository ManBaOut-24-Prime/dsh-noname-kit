import testPaths from './fixtures/test-paths.cjs';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createBridgeSession} from '../src/online.js';
import {batchStatus,revokeBatch} from '../src/batch.js';
const index=readFileSync(new URL('../index.js',import.meta.url),'utf8'),body=index.slice(index.indexOf('handler: async (req, res) => {')+'handler: '.length,index.lastIndexOf('\n  }))')).trim();
const bridge=createBridgeSession({token:'peer-test'}),binding={session:'a'.repeat(32),peerSession:'b'.repeat(32),proposal:'c'.repeat(32),digest:'d'.repeat(64)};
bridge.poll({state:{batchProposals:[binding]}});
const handler=runInNewContext('('+body+')',{URL,Buffer,Date,console,bridge,bridgeToken:bridge.token,active:true,nonameDir:testPaths.testPath("temp/no-peer-transaction"),revokeBatch,batchStatus,kernelStatus:()=>({}),bundledKernelVersion:()=>'',kernelRuntimeStatus:()=>({}),readSettingsFile:()=>({})});
async function request(url,peer,origin,command){let status,value;await handler({url,method:command?'POST':'GET',headers:{host:'127.0.0.1:34567','content-type':'application/json',...(origin===undefined?{}:{origin})},socket:{remoteAddress:peer},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(command))}},{writeHead:s=>status=s,end:s=>value=JSON.parse(s)});return {status,value}}
let passed=0;async function test(label,fn){await fn();passed++;console.log('  ✓ '+label)}
for(const origin of [undefined,'https://outside.invalid','http://127.0.0.1:34567'])await test('remote peer rejected for commands and sensitive reads, Origin='+origin,async()=>{
  assert.equal((await request('/noname-kit-api/online/command','192.0.2.20',origin,{action:'batch_decision',args:{...binding,yes:true}})).status,403);
  assert.equal((await request('/noname-kit-api/online/status','192.0.2.20',origin)).status,403);
  assert.equal(bridge.poll({}).commands.length,0);
});
await test('missing trusted peer is rejected even with matching Origin',async()=>assert.equal((await request('/noname-kit-api/online/status',undefined,'http://127.0.0.1:34567')).status,403));
for(const peer of ['127.0.0.1','::1','::ffff:127.0.0.1'])await test('actual local peer can read binding and submit explicit bound decision '+peer,async()=>{
  bridge.poll({state:{batchProposals:[binding]}});assert.equal((await request('/noname-kit-api/online/status',peer,'http://127.0.0.1:34567')).status,200);
  assert.equal((await request('/noname-kit-api/online/command',peer,'http://127.0.0.1:34567',{action:'batch_decision',args:{...binding,yes:true}})).status,200);
  const commands=bridge.poll({}).commands;assert.equal(commands.length,1);assert.equal(JSON.stringify(commands[0].args),JSON.stringify({...binding,yes:true}));
});
await test('local peer does not bypass cross-origin read or command protection',async()=>{assert.equal((await request('/noname-kit-api/online/status','127.0.0.1','https://outside.invalid')).status,403);assert.equal((await request('/noname-kit-api/online/command','127.0.0.1','https://outside.invalid',{action:'batch_decision',args:{...binding,yes:true}})).status,403)});
await test('game bridge remains independently token authenticated',async()=>assert.equal((await request('/noname-kit-api/online/bridge','127.0.0.1','http://127.0.0.1:8089',{token:'incorrect'})).status,403));
await test('bridge token cannot expose commands to a remote peer with claimed local Origin',async()=>assert.equal((await request('/noname-kit-api/online/bridge','192.0.2.20','http://127.0.0.1:8089',{token:bridge.token})).status,403));
console.log(`全部通过: ${passed} 项`);
