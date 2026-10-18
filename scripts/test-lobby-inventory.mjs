import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import testPaths from './fixtures/test-paths.cjs';
import {collectLobbyInventory} from '../online-kernel/keepalive/lobby-inventory.js';
import {validLobbyInventory} from '../online-kernel/keepalive/lobby-manifest.js';
globalThis.require=createRequire(import.meta.url);
const root=fs.mkdtempSync(testPaths.tempPrefix('lobby-inventory-'));
const ext=path.join(root,'extension');fs.mkdirSync(path.join(ext,'联机助手','lib'),{recursive:true});
for(const file of ['manifest-files.cjs','transfer-policy.cjs'])fs.copyFileSync(new URL('../online-kernel/lib/'+file,import.meta.url),path.join(ext,'联机助手','lib',file));
for(const name of ['Stock','Enabled','Disabled']){fs.mkdirSync(path.join(ext,name));fs.writeFileSync(path.join(ext,name,'extension.js'),'// '+name);}
const profile={root,version:'1.11.6',stockExtensions:['Stock'],identity:{connectNickname:'玩家',connectAvatar:'caocao'},inventory:{exts:['Enabled'],packs:['standard'],cards:['standard']}};
const tests=[];
async function test(name,fn){try{await fn();tests.push({name,ok:true});}catch(error){tests.push({name,ok:false,error:String(error)});}}
await test('Preload inventory uses a bounded configuration snapshot and current installed file fingerprints',async()=>{
 const m=await collectLobbyInventory(profile);assert.equal(validLobbyInventory(m),true);assert.deepEqual(m.exts,['Enabled']);assert.deepEqual(m.installed,['Disabled','Enabled']);assert.deepEqual(Object.keys(m.contents),['Disabled','Enabled']);assert.equal(m.batchProtocol,0);assert.deepEqual(m.identity,{name:'玩家',avatar:'caocao'});
 const before=m.contents.Enabled.digest;fs.writeFileSync(path.join(ext,'Enabled','extension.js'),'// changed');const fresh=await collectLobbyInventory(profile);assert.notEqual(fresh.contents.Enabled.digest,before);
});
await test('Disk additions and removals are observed without fabricating enabled state',async()=>{
 fs.mkdirSync(path.join(ext,'Added'));fs.writeFileSync(path.join(ext,'Added','extension.js'),'// added');fs.unlinkSync(path.join(ext,'Disabled','extension.js'));
 const m=await collectLobbyInventory(profile);assert.deepEqual(m.installed,['Added','Enabled']);assert.deepEqual(m.exts,['Enabled']);assert.deepEqual(profile.inventory.exts,['Enabled']);
});
await test('Unavailable disk stays unverified and does not expose local paths',async()=>{
 const m=await collectLobbyInventory({...profile,root:path.join(root,'missing')});assert.equal(validLobbyInventory(m),true);assert.ok(m.inventoryError);assert.deepEqual(m.contents,{});assert.ok(!JSON.stringify(m).includes(root));
});
await test('Missing boot snapshot cannot become an empty successful inventory',async()=>{
 await assert.rejects(collectLobbyInventory({...profile,inventory:null}),/配置快照不可用/);
});
await test('Cancelled collection cannot publish an old result',async()=>{
 const controller=new AbortController();controller.abort();await assert.rejects(collectLobbyInventory(profile,{signal:controller.signal}),/取消/);
});
fs.writeFileSync(path.join(root,'RESULTS.json'),JSON.stringify({scope:'Real isolated filesystem; no installed game modifications',tests},null,2));
for(const t of tests)console.log((t.ok?'ok ':'FAIL ')+t.name);console.log(JSON.stringify({out:root,passed:tests.filter(t=>t.ok).length,total:tests.length}));if(tests.some(t=>!t.ok))process.exitCode=1;
