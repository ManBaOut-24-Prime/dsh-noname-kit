// Memory regressions for metadata routing and socket/request ownership.
// This fixture does not run the official game or provide two-machine evidence.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {fixture as guestFixture,deferred,drain} from './fixtures/guest-lifecycle.mjs';

const source=name=>readFileSync(new URL('../online-kernel/src/'+name+'.js',import.meta.url),'utf8');
let passed=0;
async function test(name,fn){await fn();passed++;console.log('  ✓ '+name)}
function fixture({missing=false,propose}={}){
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
        const channel={readyState:role==='guest'?'connecting':'open',send:raw=>sent.push(JSON.parse(raw)),close(){this.readyState='closed';this.onclose?.()}};
        const socket=new nnk.modules.rtc[role==='guest'?'FakeWebSocket':'HostBridge'](channel);
        socket._entered=stage==='entered';socket._queued=stage==='queued';
        if(role==='host')nnk.state.host.bridges.push(socket);
        if(role==='guest'){nnk.env.game.ws=socket;channel.readyState='open';channel.onopen()}
        return {socket,channel,sent,request:()=>sent.at(-1)?.[2]};
    }
    function tick(ms){clock+=ms;for(const [id,t]of [...timers])if(t.at<=clock){timers.delete(id);t.fn()}}
    const manifest={exts:missing?[]:['A'],installed:missing?[]:['A'],packs:[],cards:[],inventoryVersion:1,contents:missing?{}:{A:{digest:'a'.repeat(64)}}};
    const diff={exts:{missing:missing?['A']:[],changed:[],matching:missing?[]:['A']}};
    return {nnk,events,timers,resumed,proposals,scans,make,tick,manifest,diff,directCalls:()=>directCalls};
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
        assert.equal(k.nnk.modules.manifest.beforeEnter(peer.socket),true);k.tick(15000);assert.equal(k.events.length,1);
    }
});
for(const method of ['dispose','close','natural'])await test('guest '+method+' detaches once, clears timer and isolates late paths',()=>{
    const k=fixture(),old=k.make(),staleMessage=old.channel.onmessage,staleOpen=old.channel.onopen,oldTimer=[...k.timers.values()][0].fn;
    let engineCloses=0;old.socket.onclose=()=>engineCloses++;
    if(method==='natural')old.channel.close();else old.socket[method]();
    k.nnk.modules.manifest.detach(old.socket);assert.equal(k.timers.size,0);
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
    assert.equal(k.scans.at(-1).force,true);oldTimer();assert.equal(k.events.length,0);
    peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff,oldRequest])});assert.equal(k.events.length,0);assert.equal(k.resumed.length,0);
    peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff,request])});assert.equal(k.resumed.length,1);assert.equal(k.timers.size,0);
    peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff,request])});assert.equal(k.resumed.length,1);
});
await test('tagged peer cannot downgrade a new check to an uncorrelated legacy result',()=>{
    const k=fixture(),peer=k.make();peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff,peer.request()])});
    k.nnk.modules.manifest.recheck();peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff])});
    assert.equal(k.resumed.length,1);assert.equal(k.timers.size,1);
    peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff,peer.request()])});assert.equal(k.resumed.length,2);assert.equal(k.timers.size,0);
});
await test('legacy peer can respond to a later explicit recheck',()=>{
    const k=fixture(),peer=k.make();peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff])});
    k.nnk.modules.manifest.recheck();peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff])});assert.equal(k.resumed.length,2);assert.equal(k.timers.size,0);
});
await test('current timeout resumes once and late reply stays silent; recheck gets a fresh timeout',()=>{
    const k=fixture(),peer=k.make();k.tick(15000);assert.equal(k.resumed.length,1);assert.equal(k.events.length,1);
    peer.channel.onmessage({data:JSON.stringify(['nnk_manifest_diff',k.diff,peer.request()])});assert.equal(k.events.length,1);
    k.nnk.modules.manifest.recheck();assert.equal(k.timers.size,1);k.tick(15000);assert.equal(k.resumed.length,2);assert.equal(k.events.length,2);
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
await test('native client dispatch obeys live request ownership and accepts legacy metadata',()=>{
    const k=fixture(),peer=k.make(),client=k.nnk.env.lib.message.client;
    client.nnk_manifest_diff(k.diff,peer.request()+1);assert.equal(k.resumed.length,0);
    client.nnk_manifest_diff(k.diff);assert.equal(k.resumed.length,1);assert.equal(k.timers.size,0);
    peer.socket.dispose();const count=k.events.length;client.nnk_manifest_diff(k.diff);assert.equal(k.events.length,count);
    k.nnk.env.game.ws=null;client.nnk_manifest_diff(k.diff);assert.equal(k.events.length,count);
});
await test('unrelated game messages remain available to native dispatch',()=>{
    const k=fixture(),peer=k.make();let received=0;peer.socket.onmessage=()=>received++;
    peer.channel.onmessage({data:JSON.stringify(['game_message',{}])});assert.equal(received,1);
});
await test('actual Guest cancellation disposes the check and cannot resume from a late result',()=>{
    const k=guestFixture();runInNewContext(source('manifest'),k.context);k.nnk.modules.manifest.install();
    k.nnk.modules.guest.joinByRoomCode('ABC234');const channel=k.pcs[0].channels[0],sent=[];
    channel.send=raw=>sent.push(JSON.parse(raw));channel.readyState='open';channel.onopen();
    const staleMessage=channel.onmessage,checkTimer=[...k.timers.values()].find(t=>t.ms===15000).fn;
    assert.ok(sent.some(m=>m[0]==='nnk_manifest'));k.nnk.modules.guest.cancelJoin();const count=k.events.length;
    assert.equal(k.timers.size,0);staleMessage({data:JSON.stringify(['nnk_manifest_diff',{exts:{missing:[]}},sent.find(m=>m[0]==='nnk_manifest')[2]])});checkTimer();
    assert.equal(k.events.length,count);assert.equal(k.nnk.state.guest.session,null);assert.equal(k.stats().reloads,0);
});

console.log(`\n全部通过: ${passed} 项（内存模拟；不替代官方原生集成或真人双机验收）`);
