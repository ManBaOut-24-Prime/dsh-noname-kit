// Memory regressions for metadata routing and socket/request ownership.
// This fixture does not run the official game or provide two-machine evidence.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {deferred,drain} from './fixtures/guest-lifecycle.mjs';
import {endpointManifestFixture} from './fixtures/endpoint-manifest-lifecycle.mjs';

const source=name=>readFileSync(new URL('../online-kernel/src/'+name+'.js',import.meta.url),'utf8');
let passed=0;
async function test(name,fn){await fn();passed++;console.log('  ✓ '+name)}
function fixture({missing=false,propose,sendError=false}={}){
    const events=[],timers=new Map(),resumed=[],proposals=[],scans=[];
    let timerId=0,clock=0,directCalls=0;
    const lib={config:{extensions:['A'],extension_A_enable:true,all:{stockextension:[]}},characterPack:{},cardPack:{},message:{client:{},server:{}}};
    const nnk={version:'test',state:{host:{bridges:[]}},env:{lib,get:{connectNickname:()=> 'fixture'},game:{send(){}},_status:{}},modules:{
        config:{get:()=>[]},compat:{gameRoot:()=>'/fixture'},bridge:{emit:(type,data)=>events.push({type,data})},
        batch:{capability:2,handle:()=>false},guest:{resumeEntry:socket=>resumed.push(socket)},
        transfer:{pauseReason:'补传已暂停',sendDirect(){directCalls++;throw Error('metadata must not use file route')}},
        consent:{attach(){},detach(){},handle:()=>false,propose(socket,names){proposals.push({socket,names:[...names]});return propose?propose(socket,names):Promise.resolve(false)}}
    }};
    const fakeRequire=name=>name==='node:path'?{join:(...parts)=>parts.join('/')}:
        name==='node:fs'?{readdirSync:()=>['A'],existsSync:()=>true}:
        {scan(root,names,options){scans.push(options);return {A:{digest:'a'.repeat(64)}}}};
    const context={window:{__nnk__:nnk,require:fakeRequire},Date,console,btoa,atob,
        setTimeout(fn,ms){timers.set(++timerId,{fn,ms,at:clock+ms});return timerId},clearTimeout:id=>timers.delete(id),
        setInterval(){throw Error('unexpected interval')},clearInterval(){}};
    runInNewContext(source('manifest'),context);runInNewContext(source('rtc'),context);nnk.modules.manifest.install();
    function make(role='guest',stage='lobby'){
        const sent=[];
        const channel={readyState:role==='guest'?'connecting':'open',send(raw){if(sendError)throw Error('send failed');sent.push(JSON.parse(raw))},close(){this.readyState='closed';this.onclose?.()}};
        const socket=new nnk.modules.rtc[role==='guest'?'FakeWebSocket':'HostBridge'](channel);
        socket._entered=stage==='entered';socket._queued=stage==='queued';
        if(role==='host')nnk.state.host.bridges.push(socket);
        if(role==='guest'){nnk.env.game.ws=socket;channel.readyState='open';channel.onopen()}
        return {socket,channel,sent,request:()=>sent.at(-1)?.[2]};
    }
    function tick(ms){clock+=ms;for(const [id,t]of [...timers])if(t.at<=clock){timers.delete(id);t.fn()}}
    const manifest={exts:missing?[]:['A'],installed:missing?[]:['A'],packs:[],cards:[],inventoryVersion:1,contents:missing?{}:{A:{digest:'a'.repeat(64)}}};
    const diff={exts:{missing:missing?['A']:[],changed:[],matching:missing?[]:['A']}};
    return {nnk,events,timers,resumed,proposals,scans,make,tick,manifest,diff,directCalls:()=>directCalls,
        diffs:()=>events.filter(e=>e.type==='manifest_diff'),checks:()=>events.filter(e=>e.type==='manifest_check'),lastCheck:()=>events.filter(e=>e.type==='manifest_check').at(-1)?.data};
}

