// Production manager + complete production native service with modeled Electron resources.
// No actual game, transport, official files or security configuration is changed.
import {createRequire} from 'node:module';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';import path from 'node:path';import {runInNewContext} from 'node:vm';import {randomUUID} from 'node:crypto';
import {EngineBindingManager} from '../online-kernel/keepalive/engine-binding.js';
const nativeRequire=createRequire(import.meta.url);
const source=readFileSync(new URL('../online-kernel/lib/keepalive-main.cjs',import.meta.url),'utf8');
const lease=(n=1)=>({partySessionId:'party',roundId:'round-'+n,operationId:'operation-'+n,operationGeneration:n,role:'host'});
function fixture(){
 const root=path.resolve('D:/nnk-modeled-native/resources/app'),windows=new Map(),app=new EventEmitter(),ipcMain=new EventEmitter();let sequence=0;
 app.getAppPath=()=>root;
 class WC extends EventEmitter{constructor(win){super();this.id=win.id+100;this.win=win;this.mainFrame={url:'http://localhost:8089/index.html',parent:null};}isDestroyed(){return this.win.dead;}getURL(){return this.mainFrame.url;}getOSProcessId(){return 1000+this.id;}send(){}postMessage(){} }
 class Win extends EventEmitter{constructor(){super();this.id=++sequence;this.dead=false;this.wc=new WC(this);windows.set(this.id,this);}get webContents(){if(this.dead)throw TypeError('Object has been destroyed');return this.wc;}isDestroyed(){return this.dead;}loadURL(url){this.wc.emit('did-start-navigation',{},url,false,true);this.wc.mainFrame.url=url;this.wc.emit('did-frame-navigate',{},url,200,'OK',true);return Promise.resolve();}destroy(){if(this.dead)return;this.dead=true;windows.delete(this.id);this.emit('closed');this.wc.emit('destroyed');}}
 Win.getAllWindows=()=>[...windows.values()];Win.fromId=id=>windows.get(id)||null;Win.fromWebContents=wc=>windows.get(wc.win.id)||null;
 app.on('second-instance',()=>new Win());
 const context={module:{exports:{}},exports:{},__filename:path.join(root,'extension/联机助手/lib/keepalive-main.cjs'),require:name=>name.startsWith('./')?nativeRequire('../online-kernel/lib/'+name.slice(2)):name==='electron'?{app,BrowserWindow:Win,ipcMain}:name==='node:fs'?{lstatSync:()=>({isSymbolicLink:()=>false}),statSync:()=>({isFile:()=>true}),existsSync:()=>false}:name==='node:path'?path:name==='node:crypto'?{randomUUID}:(()=>{throw Error(name);})(),process:{cwd:()=>root,memoryUsage:()=>({})},Buffer,URL,Date,setTimeout,clearTimeout,queueMicrotask};
 runInNewContext(source,context);context.module.exports.ensureInstalled();const carrier=new Win();
 function call(action,...args){const event={sender:carrier.wc,senderFrame:carrier.wc.mainFrame,reply(_name,value){this.response=value;}};ipcMain.emit('nnk-keepalive-native-request',event,{requestId:randomUUID(),action,args});if(!event.response.ok)throw Error(event.response.error.message);return event.response.value;}
 const ordinary=call('classify'),transition=call('beginCarrier',ordinary.bootCapability,{root,origin:'http://localhost:8089'},{action:'create_room'});carrier.loadURL(transition.carrierURL);call('carrierStarted','fixture-carrier');
 const native={onInvalidated:()=>()=>{},createGame:async input=>call('createGame',input),retireGameCreation:async input=>call('retireGameCreation',input),closeGame:async(...args)=>call('closeGame',...args),confirmClosed:async id=>call('confirmClosed',id),snapshot:async()=>call('snapshot')};
 return{call,native,carrier,windows,close(){for(const w of [...windows.values()])w.destroy();app.emit('before-quit');}};
}
let passed=0;async function test(name,fn){await fn();passed++;console.log('ok',name);}
function manager(f,onFailure){return new EngineBindingManager({native:f.native,ipc:new EventEmitter(),onFailure});}
await test('A late create reply is retired by its exact native operation before another factory load',async()=>{
 const f=fixture();let deliver,retirement;const create=f.native.createGame;f.native.createGame=input=>{const actual=f.call('createGame',input);return new Promise(resolve=>deliver=()=>resolve(actual));};
 const m=manager(f,()=>{retirement=m.retire('transport failure');});try{
  const pending=m.create(lease()).catch(e=>e);m.fail(m.current,Error('transport failed before reply'));const retired=await retirement;
  assert.equal(retired.confirmation.confirmed,true);assert.equal(m.current,null);assert.equal(f.call('snapshot').currentEngine,null);assert.equal(f.windows.size,1);
  deliver();assert.match((await pending).message,/旧引擎/);assert.equal(m.current,null);
  const next=await create(lease(2));assert.ok(next.windowId);f.call('retireGameCreation',lease(2));assert.equal(f.windows.size,1);
 }finally{m.dispose();f.close();}
});
await test('A lost create reply is reconciled using main ownership without adopting a stale document',async()=>{
 const f=fixture();f.native.createGame=input=>{f.call('createGame',input);return Promise.reject(Error('Native operation deadline exceeded: createGame'));};let retired;const m=manager(f,()=>{retired=m.retire('creation request timed out');});try{await assert.rejects(m.create(lease()),/deadline/);assert.equal((await retired).confirmation.confirmed,true);assert.equal(m.current,null);assert.equal(f.call('snapshot').currentEngine,null);}finally{m.dispose();f.close();}
});
await test('Cancellation before main receives create installs a generation barrier against the late request',async()=>{
 const f=fixture();f.native.createGame=()=>Promise.reject(Error('create request timeout before delivery'));let retired;const m=manager(f,()=>{retired=m.retire('timeout');});try{await assert.rejects(m.create(lease()),/timeout/);const proof=(await retired).confirmation;assert.equal(proof.ownerAbsent,true);assert.equal(proof.confirmed,true);assert.throws(()=>f.call('createGame',lease()),/Fresh game operation/);assert.equal(f.windows.size,1);const next=f.call('createGame',lease(2));assert.ok(next.windowId);f.call('retireGameCreation',lease(2));}finally{m.dispose();f.close();}
});
await test('Wrong operation fields and stale cancellation cannot destroy the new exact owner',async()=>{
 const f=fixture();try{f.call('createGame',lease());for(const key of ['role','partySessionId','roundId','operationId','operationGeneration']){const bad={...lease(),[key]:key==='operationGeneration'?2:key==='role'?'guest':'wrong'};assert.throws(()=>f.call('retireGameCreation',bad),/does not match/);assert.ok(f.call('snapshot').currentEngine);}
  assert.equal(f.call('retireGameCreation',lease()).confirmed,true);assert.equal(f.call('retireGameCreation',lease()).ownerAbsent,true);const next=f.call('createGame',lease(2));assert.throws(()=>f.call('retireGameCreation',lease()),/does not match/);assert.equal(f.call('snapshot').currentEngine.windowId,next.windowId);f.call('retireGameCreation',lease(2));
 }finally{f.close();}
});
await test('Lost cancellation reply preserves the binding until exact main reconciliation succeeds',async()=>{
 const f=fixture();let rejectCreate;f.native.createGame=input=>{f.call('createGame',input);return new Promise((_resolve,reject)=>rejectCreate=reject);};const cancel=f.native.retireGameCreation;let once=true;f.native.retireGameCreation=async input=>{const value=await cancel(input);if(once){once=false;throw Error('lost cancellation reply');}return value;};const m=manager(f);try{const pending=m.create(lease()).catch(e=>e);await assert.rejects(m.retire('cancel'),/lost cancellation/);assert.ok(m.current);assert.equal(f.call('snapshot').currentEngine,null);const retired=await m.retire('reconcile cancellation');assert.equal(retired.confirmation.ownerAbsent,true);assert.equal(m.current,null);rejectCreate(Error('old request expired'));assert.match((await pending).message,/old request/);}finally{m.dispose();f.close();}
});
await test('A close reply timeout still requires and accepts actual destruction confirmation',async()=>{
 const f=fixture(),created=f.call('createGame',lease()),m=manager(f),close=f.native.closeGame;f.native.closeGame=async(...args)=>{await close(...args);throw Error('lost close reply');};m.current={...created,lease:lease(),scope:null,port:null,status:{},pending:new Map(),closed:false,error:null};try{const retired=await m.retire('close');assert.equal(retired.confirmation.confirmed,true);assert.equal(retired.errors.length,0);assert.equal(retired.warnings.length,1);assert.equal(m.current,null);assert.equal(f.call('snapshot').currentEngine,null);}finally{m.dispose();f.close();}
});
await test('Failed close/confirm retains ownership and a subsequent retirement really retries',async()=>{
 const f=fixture(),created=f.call('createGame',lease()),m=manager(f),close=f.native.closeGame,confirm=f.native.confirmClosed;let attempt=0;f.native.closeGame=async(...args)=>{if(++attempt===1)throw Error('close not delivered');return close(...args);};f.native.confirmClosed=async id=>{if(attempt===1)throw Error('confirmation unavailable');return confirm(id);};m.current={...created,lease:lease(),scope:null,port:null,status:{},pending:new Map(),closed:false,error:null};try{await assert.rejects(m.retire('first'),/confirmation unavailable/);assert.ok(m.current);assert.ok(f.call('snapshot').currentEngine);const result=await m.retire('retry exact owner');assert.equal(attempt,2);assert.equal(result.confirmation.confirmed,true);assert.equal(m.current,null);}finally{m.dispose();f.close();}
});
await test('A carrier close also destroys its pending exact engine and releases its native owner',async()=>{
 const f=fixture();try{f.call('createGame',lease());assert.equal(f.windows.size,2);f.carrier.destroy();for(let i=0;i<8;i++)await Promise.resolve();assert.equal(f.windows.size,0);}finally{f.close();}
});
await test('Retiring in-flight creation closes its pending port and cannot attach it to another generation',async()=>{
 const f=fixture(),m=manager(f);let deliver,closed=0;f.native.createGame=input=>{const value=f.call('createGame',input);return new Promise(resolve=>deliver=()=>resolve(value));};try{const pending=m.create(lease()).catch(e=>e);await m.acceptPort({ports:[{close(){closed++;}}]},{sourceWindowId:55,scope:{sessionId:'party',roundId:'round-1'}});assert.equal(m.pendingPorts.length,1);await m.retire('cancel pending');assert.equal(closed,1);assert.equal(m.pendingPorts.length,0);deliver();assert.match((await pending).message,/旧引擎/);}finally{m.dispose();f.close();}
});
console.log(`全部通过: ${passed} 项（生产JS/原生服务代码、模拟Electron资源；不替代真实原生或双机验证）`);
