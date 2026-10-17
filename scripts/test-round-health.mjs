import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import {createRequire} from 'node:module';
import testPaths from './fixtures/test-paths.cjs';import {endpointManifestFixture} from './fixtures/endpoint-manifest-lifecycle.mjs';import {drain} from './fixtures/guest-lifecycle.mjs';
const client=fs.readFileSync(path.join(testPaths.sourceRoot(),'client.js'),'utf8'),context={};
vm.runInNewContext(client.slice(client.indexOf('    function onlinePickEvent('),client.indexOf('    function onlineEventText('))+';this.pick=onlineManifestCheck;',context);
const old={sessionId:'party',roundId:'old',documentGeneration:3,bindingId:'b3',bindingNonce:'n3'},next={...old,roundId:'new',documentGeneration:6,bindingId:'b6',bindingNonce:'n6'};
const event=(type,scope,status)=>({type,data:{scope,peerId:'same-actual-peer',request:1,role:'guest',status,verification:'verified',exts:{matching:['A']}}});
let count=0;async function test(label,run){await run();count++;console.log('  ✓ '+label);}
await test('Old green health remains reference only before the new round has any response',async()=>{
 const events=[event('manifest_check',old,'pending'),event('manifest_diff',old),event('manifest_check',old,'verified')],current=context.pick(events,next);
 assert.equal(current.verified,false);assert.equal(current.check,null);assert.equal(current.diff,null);assert.ok(current.reference);
});
await test('Same peer/request late old-round and old-nonce results cannot replace the current pending check',async()=>{
 const events=[event('manifest_check',next,'pending'),event('manifest_diff',old),event('manifest_check',old,'verified'),event('manifest_diff',{...next,bindingNonce:'old-nonce'}),event('manifest_check',{...next,bindingNonce:'old-nonce'},'verified')];
 const current=context.pick(events,next);assert.equal(current.verified,false);assert.equal(current.check.status,'pending');assert.equal(current.diff,null);
 events.push(event('manifest_diff',next),event('manifest_check',next,'verified'));assert.equal(context.pick(events,next).verified,true);
});
await test('Scoped failure is unverified even when the history contains a current-round earlier success',async()=>{
 const events=[event('manifest_check',next,'pending'),event('manifest_diff',next),event('manifest_check',next,'verified'),{...event('manifest_check',next,'pending'),data:{...event('manifest_check',next,'pending').data,request:2}},{...event('manifest_check',next,'unverified'),data:{...event('manifest_check',next,'unverified').data,request:2}}];assert.equal(context.pick(events,next).verified,false);
});
await test('Native facade health forces new reads and reports the stable actual peer identity',async()=>{
 const k=endpointManifestFixture();try{await k.prepare();await drain();assert.ok(k.scans.length>0);assert.ok(k.scans.every(scan=>scan.force===true));const checks=k.events.filter(event=>event.type==='manifest_check');assert.ok(checks.length>0);assert.ok(checks.every(event=>event.data.peerId==='actual-host-fixture'));}finally{await k.cancel();}
});
await test('Forced async inventory detects same-size bytes with original metadata restored',async()=>{
 const {scan,scanAsync}=createRequire(import.meta.url)('../online-kernel/lib/manifest-files.cjs'),root=fs.mkdtempSync(path.join(testPaths.tempDir(),'round-health-'));fs.mkdirSync(path.join(root,'extension/A'),{recursive:true});const file=path.join(root,'extension/A/extension.js');fs.writeFileSync(file,'old bytes');const before=scan(root,['A'],{force:true}),stat=fs.statSync(file);fs.writeFileSync(file,'new bytes');fs.utimesSync(file,stat.atime,stat.mtime);const next=await scanAsync(root,['A'],{force:true});assert.notEqual(next.A.digest,before.A.digest);
});
console.log('\n全部通过: '+count+' 项\n失败: 0 项');
