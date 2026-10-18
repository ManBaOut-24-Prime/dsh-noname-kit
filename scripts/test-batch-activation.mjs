import assert from 'node:assert/strict';
import {enableBatchExtensions,withBatchActivation} from '../online-kernel/keepalive/batch-activation.js';
let passed=0;
async function test(name,run){await run();passed++;console.log('  ✓ '+name);}
const prefix='noname_0.9_',key=prefix+'config';
const profile={configStorage:{prefix,useDB:false}},dbProfile={configStorage:{prefix,useDB:true}};
const batch={extensions:[{name:'补传甲'},{name:'新增乙'}]};
const stored=(config={extensions:['原扩展'],theme:'user-theme',extension_补传甲_enable:false})=>{
 const records=new Map([[key,JSON.stringify(config)]]);let reads=0,writes=0;
 return {records,get reads(){return reads;},get writes(){return writes;},getItem(name){reads++;return records.get(name)??null;},setItem(name,value){writes++;records.set(name,value);}};
};
function fixture(result={status:'committed',id:'batch-receipt'}){
 let saves=0,commits=0,aborts=0;const reports=[],order=[],receiver={marker:7,chunk(){assert.equal(this,receiver);return 'chunk';},abort(){assert.equal(this,receiver);aborts++;return {status:'closed'};},async commit(live,onCommitted){assert.equal(this,receiver);commits++;if(result.status==='committed'){order.push('file-committed');await onCommitted(result);}return result;}};
 const wrapped=withBatchActivation(receiver,{batch,activate:async names=>{saves++;order.push('configuration-saved');assert.deepEqual(names,['补传甲','新增乙']);return {enabled:true};},onResult:value=>reports.push(value)});
 return {receiver,wrapped,reports,order,get saves(){return saves;},get commits(){return commits;},get aborts(){return aborts;}};
}

