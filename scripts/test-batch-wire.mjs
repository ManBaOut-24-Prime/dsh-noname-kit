import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),{Channel,VERSION}=require('../online-kernel/lib/batch-wire.cjs');
const bytes=Buffer.from('export default {};');
const grant={session:'a'.repeat(32),peerSession:'b'.repeat(32),proposal:'c'.repeat(32),digest:'d'.repeat(64),expires:Date.now()+600000,batch:{extensions:[{name:'Fixture',files:[{path:'extension.js',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]}],count:1,total:bytes.length}};
let passed=0;
async function test(name,run){await run();passed++;console.log('  ✓ '+name);}
async function failedGuest({code='BATCH_RECOVERY_REQUIRED',primary='Filesystem permission denied',cleanup='Cannot access another window transfer job',abortResult}={}){
 const reports=[],frames=[];let aborts=0,receivers=0;
 const channel=new Channel({role:'guest',authorize:()=>grant,send:raw=>frames.push(JSON.parse(raw)),report:state=>reports.push(state),
  timers:{setTimeout:()=>({}),clearTimeout:()=>{}},
  receiver:async()=>{receivers++;return {chunk(){},commit(){throw Object.assign(Error(primary),{code});},abort(){aborts++;if(cleanup)throw Error(cleanup);return abortResult||{status:'rolled_back'};}};}});
 const deliver=async(kind,fields={})=>{assert.equal(channel.handle(JSON.stringify({nnk_files:VERSION,from:grant.peerSession,to:grant.session,proposal:grant.proposal,digest:grant.digest,kind,...fields})),true);await channel.current.queue;};
 await channel.granted();
 await deliver('data',{seq:0,index:0,offset:0,end:true,data:bytes.toString('base64')});
 await deliver('finish');
 return {channel,reports,frames,get aborts(){return aborts;},get receivers(){return receivers;}};
}
await test('queued commit recovery failure retains its first cause when native abort rejects a retired job',async()=>{
 const f=await failedGuest();
 assert.equal(f.aborts,1);assert.equal(f.channel.snapshot().status,'recovery_required');assert.equal(f.channel.snapshot().reason,'Filesystem permission denied');
 assert.equal(f.channel.current.cleanupError,'Cannot access another window transfer job');
 assert.ok(f.reports.some(row=>row.status==='recovery_required'));assert.ok(f.reports.filter(row=>row.status==='recovery_required').every(row=>row.reason==='Filesystem permission denied'));
 assert.equal(f.frames.at(-1).kind,'result');assert.equal(f.frames.at(-1).status,'recovery_required');assert.equal(f.frames.at(-1).reason,'Filesystem permission denied');
 await f.channel.granted();assert.equal(f.receivers,1);assert.equal(f.channel.snapshot().fileCommitted,false);await f.channel.close();assert.equal(f.aborts,1);
});
await test('cleanup failure still upgrades an ordinary queued commit failure to recovery required',async()=>{
 const f=await failedGuest({code:'BATCH_IO_ERROR',primary:'Write failed',cleanup:'Rollback could not be confirmed'});
 assert.equal(f.aborts,1);assert.ok(f.reports.some(row=>row.status==='failed'&&row.reason==='Write failed'));
 assert.equal(f.channel.snapshot().status,'recovery_required');assert.equal(f.channel.snapshot().reason,'Rollback could not be confirmed');assert.equal(f.frames.at(-1).status,'recovery_required');
 await f.channel.close();assert.equal(f.aborts,1);
});
await test('confirmed rollback cleanup retains the original recovery cause without claiming a file commit',async()=>{
 const f=await failedGuest({cleanup:''});assert.equal(f.aborts,1);assert.equal(f.channel.snapshot().status,'recovery_required');assert.equal(f.channel.snapshot().reason,'Filesystem permission denied');assert.equal(f.channel.snapshot().fileCommitted,false);assert.equal(f.channel.current.cleanupError,undefined);await f.channel.close();
});
await test('a durable receipt recovered by abort retains committed truth instead of the earlier failure',async()=>{
 const f=await failedGuest({cleanup:'',abortResult:{status:'committed',id:'e'.repeat(32)}});assert.equal(f.aborts,1);assert.equal(f.channel.snapshot().status,'committed_activation_required');assert.equal(f.channel.snapshot().fileCommitted,true);assert.equal(f.channel.snapshot().transactionId,'e'.repeat(32));await f.channel.close();assert.equal(f.aborts,1);
});
await test('an empty primary recovery reason falls back to the bounded cleanup reason',async()=>{
 const f=await failedGuest({primary:'',cleanup:'x'.repeat(300)});assert.equal(f.channel.snapshot().status,'recovery_required');assert.equal(f.channel.snapshot().reason,'x'.repeat(200));assert.equal(f.channel.current.cleanupError.length,200);await f.channel.close();
});
console.log(`\n${passed} batch wire failure cleanup checks passed.`);
