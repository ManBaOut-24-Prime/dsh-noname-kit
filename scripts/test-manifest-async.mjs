// Real temporary filesystem inventory and synthetic endpoint scheduling.
// These checks are not native game, settlement, or two-machine evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import testPaths from './fixtures/test-paths.cjs';
import {endpointManifestFixture} from './fixtures/endpoint-manifest-lifecycle.mjs';
import {deferred,drain} from './fixtures/guest-lifecycle.mjs';
const {scan,scanAsync}=createRequire(import.meta.url)('../online-kernel/lib/manifest-files.cjs');
let passed=0;
async function test(name,fn){await fn();passed++;console.log('  ✓ '+name);}
const base=testPaths.tempDir();fs.mkdirSync(base,{recursive:true});
function disk(){const root=fs.mkdtempSync(path.join(base,'async-health-'));fs.mkdirSync(path.join(root,'extension/A/nested'),{recursive:true});fs.writeFileSync(path.join(root,'extension/A/extension.js'),'entry');fs.writeFileSync(path.join(root,'extension/A/nested/bytes.bin'),Buffer.alloc(2*1048576,7));return root;}
await test('async forced inventory matches actual sync bytes and yields to the event loop',async()=>{
 const root=disk(),expected=scan(root,['A'],{force:true});let turns=0;const timer=setInterval(()=>turns++,0);
 try{assert.deepEqual(await scanAsync(root,['A'],{force:true}),expected);assert.ok(turns>0);}finally{clearInterval(timer);}
 fs.writeFileSync(path.join(root,'extension/A/extension.js'),'other');const changed=await scanAsync(root,['A'],{force:true});assert.notEqual(changed.A.digest,expected.A.digest);
});
await test('async inventory keeps missing, invalid name and linked file errors explicit',async()=>{
 const root=disk();fs.linkSync(path.join(root,'extension/A/extension.js'),path.join(root,'extension/A/alias.js'));
 const value=await scanAsync(root,['A','missing','../escape'],{force:true});assert.match(value.A.error,/非常规/);assert.ok(value.missing.error);assert.match(value['../escape'].error,/名称无效/);
});
await test('abort during actual asynchronous scanning rejects instead of publishing an inventory',async()=>{
 const root=disk(),controller=new AbortController(),work=scanAsync(root,['A'],{force:true,signal:controller.signal});controller.abort(Error('retired-current-scope'));
 await assert.rejects(work,/retired-current-scope/);assert.deepEqual(await scanAsync(root,['A'],{force:true}),scan(root,['A'],{force:true}));
});
await test('prepare-guest and actual endpoint native init proceed while health scan is unresolved',async()=>{
 const wait=deferred(),k=endpointManifestFixture({scanWait:wait});
 try{await k.prepare();assert.equal(k.stats().nativeOpens,1);assert.equal(k.nnk.modules.manifest.resourceSnapshot().pendingScans,1);assert.equal(k.sent().some(v=>v.payload[0]==='nnk_manifest'),false);
  await k.game(JSON.stringify(['init','fresh-seat']),1);assert.equal(k.nnk.env.game.onlineID,'fresh-seat');assert.ok(k.sent().some(v=>v.payload[0]==='inited'));
  wait.resolve();await drain();assert.ok(k.sent().some(v=>v.payload[0]==='nnk_manifest'));assert.equal(k.nnk.modules.manifest.resourceSnapshot().pendingScans,0);
 }finally{wait.resolve();await drain();await k.cancel();}
});
await test('retired scan completion cannot send metadata or update the next document',async()=>{
 const wait=deferred(),k=endpointManifestFixture({scanWait:wait});await k.prepare();const signal=k.scans[0].signal;
 const ack=await k.cancel(),events=k.events.length,sent=k.sent().length;assert.equal(signal.aborted,true);assert.equal(ack.moduleResources.manifest.pendingScans,1);
 wait.resolve();await drain();assert.equal(k.sent().length,sent);assert.equal(k.events.length,events);assert.equal(k.nnk.modules.manifest.resourceSnapshot().pendingScans,0);assert.equal(k.nnk.modules.manifest.resourceSnapshot().pendingChecks,0);
});
await test('fresh health operation retirement aborts its captured scan and rejects late completion',async()=>{
 const wait=deferred(),k=endpointManifestFixture({scanWait:wait});await k.prepare();const operation=k.command('manifest_fresh',{},'operation');await drain();
 assert.equal(k.scans.length,2);await k.cancel();assert.ok(k.scans.every(v=>v.signal.aborted));wait.resolve();await drain();await operation;
 assert.equal(k.core.resourceSnapshot().operations.pendingExecutions,0);assert.equal(k.nnk.modules.manifest.resourceSnapshot().pendingScans,0);
});
console.log(`\n全部通过: ${passed} 项（文件系统与内存调度；不替代原生或双机验收）`);