await test('local configuration enables the full batch and retains unrelated settings and ordering',async()=>{
 const storage=stored(),result=await enableBatchExtensions({profile,names:['补传甲','新增乙'],storage}),config=JSON.parse(storage.records.get(key));
 assert.deepEqual(result,{enabled:true,names:['补传甲','新增乙'],storage:'localstorage'});assert.deepEqual(config.extensions,['原扩展','补传甲','新增乙']);assert.equal(config.extension_补传甲_enable,true);assert.equal(config.extension_新增乙_enable,true);assert.equal(config.theme,'user-theme');assert.equal(storage.writes,1);
});
await test('an existing enabled name is not registered a second time',async()=>{
 const storage=stored({extensions:['补传甲','原扩展'],extension_补传甲_enable:false});await enableBatchExtensions({profile,names:['补传甲'],storage});assert.deepEqual(JSON.parse(storage.records.get(key)).extensions,['补传甲','原扩展']);
});
await test('configuration uses its live value rather than a stale launch snapshot',async()=>{
 const storage=stored({extensions:['启动后添加'],newSetting:42});await enableBatchExtensions({profile:{...profile,extensions:['旧快照']},names:['新增乙'],storage});const actual=JSON.parse(storage.records.get(key));assert.deepEqual(actual.extensions,['启动后添加','新增乙']);assert.equal(actual.newSetting,42);
});
await test('a missing extensions key uses the official empty default',async()=>{
 const storage=stored({theme:'user-theme'});await enableBatchExtensions({profile,names:['新增乙'],storage});assert.deepEqual(JSON.parse(storage.records.get(key)).extensions,['新增乙']);
});
await test('malformed JSON is retained without resetting user configuration',async()=>{
 const storage=stored();storage.records.set(key,'{broken');await assert.rejects(enableBatchExtensions({profile,names:['新增乙'],storage}),/原游戏配置/);assert.equal(storage.records.get(key),'{broken');assert.equal(storage.writes,0);
});
await test('missing local configuration fails without creating a replacement',async()=>{
 const storage=stored();storage.records.delete(key);await assert.rejects(enableBatchExtensions({profile,names:['新增乙'],storage}),/原游戏配置/);assert.equal(storage.writes,0);assert.equal(storage.records.has(key),false);
});
await test('null and array configuration shapes cannot be overwritten',async()=>{
 for(const shape of [null,[]]){const storage=stored(shape);await assert.rejects(enableBatchExtensions({profile,names:['新增乙'],storage}),/格式无效/);assert.equal(storage.writes,0);}
});
await test('invalid existing extension-list values cannot be discarded',async()=>{
 for(const extensions of [null,'旧扩展',[23]]){const storage=stored({extensions});await assert.rejects(enableBatchExtensions({profile,names:['新增乙'],storage}),/原扩展配置/);assert.equal(storage.writes,0);}
});
await test('a case-alias registration is rejected without changing existing flags',async()=>{
 const storage=stored({extensions:['EXAMPLE'],extension_EXAMPLE_enable:false});await assert.rejects(enableBatchExtensions({profile,names:['example'],storage}),/大小写冲突/);assert.equal(storage.writes,0);assert.equal(JSON.parse(storage.records.get(key)).extension_EXAMPLE_enable,false);
});
await test('storage quota failure preserves the original stored configuration',async()=>{
 const storage=stored(),before=storage.records.get(key);storage.setItem=()=>{throw Error('QuotaExceededError');};await assert.rejects(enableBatchExtensions({profile,names:['新增乙'],storage}),/Quota/);assert.equal(storage.records.get(key),before);
});
await test('success requires a matching persistent readback',async()=>{
 const storage=stored();storage.setItem=()=>{};await assert.rejects(enableBatchExtensions({profile,names:['新增乙'],storage}),/读回不一致/);
});
await test('all invalid incoming names fail before touching configuration',async()=>{
 for(const names of [[],[''],['../bad'],['bad/name'],['联机助手'],['boss'],['a','A'],Array.from({length:65},(_,index)=>'n'+index)]){const storage=stored();await assert.rejects(enableBatchExtensions({profile,names,storage}),/名单无效/);assert.equal(storage.reads,0);assert.equal(storage.writes,0);}
});
await test('a literal prototype-like directory name remains a data key',async()=>{
 const storage=stored();await enableBatchExtensions({profile,names:['__proto__'],storage});const actual=JSON.parse(storage.records.get(key));assert.equal(actual.extension___proto___enable,true);assert.equal(Object.getPrototypeOf(actual),Object.prototype);assert.equal(Object.prototype.enable,undefined);
});
await test('unknown storage mode cannot guess or rewrite configuration',async()=>{
 for(const configStorage of [undefined,{prefix,useDB:'true'},{prefix:'',useDB:false}]){const storage=stored();await assert.rejects(enableBatchExtensions({profile:{configStorage},names:['新增乙'],storage}),/存储信息/);assert.equal(storage.reads,0);}
});
await test('an IndexedDB open failure never falls back to local storage',async()=>{
 const storage=stored(),indexedDB={open(name){assert.equal(name,prefix+'data');const request={};queueMicrotask(()=>request.onerror());return request;}};await assert.rejects(enableBatchExtensions({profile:dbProfile,names:['新增乙'],indexedDB,storage}),/数据库/);assert.equal(storage.reads,0);assert.equal(storage.writes,0);
});
await test('opening a nonexistent database is aborted rather than creating its schema',async()=>{
 let aborted=0;const indexedDB={open(name,...versions){assert.equal(versions.length,0);const request={transaction:{abort(){aborted++;}}};queueMicrotask(()=>request.onupgradeneeded());return request;}};
 await assert.rejects(enableBatchExtensions({profile:dbProfile,names:['新增乙'],indexedDB}),/未找到/);assert.equal(aborted,1);
});
await test('a blocked database reports failure and never changes storage modes',async()=>{
 const storage=stored(),indexedDB={open(){const request={};queueMicrotask(()=>request.onblocked());return request;}};await assert.rejects(enableBatchExtensions({profile:dbProfile,names:['新增乙'],indexedDB,storage}),/占用/);assert.equal(storage.reads,0);
});
await test('a stalled database operation has a bounded result',async()=>{
 await assert.rejects(enableBatchExtensions({profile:dbProfile,names:['新增乙'],indexedDB:{open:()=>({})},timeoutMs:5}),/超时/);
});
await test('a database that opens after timeout is closed without writing',async()=>{
 let request,closed=0;const indexedDB={open(){return request={};}};await assert.rejects(enableBatchExtensions({profile:dbProfile,names:['新增乙'],indexedDB,timeoutMs:5}),/超时/);
 request.result={close(){closed++;},transaction(){assert.fail('a late open cannot write');}};request.onsuccess();assert.equal(closed,1);
});
await test('successful activation follows durable commit notification and requires full restart',async()=>{
 const f=fixture(),result=await f.wrapped.commit(()=>true,()=>f.order.push('durable-notified'));assert.deepEqual(f.order,['file-committed','durable-notified','configuration-saved']);assert.equal(result.status,'committed');assert.equal(result.activated,true);assert.equal(result.restartRequired,true);assert.match(result.reason,/完全退出并重启无名杀/);assert.equal(f.reports.length,1);
});
await test('overlapping and repeated commit calls share exactly one activation',async()=>{
 const f=fixture(),first=f.wrapped.commit(()=>true),second=f.wrapped.commit(()=>true);assert.equal(first,second);assert.equal(await first,await second);assert.equal(await f.wrapped.commit(()=>true),await first);assert.equal(f.commits,1);assert.equal(f.saves,1);assert.equal(f.reports.length,1);
});
await test('cancelled, failed and uncertain file results never enable anything',async()=>{
 for(const status of ['cancelled','failed','unknown','recovery_required']){const f=fixture({status});const result=await f.wrapped.commit(()=>true);assert.equal(result.status,status);assert.equal(f.saves,0);assert.equal(f.reports.length,0);}
});
await test('a committed receipt with a publication warning cannot enable extensions',async()=>{
 const f=fixture({status:'committed',id:'receipt',warning:'cleanup unresolved'}),result=await f.wrapped.commit(()=>true);assert.equal(result.status,'committed');assert.equal(result.activated,false);assert.equal(result.restartRequired,true);assert.equal(f.saves,0);assert.match(result.reason,/收尾尚需确认/);
});
await test('activation failure retains an irreversible successful file receipt',async()=>{
 const f=fixture(),wrapped=withBatchActivation(f.receiver,{batch,activate:async()=>{throw Error('quota');}}),result=await wrapped.commit(()=>true);assert.equal(result.status,'committed');assert.equal(result.id,'batch-receipt');assert.equal(result.activated,false);assert.match(result.reason,/手动检查扩展启用状态/);assert.equal(result.restartRequired,true);
});
await test('an activation callback without positive save confirmation is not success',async()=>{
 const f=fixture(),wrapped=withBatchActivation(f.receiver,{batch,activate:async()=>undefined}),result=await wrapped.commit(()=>true);assert.equal(result.activated,false);assert.equal(result.status,'committed');
});
await test('a file failure before any durable receipt remains a file failure',async()=>{
 let saves=0;const receiver={async commit(){throw Error('write failed');}},wrapped=withBatchActivation(receiver,{batch,activate:async()=>{saves++;return {enabled:true};}});await assert.rejects(wrapped.commit(()=>true),/write failed/);assert.equal(saves,0);
});
await test('an exception after the durable receipt does not pretend rollback occurred',async()=>{
 let saves=0;const receiver={async commit(live,notify){await notify({status:'committed',id:'durable'});throw Error('transport ended');}},wrapped=withBatchActivation(receiver,{batch,activate:async()=>{saves++;return {enabled:true};}}),result=await wrapped.commit(()=>true);assert.equal(result.status,'committed');assert.equal(result.id,'durable');assert.equal(result.activated,false);assert.equal(saves,0);
});
await test('a swallowed durable-notification error cannot be treated as a clean activation',async()=>{
 let saves=0;const receipt={status:'committed',id:'durable'},receiver={async commit(live,notify){try{await notify(receipt);}catch{}return receipt;}},wrapped=withBatchActivation(receiver,{batch,activate:async()=>{saves++;return {enabled:true};}});
 const result=await wrapped.commit(()=>true,()=>{throw Error('notification failed');});assert.equal(result.status,'committed');assert.equal(result.activated,false);assert.match(result.reason,/状态通知需确认/);assert.equal(saves,0);
});
await test('an IPC observer that cannot await notifications still waits before activation',async()=>{
 let saves=0;const receipt={status:'committed',id:'durable'},receiver={async commit(live,notify){notify(receipt);return receipt;}},wrapped=withBatchActivation(receiver,{batch,activate:async()=>{saves++;return {enabled:true};}});
 const result=await wrapped.commit(()=>true,async()=>{await Promise.resolve();throw Error('late notification failed');});assert.equal(result.status,'committed');assert.equal(result.activated,false);assert.match(result.reason,/状态通知需确认/);assert.equal(saves,0);
});
await test('chunk and abort retain the original receiver binding without duplicate activation',async()=>{
 const f=fixture();assert.equal(f.wrapped.chunk(),'chunk');await f.wrapped.commit(()=>true);await f.wrapped.abort();assert.equal(f.aborts,1);assert.equal(f.saves,1);
});
await test('a display callback failure cannot erase a confirmed configuration save',async()=>{
 const f=fixture(),wrapped=withBatchActivation(f.receiver,{batch,activate:async()=>({enabled:true}),onResult(){throw Error('display closed');}});assert.equal((await wrapped.commit(()=>true)).activated,true);
});
await test('batch names are captured before mutable caller data can change',async()=>{
 const mutable={extensions:[{name:'补传甲'}]},receiver={async commit(){return {status:'committed'};}};let actual;const wrapped=withBatchActivation(receiver,{batch:mutable,activate:async names=>{actual=names;return {enabled:true};}});mutable.extensions[0].name='其他扩展';await wrapped.commit(()=>true);assert.deepEqual(actual,['补传甲']);
});
console.log('\n全部通过: '+passed+' 项\n失败: 0 项');
