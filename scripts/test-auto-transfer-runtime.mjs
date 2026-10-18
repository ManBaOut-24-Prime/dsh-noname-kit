import assert from 'node:assert/strict';
import {bundledKernelBuild,bundledKernelVersion,createBridgeSession,kernelRuntimeStatus} from '../src/online.js';
import {CarrierRuntime} from '../online-kernel/keepalive/carrier-runtime.js';
const drain=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
let passed=0;
async function test(name,fn){await fn();passed++;console.log('  ✓ '+name);}
function fixture(){let busy=false,ready=true;const calls=[],waiting=deferred(),errors=[];
 const runtime=Object.assign(Object.create(CarrierRuntime.prototype),{lobby:{},stopped:false,leaving:false,files:{},coordinator:{role:'host',closed:false},autoHealthSeen:new Set(),autoHealthPending:false,
  transfer:{availability:()=>({available:ready,peers:['a','b']}),busy:()=>busy,requestBusy:()=>busy},
  manifest:{readiness:()=>({available:true,pending:false,peers:['a','b']}),recheck:async({peerId})=>{calls.push(peerId);if(peerId==='a')await waiting.promise;}},
  event:(...args)=>errors.push(args)});
 return {runtime,calls,waiting,errors,setBusy:value=>{busy=value;},setReady:value=>{ready=value;}};
}
await test('a busy batch defers other guests without consuming their automatic health checks',async()=>{
 const f=fixture(),r=f.runtime;f.setBusy(true);r.maybeAutoHealth();await drain();assert.deepEqual(f.calls,[]);assert.deepEqual([...r.autoHealthSeen],[]);
 f.setBusy(false);r.maybeAutoHealth();r.maybeAutoHealth();await drain();assert.deepEqual(f.calls,['a']);assert.equal(r.autoHealthPending,true);
 f.setBusy(true);f.waiting.resolve();await drain();r.maybeAutoHealth();await drain();assert.deepEqual(f.calls,['a']);assert.equal(r.autoHealthSeen.has('b'),false);
 f.setBusy(false);r.maybeAutoHealth();await drain();assert.deepEqual(f.calls,['a','b']);r.maybeAutoHealth();await drain();assert.deepEqual(f.calls,['a','b'],'declined/finished guests are not prompted automatically again');
});
await test('an unavailable native or peer capability cannot start automatic health',async()=>{
 const f=fixture();f.setReady(false);f.runtime.maybeAutoHealth();await drain();assert.deepEqual(f.calls,[]);assert.equal(f.runtime.autoHealthSeen.size,0);
});
await test('a replaced coordinator cannot dispatch the queued old check',async()=>{
 const f=fixture();f.runtime.maybeAutoHealth();f.runtime.coordinator={role:'host',closed:false};await drain();assert.deepEqual(f.calls,[]);assert.equal(f.runtime.autoHealthPending,false);
});
await test('explicit leave and closed windows do not schedule automatic checks',async()=>{
 for(const key of ['leaving','stopped']){const f=fixture();f.runtime[key]=true;f.runtime.maybeAutoHealth();await drain();assert.deepEqual(f.calls,[]);}
});
await test('a failed read-only check releases the pending slot and preserves the error',async()=>{
 const f=fixture();f.runtime.manifest.recheck=async()=>{throw Error('fixture unavailable');};f.runtime.maybeAutoHealth();await drain();assert.equal(f.runtime.autoHealthPending,false);assert.equal(f.errors.length,1);assert.equal(f.errors[0][0],'auto-health-deferred');
});
await test('an old running build remains stale after the new files are installed',async()=>{
 const bridge={online:true,kernelVersion:bundledKernelVersion(),kernelBuild:'keepalive-transfer-1-retry',transferPaused:true,bootStage:'ready'};
 assert.notEqual(bundledKernelBuild(),bridge.kernelBuild);assert.equal(kernelRuntimeStatus({state:'ok'},bridge),'restart_required');
});
await test('only the current runtime capability enables the new transfer branch and old heartbeats revoke it',async()=>{
 const session=createBridgeSession({token:'fixture'}),kernel={version:bundledKernelVersion(),build:bundledKernelBuild(),transferPaused:false,transferProtocol:'nnk-transfer/2',stage:'ready'};
 session.poll({kernel});assert.equal(session.snapshot().transferProtocol,'nnk-transfer/2');assert.equal(kernelRuntimeStatus({state:'ok'},session.snapshot()),'b0_active');
 session.poll({kernel:{version:kernel.version,build:kernel.build,transferPaused:false,stage:'ready'}});assert.equal(session.snapshot().transferProtocol,null);assert.equal(kernelRuntimeStatus({state:'ok'},session.snapshot()),'restart_required');
});
console.log('\n全部通过: '+passed+' 项\n失败: 0 项');