for(const stage of ['lobby','queued','entered'])for(const missing of [false,true]){
    await test(stage+' manifest reply uses only the live request socket; missing='+missing,async()=>{
        const k=fixture({missing}),peer=k.make('host',stage),other=k.make('host',stage);
        peer.channel.onmessage({data:JSON.stringify(['nnk_manifest',k.manifest,1])});await drain();
        assert.equal(peer.sent.length,1);assert.equal(peer.sent[0][0],'nnk_manifest_diff');assert.equal(peer.sent[0][2],1);
        assert.equal(peer.sent[0][1].exts.missing.length,missing?1:0);assert.equal(other.sent.length,0);assert.equal(k.directCalls(),0);
        assert.equal(k.proposals.length,missing?1:0);
    });
}
await test('legacy request and native server dispatch return compatible metadata',async()=>{
    const k=fixture(),peer=k.make('host');
    k.nnk.env.lib.message.server.nnk_manifest.call({ws:peer.socket},k.manifest);await drain();
    assert.equal(peer.sent.length,1);assert.equal(peer.sent[0].length,2);
    k.nnk.env.lib.message.server.nnk_manifest.call({},k.manifest);await drain();assert.equal(peer.sent.length,1);
});
await test('guest tagged and legacy replies complete the current check without timeout',()=>{
    for(const tagged of [false,true]){
        const k=fixture(),peer=k.make();assert.equal(k.timers.size,1);
        const packet=tagged?['nnk_manifest_diff',k.diff,peer.request()]:['nnk_manifest_diff',k.diff];
        peer.channel.onmessage({data:JSON.stringify(packet)});
        assert.equal(k.resumed.length,1);assert.equal(k.events.filter(e=>e.type==='manifest_diff').length,1);assert.equal(k.timers.size,0);
        assert.equal(k.nnk.modules.manifest.beforeEnter(peer.socket),true);const count=k.events.length;k.tick(15000);assert.equal(k.events.length,count);
        assert.equal(k.lastCheck().status,'verified');assert.equal(k.diffs()[0].data.verification,'verified');
    }
});
for(const method of ['dispose','close','natural'])await test('guest '+method+' detaches once, clears timer and isolates late paths',()=>{
    const k=fixture(),old=k.make(),staleMessage=old.channel.onmessage,staleOpen=old.channel.onopen,oldTimer=[...k.timers.values()][0].fn;
    let engineCloses=0;old.socket.onclose=()=>engineCloses++;
    if(method==='natural')old.channel.close();else old.socket[method]();
    k.nnk.modules.manifest.detach(old.socket);assert.equal(k.timers.size,0);
    assert.equal(k.lastCheck().status,'closed');assert.equal(k.checks().filter(e=>e.data.status==='closed').length,1);
    const count=k.events.length,raw=JSON.stringify(['nnk_manifest_diff',k.diff,old.request()]);
    staleMessage({data:raw});staleOpen();oldTimer();
    k.nnk.env.lib.message.client.nnk_manifest_diff(k.diff,old.request());
    assert.equal(k.nnk.modules.manifest.handle(old.socket,raw),true);k.nnk.modules.manifest.recheck();k.tick(15000);
    assert.equal(k.events.length,count);assert.equal(k.resumed.length,0);assert.equal(k.timers.size,0);
    assert.equal(engineCloses,method==='dispose'?0:1);
});
await test('closed old socket cannot apply its result to a fresh connection or native dispatch',()=>{
    const k=fixture(),old=k.make();old.socket.dispose();const fresh=k.make();assert.notEqual(old.request(),fresh.request());
    k.nnk.modules.manifest.handle(old.socket,JSON.stringify(['nnk_manifest_diff',k.diff,old.request()]));
    k.nnk.env.lib.message.client.nnk_manifest_diff(k.diff,old.request());
    assert.equal(k.resumed.length,0);assert.equal(k.timers.size,1);
    fresh.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff,fresh.request()])});assert.deepEqual(k.resumed,[fresh.socket]);
});
await test('recheck replaces its timer and rejects earlier request completion',()=>{
    const k=fixture(),peer=k.make(),oldRequest=peer.request(),oldTimer=[...k.timers.values()][0].fn;
    k.nnk.modules.manifest.recheck();const request=peer.request();assert.notEqual(request,oldRequest);assert.equal(k.timers.size,1);
    assert.equal(k.scans.at(-1).force,true);const count=k.events.length;oldTimer();assert.equal(k.events.length,count);
    peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff,oldRequest])});assert.equal(k.events.length,count);assert.equal(k.resumed.length,0);
    peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff,request])});assert.equal(k.resumed.length,1);assert.equal(k.timers.size,0);
    peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff,request])});assert.equal(k.resumed.length,1);
});
await test('tagged peer cannot downgrade a new check to an uncorrelated legacy result',()=>{
    const k=fixture(),peer=k.make();peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff,peer.request()])});
    k.nnk.modules.manifest.recheck();peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff])});
    assert.equal(k.resumed.length,1);assert.equal(k.timers.size,1);
    peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff,peer.request()])});assert.equal(k.resumed.length,2);assert.equal(k.timers.size,0);
});
await test('legacy reply cannot complete a later explicit recheck after first success',()=>{
    const k=fixture(),peer=k.make();peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff])});
    k.nnk.modules.manifest.recheck();peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff])});assert.equal(k.resumed.length,1);assert.equal(k.timers.size,1);
    assert.equal(k.diffs().length,1);assert.equal(k.lastCheck().status,'unverified');assert.equal(k.nnk.modules.manifest.beforeEnter(peer.socket),false);
    peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff,peer.request()])});assert.equal(k.resumed.length,2);assert.equal(k.timers.size,0);
});
await test('current timeout resumes once and late reply stays silent; recheck gets a fresh timeout',()=>{
    const k=fixture(),peer=k.make();k.tick(15000);assert.equal(k.resumed.length,1);assert.equal(k.lastCheck().status,'unverified');const count=k.events.length;
    peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff,peer.request()])});assert.equal(k.events.length,count);
    k.nnk.modules.manifest.recheck();assert.equal(k.timers.size,1);k.tick(15000);assert.equal(k.resumed.length,2);assert.equal(k.diffs().length,0);
    assert.equal(k.checks().filter(e=>e.data.status==='unverified').length,2);
});
for(const method of ['close','natural','detach'])await test('host '+method+' suppresses awaited consent completion and stale dispatch',async()=>{
    const wait=deferred(),k=fixture({missing:true,propose:()=>wait.promise}),peer=k.make('host'),staleMessage=peer.channel.onmessage;
    peer.channel.onmessage({data:JSON.stringify(['nnk_manifest',k.manifest,1])});assert.equal(k.proposals.length,1);
    if(method==='natural')peer.channel.close();else if(method==='detach')k.nnk.modules.manifest.detach(peer.socket);else peer.socket.close();
    const count=k.events.length;wait.resolve(false);await drain();assert.equal(peer.sent.length,0);
    staleMessage({data:JSON.stringify(['nnk_manifest',k.manifest,2])});
    k.nnk.env.lib.message.server.nnk_manifest.call({ws:peer.socket},k.manifest,3);await drain();
    assert.equal(k.proposals.length,1);assert.equal(k.events.length,count);
});
await test('overlapping host request sends only the latest consent completion',async()=>{
    const waits=[deferred(),deferred()];let index=0;const k=fixture({missing:true,propose:()=>waits[index++].promise}),peer=k.make('host');
    for(const request of [1,2])peer.channel.onmessage({data:JSON.stringify(['nnk_manifest',k.manifest,request])});
    waits[1].resolve(false);await drain();assert.equal(peer.sent.length,1);assert.equal(peer.sent[0][2],2);
    waits[0].resolve(false);await drain();assert.equal(peer.sent.length,1);
});
await test('late rejected host operation cannot report a failure in a retired connection',async()=>{
    const wait=deferred(),k=fixture({missing:true,propose:()=>wait.promise}),peer=k.make('host');
    peer.channel.onmessage({data:JSON.stringify(['nnk_manifest',k.manifest,1])});peer.socket.close();const count=k.events.length;
    wait.reject(Error('late failure'));await drain();assert.equal(k.events.length,count);assert.equal(peer.sent.length,0);
});
await test('native client dispatch requires tagged ownership and cannot associate anonymous legacy data',()=>{
    const k=fixture(),peer=k.make(),client=k.nnk.env.lib.message.client;
    client.nnk_manifest_diff(k.diff,peer.request()+1);assert.equal(k.resumed.length,0);
    client.nnk_manifest_diff(k.diff);assert.equal(k.resumed.length,0);assert.equal(k.timers.size,1);assert.equal(k.lastCheck().status,'pending');
    client.nnk_manifest_diff(k.diff,peer.request());assert.equal(k.resumed.length,1);assert.equal(k.timers.size,0);
    peer.socket.dispose();const count=k.events.length;client.nnk_manifest_diff(k.diff);assert.equal(k.events.length,count);
    k.nnk.env.game.ws=null;client.nnk_manifest_diff(k.diff);assert.equal(k.events.length,count);
});
await test('unrelated game messages remain available to native dispatch',()=>{
    const k=fixture(),peer=k.make();let received=0;peer.socket.onmessage=()=>received++;
    peer.channel.onmessage({data:JSON.stringify(['game_message',{}])});assert.equal(received,1);
});
await test('actual Guest cancellation disposes the check and cannot resume from a late result',async()=>{
    // Exercise endpoint retirement with the actual manifest module and
    // FakeWebSocket; late callbacks must not restore the cancelled check.
    const k=endpointManifestFixture(),socket=await k.prepare(),staleMessage=socket.channel.onmessage,
        staleOpen=socket.channel.onopen,stalePortMessage=k.port.onmessage,checkTimer=[...k.timers.values()].find(t=>t.ms===15000).fn;
    const request=k.sent().find(value=>value.payload[0]==='nnk_manifest');assert.ok(request);
    const ack=await k.cancel(),count=k.events.length,raw=JSON.stringify(['nnk_manifest_diff',{exts:{missing:[]}},request.payload[2]]);
    assert.equal(k.timers.size,0);staleMessage({data:raw});staleOpen();checkTimer();
    stalePortMessage({data:{type:'game',scope:k.scope,peerId:'actual-host-fixture',seq:99,raw}});
    k.nnk.env.lib.message.client.nnk_manifest_diff({exts:{missing:[]}},request.payload[2]);await drain();
    assert.equal(k.events.length,count);assert.equal(k.port.closed,1);assert.equal(k.core.snapshot().facadeAttached,false);
    assert.equal(ack.moduleResources.manifest.live,0);assert.equal(ack.moduleResources.manifest.pendingTimers,0);assert.equal(k.stats().reloads,0);
});
await test('current endpoint native preparation and init remain informational while health is pending',async()=>{
    const k=endpointManifestFixture();try{
        const socket=await k.prepare();assert.equal(k.nnk.modules.manifest.beforeEnter(socket),false);assert.equal(k.stats().nativeOpens,1);
        await k.game(JSON.stringify(['init','current-online-id']),1);assert.equal(k.nnk.env.game.onlineID,'current-online-id');
        assert.ok(k.sent().some(value=>value.payload[0]==='inited'));assert.equal(k.timers.size,1);
        const fresh=await k.command('manifest_fresh',{},'operation');assert.equal(fresh.ok,true);assert.equal(fresh.value.admissionGate,false);assert.equal(k.scans.at(-1).force,true);
        k.tick(15000);assert.ok(k.events.some(value=>value.type==='manifest_check'&&value.data.status==='unverified'));
        assert.equal(k.nnk.env.game.onlineID,'current-online-id');assert.equal(k.stats().reloads,0);
    }finally{await k.cancel();}
});
await test('current endpoint rejects old scope health replies before they reach the actual manifest',async()=>{
    const k=endpointManifestFixture();try{
        await k.prepare();const request=k.sent().find(value=>value.payload[0]==='nnk_manifest').payload[2];
        const before=k.events.length,raw=JSON.stringify(['nnk_manifest_diff',{exts:{missing:[]}},request]);
        await k.game(raw,999,{...k.scope,documentGeneration:99});assert.equal(k.events.length,before);assert.equal(k.timers.size,1);
        await k.game(raw,1);assert.equal(k.timers.size,0);assert.ok(k.events.some(value=>value.type==='manifest_check'&&value.data.status==='verified'));
        const event=k.port.messages.findLast(value=>value.type==='module-event'&&value.name==='manifest_check');assert.deepEqual(event.scope,k.scope);
    }finally{await k.cancel();}
});
for(const trigger of ['replace-first','timeout-recheck','legacy-success-recheck','stale-numbered']){
    await test('ambiguous legacy '+trigger+' cannot replace the current tagged missing result',()=>{
        const k=fixture(),peer=k.make(),oldRequest=peer.request();
        if(trigger==='timeout-recheck')k.tick(15000);
        if(trigger==='legacy-success-recheck')peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff])});
        if(trigger!=='stale-numbered')k.nnk.modules.manifest.recheck();
        else peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff,oldRequest+100])});
        const request=peer.request(),timer=[...k.timers.keys()][0],resumes=k.resumed.length,diffs=k.diffs().length;
        peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff])});
        assert.equal(k.resumed.length,resumes);assert.equal(k.diffs().length,diffs);assert.equal(k.nnk.modules.manifest.beforeEnter(peer.socket),false);
        assert.equal(k.timers.size,1);assert.equal([...k.timers.keys()][0],timer);assert.equal(k.lastCheck().status,'unverified');assert.match(k.lastCheck().reason,/本次尚未核验/);
        const missing={exts:{missing:['A'],changed:[],matching:[]}};
        peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',missing,request])});
        assert.equal(k.resumed.length,resumes+1);assert.equal(k.timers.size,0);assert.equal(k.diffs().length,diffs+1);
        assert.deepEqual([...k.diffs().at(-1).data.exts.missing],['A']);assert.equal(k.lastCheck().status,'verified');
    });
}
await test('legacy result arriving after the first timeout remains unverified without another resume',()=>{
    const k=fixture(),peer=k.make();k.tick(15000);const resumed=k.resumed.length,count=k.events.length;
    peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff])});
    assert.equal(k.resumed.length,resumed);assert.equal(k.events.length,count);assert.equal(k.timers.size,0);assert.equal(k.diffs().length,0);assert.equal(k.lastCheck().status,'unverified');
});
await test('late legacy matching result cannot overwrite a current numbered missing result',()=>{
    const k=fixture(),peer=k.make(),missing={exts:{missing:['A'],changed:[],matching:[]}};
    peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',missing,peer.request()])});const count=k.events.length;
    peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff])});
    assert.equal(k.events.length,count);assert.equal(k.resumed.length,1);assert.equal(k.timers.size,0);assert.equal(k.lastCheck().status,'verified');assert.deepEqual([...k.diffs().at(-1).data.exts.missing],['A']);
});
await test('duplicate first legacy success cannot overwrite its completed check state',()=>{
    const k=fixture(),peer=k.make();peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff])});const count=k.events.length;
    peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff])});
    assert.equal(k.events.length,count);assert.equal(k.resumed.length,1);assert.equal(k.timers.size,0);assert.equal(k.lastCheck().status,'verified');assert.equal(k.diffs().length,1);
});
await test('failed first send leaves explicit unverified state and forbids later legacy completion',()=>{
    const k=fixture({sendError:true}),peer=k.make();assert.equal(k.lastCheck().status,'unverified');assert.equal(k.timers.size,0);assert.equal(k.resumed.length,1);
    peer.channel.send=raw=>peer.sent.push(JSON.parse(raw));k.nnk.modules.manifest.recheck();assert.equal(k.lastCheck().status,'pending');
    peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff])});assert.equal(k.resumed.length,1);assert.equal(k.timers.size,1);assert.equal(k.diffs().length,0);
    peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff,peer.request()])});assert.equal(k.resumed.length,2);assert.equal(k.lastCheck().status,'verified');
});
await test('fresh reconnection allows its first bound legacy reply while retired anonymous dispatch is ignored',()=>{
    const k=fixture(),old=k.make(),oldId=k.lastCheck().peerId;old.socket.dispose();const fresh=k.make(),freshId=k.lastCheck().peerId;
    assert.notEqual(oldId,freshId);k.nnk.env.lib.message.client.nnk_manifest_diff(k.diff);assert.equal(k.resumed.length,0);assert.equal(k.diffs().length,0);assert.equal(k.lastCheck().status,'pending');
    k.nnk.modules.manifest.handle(old.socket,JSON.stringify(['nnk_manifest_diff',k.diff]));assert.equal(k.resumed.length,0);
    fresh.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff])});assert.equal(k.resumed.length,1);assert.equal(k.lastCheck().peerId,freshId);assert.equal(k.lastCheck().status,'verified');
});
await test('received correlation metadata is replaced by local connection and current request',()=>{
    const k=fixture(),peer=k.make(),pending=k.lastCheck(),remote={...k.diff,peerId:'foreign',request:900,role:'host',verification:'unverified',hostIdentity:{name:'Host'}};
    peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',remote,peer.request()])});const result=k.diffs().at(-1).data;
    assert.equal(result.peerId,pending.peerId);assert.equal(result.request,peer.request());assert.equal(result.role,'guest');assert.equal(result.verification,'verified');assert.equal(k.lastCheck().identity.name,'Host');
});
await test('host local results have bound status metadata without adding ownership fields to wire data',async()=>{
    const k=fixture(),peer=k.make('host');peer.channel.onmessage({data:JSON.stringify(['nnk_manifest',k.manifest,91])});await drain();
    const checks=k.checks(),result=k.diffs().at(-1).data;assert.deepEqual(checks.map(e=>e.data.status),['pending','verified']);
    assert.equal(result.peerId,checks[0].data.peerId);assert.equal(result.request,91);assert.equal(result.role,'host');assert.equal(result.verification,'verified');
    assert.equal(peer.sent[0][1].peerId,undefined);assert.equal(peer.sent[0][1].request,undefined);assert.equal(peer.sent[0][1].verification,undefined);
});
await test('same request number on distinct host peers retains independent current statuses',async()=>{
    const waits=[deferred(),deferred()];let i=0;const k=fixture({missing:true,propose:()=>waits[i++].promise}),a=k.make('host'),b=k.make('host');
    for(const peer of [a,b])peer.channel.onmessage({data:JSON.stringify(['nnk_manifest',k.manifest,1])});
    const pending=k.checks().map(e=>e.data);assert.notEqual(pending[0].peerId,pending[1].peerId);assert.equal(k.diffs().length,0);
    waits[0].resolve(false);await drain();waits[1].resolve(false);await drain();assert.equal(k.diffs().length,2);
    assert.equal(k.checks().filter(e=>e.data.status==='verified').length,2);assert.equal(a.sent.length,1);assert.equal(b.sent.length,1);
});
await test('separate module boots cannot reuse peer ids in retained UI events',()=>{
    const a=fixture(),b=fixture();a.make();b.make();assert.notEqual(a.lastCheck().peerId,b.lastCheck().peerId);
});

console.log(`\n全部通过: ${passed} 项（内存模拟；不替代官方原生集成或真人双机验收）`);
