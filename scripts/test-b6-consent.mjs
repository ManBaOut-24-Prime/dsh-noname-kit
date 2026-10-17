#!/usr/bin/env node
import testPaths from './fixtures/test-paths.cjs';
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
const req=createRequire(import.meta.url), base=testPaths.tempDir();mkdirSync(base,{recursive:true})
const root=mkdtempSync(base+'/b6-consent-');
for(const name of ['甲包','乙包']) { mkdirSync(root+'/extension/'+name,{recursive:true});writeFileSync(root+'/extension/'+name+'/extension.js','executable-'+name);writeFileSync(root+'/extension/'+name+'/data.json','{"a":1}') }
const src=n=>readFileSync(new URL('../online-kernel/src/'+n+'.js',import.meta.url),'utf8')
const flush=()=>new Promise(r=>setTimeout(r,2));
export function fixture() {
  const queue=[], sent=[], contexts=[], native=[], timers=new Map();let clock=1000,seq=0;
  const Date2=class extends Date{static now(){return clock}};
  function side(role) {
    const events=[],nnk={modules:{bridge:{emit:(type,data)=>events.push({type,data})},config:{get:()=>300},compat:{gameRoot:()=>root}},state:{},env:{get:{connectNickname:()=> '测试房主'}}};
    const context={window:{__nnk__:nnk,crypto:webcrypto,require:req},TextEncoder,Uint8Array,Date:Date2,console,setTimeout:(fn,ms)=>{timers.set(++seq,{fn,at:clock+ms});return seq},clearTimeout:id=>timers.delete(id),btoa,atob};
    runInNewContext(src('consent'),context);runInNewContext(src('rtc'),context);contexts.push(context);
    const c={readyState:'open',send(raw){sent.push({role,raw});queue.push({role,raw})},close(){this.readyState='closed';this.onclose?.()}};
    const s=role==='host'?new nnk.modules.rtc.HostBridge(c):new nnk.modules.rtc.FakeWebSocket(c);
    s.onmessage=raw=>native.push({role,raw});return {nnk,c,s,events,api:nnk.modules.consent};
  }
  const host=side('host'),guest=side('guest');
  function tick(ms){clock+=ms;for(const [id,t]of [...timers])if(t.at<=clock){timers.delete(id);t.fn()}}
  async function pump(){for(let i=0;i<12;i++){while(queue.length){const m=queue.shift(),dest=m.role==='host'?guest:host;dest.c.onmessage?.({data:m.raw})}await flush()}}
  const snapshot=s=>s.api.snapshot().at(-1),binding=s=>{const q=snapshot(s);return Object.fromEntries(['session','peerSession','proposal','digest'].map(k=>[k,q[k]]))};
  async function offer(){tick(0);await pump();assert.equal(await host.api.propose({ws:host.s},['甲包','乙包']),true);await pump();return binding(guest)}
  return {host,guest,queue,sent,native,timers,tick,pump,offer,snapshot,binding,contexts};
}
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('  ✓ '+name)}catch(e){failed++;console.error('  ✗ '+name+': '+e.stack)}}
await test('complete metadata is real, deterministic and no content/native frames are sent',async()=>{
  const k=fixture();await k.offer();const q=k.snapshot(k.guest);assert.equal(q.status,'pending');assert.equal(q.batch.extensions.length,2);assert.equal(q.batch.count,4);
  assert.equal(q.batch.total,Buffer.byteLength('executable-甲包executable-乙包{"a":1}{"a":1}'));
  assert.ok(k.sent.every(m=>!m.raw.includes('executable-')&&!m.raw.includes('"content"')));assert.equal(k.native.length,0)
})
await test('only local explicit boolean yes authorizes exact full batch, still paused',async()=>{
  const k=fixture(),b=await k.offer();assert.equal(k.guest.api.decide({...b,yes:'true'}),false);assert.equal(k.guest.api.decide({...b,yes:true}),true);await k.pump();
  assert.equal(k.snapshot(k.host).status,'authorized_paused');assert.equal(k.snapshot(k.guest).status,'authorized_paused');assert.equal(k.snapshot(k.guest).transferPaused,true);
  assert.equal(k.guest.api.decide({...b,yes:true}),false)
})
await test('refusal converges and repeated manifest cannot silently propose again',async()=>{const k=fixture(),b=await k.offer();k.guest.api.decide({...b,yes:false});await k.pump();assert.equal(k.snapshot(k.host).status,'declined');assert.equal(k.snapshot(k.guest).status,'declined');assert.equal(await k.host.api.propose(k.host.s,['甲包','乙包']),false)})
for(const who of ['host','guest'])await test(who+' cancel before yes converges',async()=>{const k=fixture(),b=await k.offer();k[who].api.cancel(k.binding(k[who]));await k.pump();assert.equal(k.snapshot(k.host).status,'cancelled');assert.equal(k.snapshot(k.guest).status,'cancelled');assert.equal(k.guest.api.decide({...b,yes:true}),false)})
for(const who of ['host','guest'])await test(who+' cancel after authorization revokes it',async()=>{const k=fixture(),b=await k.offer();k.guest.api.decide({...b,yes:true});await k.pump();k[who].api.cancel(k.binding(k[who]));await k.pump();assert.equal(k.snapshot(k.host).status,'cancelled');assert.equal(k.snapshot(k.guest).status,'cancelled')})
await test('timeout converges and late yes has no effect',async()=>{const k=fixture(),b=await k.offer();k.tick(120000);await k.pump();assert.equal(k.snapshot(k.host).status,'expired');assert.equal(k.snapshot(k.guest).status,'expired');assert.equal(k.guest.api.decide({...b,yes:true}),false);assert.equal(k.timers.size,0)})
await test('lost result eventually expires accepting and authorized peers',async()=>{const k=fixture(),b=await k.offer();k.guest.api.decide({...b,yes:true});const decision=k.queue.shift();k.host.c.onmessage({data:decision.raw});k.queue.length=0;assert.equal(k.snapshot(k.guest).status,'accepting');k.tick(120000);await k.pump();assert.equal(k.snapshot(k.host).status,'expired');assert.equal(k.snapshot(k.guest).status,'expired')})
for(const yes of [true,false])await test('lost '+yes+' receipt recovers via bounded idempotent retry',async()=>{const k=fixture(),b=await k.offer();k.guest.api.decide({...b,yes});const decision=k.queue.shift();k.host.c.onmessage({data:decision.raw});k.queue.length=0;k.tick(2000);await k.pump();assert.equal(k.snapshot(k.guest).status,yes?'authorized_paused':'declined');assert.equal(k.snapshot(k.host).status,k.snapshot(k.guest).status)})
await test('lost refusal receipts expire and converge to the stronger terminal state',async()=>{const k=fixture(),b=await k.offer();k.guest.api.decide({...b,yes:false});const decision=k.queue.shift();k.host.c.onmessage({data:decision.raw});k.queue.length=0;k.tick(120000);await k.pump();assert.equal(k.snapshot(k.host).status,'expired');assert.equal(k.snapshot(k.guest).status,'expired')})
await test('racing cancellation and timeout converge without reviving auth',async()=>{const k=fixture();await k.offer();k.host.api.cancel(k.binding(k.host));k.tick(120000);await k.pump();assert.equal(k.snapshot(k.host).status,'cancelled');assert.equal(k.snapshot(k.guest).status,'cancelled')})
await test('heartbeat summaries retain binding and actual totals without file lists',async()=>{const k=fixture();await k.offer();const summary=k.guest.api.summaries()[0];assert.equal(summary.digest,k.snapshot(k.guest).digest);assert.equal(summary.batch.count,4);assert.equal(summary.batch.extensions[0].fileCount,2);assert.equal(summary.batch.extensions[0].files,undefined);assert.ok(k.guest.events.every(e=>!e.data?.batch))})
await test('actual kernel heartbeat dispatch verifies local IDs before granting consent',async()=>{
  const k=fixture(),b=await k.offer(),ctx=k.contexts[1],bodies=[];ctx.location={origin:'https://probe'};ctx.window.addEventListener=()=>{};ctx.AbortController=AbortController;ctx.setInterval=()=>0;
  ctx.fetch=(url,opts)=>{if(!opts?.body)return Promise.resolve({ok:true,json:async()=>({baseUrl:'https://bridge',token:'test'})});bodies.push(JSON.parse(opts.body));return Promise.resolve({ok:true,json:async()=>({commands:[{action:'batch_decision',args:{...b,session:'0'.repeat(32),yes:true}},{action:'batch_decision',args:{...b,yes:true}}]})})};
  runInNewContext(src('bridge'),ctx);k.guest.nnk.modules.bridge.init();await k.pump();assert.equal(k.snapshot(k.guest).status,'authorized_paused');assert.equal(bodies[0].state.batchProposals[0].digest,b.digest);assert.equal(bodies[0].state.batchProposals[0].batch.extensions[0].files,undefined)
})
await test('guest disposal and natural host close invalidate auth without replacing native close',async()=>{const k=fixture(),b=await k.offer();k.guest.api.decide({...b,yes:true});await k.pump();let h=0,g=0;k.host.s.onclose=()=>h++;k.guest.s.onclose=()=>g++;k.guest.s.dispose();k.host.c.close();assert.equal(k.snapshot(k.guest).status,'disconnected');assert.equal(g,0);assert.equal(h,1);assert.equal(k.timers.size,0)})
for(const key of ['session','peerSession','proposal','digest'])await test('stale '+key+' cannot authorize',async()=>{const k=fixture(),b=await k.offer();assert.equal(k.guest.api.decide({...b,[key]:'0'.repeat(key==='digest'?64:32),yes:true}),false);assert.equal(k.snapshot(k.guest).status,'pending')})
await test('reconnection rejects every old decision binding',async()=>{const a=fixture(),old=await a.offer();a.guest.s.dispose();const k=fixture();await k.offer();assert.equal(k.guest.api.decide({...old,yes:true}),false)})
await test('duplicate offer is idempotent; changed same-ID batch revokes authorization',async()=>{const k=fixture(),b=await k.offer();const raw=k.sent.find(x=>JSON.parse(x.raw).kind==='offer').raw;k.guest.c.onmessage({data:raw});await k.pump();k.guest.api.decide({...b,yes:true});await k.pump();const changed=JSON.parse(raw);changed.batch.extensions[0].files[0].sha256='0'.repeat(64);k.guest.c.onmessage({data:JSON.stringify(changed)});await k.pump();assert.equal(k.snapshot(k.guest).status,'failed');assert.equal(k.snapshot(k.host).status,'failed')})
await test('duplicate yes and forged remote results cannot grant guest consent',async()=>{const k=fixture();await k.offer();const q=k.snapshot(k.guest);k.guest.c.onmessage({data:JSON.stringify({nnk_batch:2,kind:'result',from:q.peerSession,to:q.session,proposal:q.proposal,digest:q.digest,status:'authorized_paused'})});await k.pump();assert.equal(k.snapshot(k.guest).status,'pending')})
await test('old capability or arbitrary content frame never reaches native engine',async()=>{const k=fixture();k.tick(0);await k.pump();for(const nnk_batch of [1,3])k.guest.c.onmessage({data:JSON.stringify({nnk_batch,kind:'offer'})});await k.pump();assert.equal(k.native.length,0);assert.ok(k.guest.events.some(e=>e.type==='batch_upgrade'))})
await test('ordinary native transport is preserved',async()=>{const k=fixture();k.host.c.onmessage({data:'["normal"]'});k.guest.c.onmessage({data:'["normal"]'});assert.equal(k.native.length,2)})
for(const bad of ['../escape','C:/escape','a\\b','a./x','NUL.txt','a /b','a\u0000b','x:stream','/absolute'])await test('unsafe file path rejected '+JSON.stringify(bad),()=>{const k=fixture();assert.throws(()=>k.host.api.normalize({extensions:[{name:'安全',files:[{path:'extension.js',size:0,sha256:'a'.repeat(64)},{path:bad,size:0,sha256:'a'.repeat(64)}]}]}))})
for(const paths of [['A','a'],['a','a/b']])await test('Windows path collision '+paths.join('/'),()=>{const k=fixture();assert.throws(()=>k.host.api.normalize({extensions:[{name:'安全',files:['extension.js',...paths].map(path=>({path,size:0,sha256:'a'.repeat(64)}))}]}))})
await test('oversize, missing entry and duplicate extension reject whole proposal',()=>{const k=fixture(),f={path:'extension.js',size:0,sha256:'a'.repeat(64)};for(const extensions of [[{name:'安全',files:[{...f,size:301*1048576}]}],[{name:'安全',files:[{...f,path:'data'}]}],[{name:'A',files:[f]},{name:'a',files:[f]}]])assert.throws(()=>k.host.api.normalize({extensions}))})
await test('cancel racing asynchronous digest cannot show fresh pending proposal',async()=>{const k=fixture();k.tick(0);await k.pump();await k.host.api.propose(k.host.s,['甲包','乙包']);const msg=k.queue.shift();k.guest.c.onmessage({data:msg.raw});k.guest.api.cancelAll();await k.pump();assert.equal(k.snapshot(k.guest).status,'cancelled');assert.equal(k.snapshot(k.host).status,'cancelled')})
await test('actual UI renders choices without implicit yes and sends immutable binding',async()=>{
  const source=readFileSync(new URL('../client.js',import.meta.url),'utf8'),start=source.indexOf('function renderBatchProposals()'),end=source.indexOf('\n      function renderManifestCard',start),commands=[];
  const k=fixture();await k.offer();const q=k.snapshot(k.guest),bridge={state:{batchProposals:[q]}},h=(t,p,...children)=>({t,p,children:children.flat()}),e=(t,c,x)=>h(t,{className:c},x);
  let confirmed=false,confirmCalls=0;const renderImpl=new Function('bridge','bridgeOnline','h','e','sendCmd','window','batchUi','setBatchUi',source.slice(start,end)+';return renderBatchProposals();');
  const render=(...args)=>renderImpl(...args,{confirm:()=>{confirmCalls++;return confirmed}},{},()=>{});const tree=render(bridge,true,h,e,(...args)=>commands.push(args));assert.equal(commands.length,0);
  const all=[];function walk(n){if(!n||typeof n!=='object')return;all.push(n);n.children?.forEach(walk)}tree.forEach(walk);
  const yes=all.find(n=>n.t==='button'&&n.children[0]==='是'),no=all.find(n=>n.t==='button'&&n.children[0]==='否'),cancel=all.find(n=>n.t==='button'&&n.children[0]==='终止本次补传');assert.ok(yes&&no&&cancel);
  const notice='选择‘是’将接收或更新所列扩展，并自动启用它们；部分扩展需要重启无名杀后生效。';
  const copy=all.flatMap(n=>n.children.filter(c=>typeof c==='string'));
  assert.ok(copy.includes(notice),'Guest must see synchronization and activation disclosure before choosing');assert.ok(copy.indexOf(notice)<copy.indexOf('是'));
  for(const name of ['甲包','乙包'])assert.ok(copy.some(s=>s.includes(name)));assert.ok(copy.some(s=>s.includes('来源：')&&s.includes('个文件')&&s.includes('字节')));
  yes.p.onClick();assert.equal(confirmCalls,0,'Yes must not introduce a second activation confirmation');assert.equal(commands[0][0],'batch_decision');assert.deepEqual(commands[0][1],{...k.binding(k.guest),yes:true});no.p.onClick();assert.equal(commands[1][1].yes,false);cancel.p.onClick();assert.equal(commands.length,2);confirmed=true;cancel.p.onClick();assert.equal(commands[2][0],'batch_cancel');assert.deepEqual(commands[2][1],k.binding(k.guest));
  q.status='declined';assert.ok(JSON.stringify(render(bridge,true,h,e,()=>{})).includes('已拒绝'));assert.ok(!JSON.stringify(render(bridge,false,h,e,()=>{})).includes('终止本次补传'))
})
console.log(`\n${failed?'失败 '+failed:'全部通过: '+passed+' 项'}; fixture retained at ${root}`);if(failed)process.exitCode=1
