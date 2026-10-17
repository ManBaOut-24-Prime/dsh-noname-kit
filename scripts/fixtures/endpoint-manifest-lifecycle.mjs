// Current endpoint + unchanged manifest/RTC modules with a synthetic document.
// No official app, native factory or live TransportOwner is created here.
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createEngineEndpoint} from '../../online-kernel/keepalive/engine-endpoint.js';
import {drain} from './guest-lifecycle.mjs';
export function endpointManifestFixture({fileCanEnter=true,scanWait}={}){
  const events=[],timers=new Map(),scans=[];let id=0,clock=0,current=true,reloads=0,nativeOpens=0,nativeMessages=0;
  const scope={sessionId:'fixture-party',roundId:'fixture-round',documentGeneration:1,bindingId:'fixture-binding',bindingNonce:'fixture-nonce',expectedOrigin:'http://fixture.invalid'};
  const lib={version:'fixture',config:{extensions:['A'],extension_A_enable:true,all:{stockextension:[]},connect_avatar:'caocao'},
    characterPack:{},cardPack:{},message:{client:{},server:{}},node:{clients:[]},element:{ws:{
      onopen(){nativeOpens++;},onmessage(event){nativeMessages++;const value=JSON.parse(event.data);
        if(value[0]==='init'){nnk.env.game.onlineID=value[1];nnk.env.game.connectPlayers=[{playerid:'host'},{playerid:value[1]}];this.send(JSON.stringify(['inited']));}},
      onerror(){},onclose(){reloads++;}}}};
  const nnk={version:'fixture',state:{},env:{lib,get:{connectNickname:()=> 'fixture'},game:{online:false,connectPlayers:[],reload(){reloads++;}},_status:{}},modules:{
    config:{get:()=>[]},compat:{gameRoot:()=>'/fixture'},bridge:{emit:(type,data)=>events.push({type,data})},
    batch:{paused:true,capability:2,handle:()=>false,canEnter:()=>fileCanEnter},transfer:{paused:true},
    guest:{resumeEntry(){/* Original metadata callback is informational here. */}},
    consent:{attach(){},detach(){},handle:()=>false,propose:()=>Promise.resolve(false)}
  }};
  const fakeRequire=name=>name==='node:path'?{join:(...parts)=>parts.join('/')}:
    name==='node:fs'?{readdirSync:()=>['A'],existsSync:()=>true,promises:{readdir:async()=>['A'],access:async()=>{}}}:
    {scan(root,names,options){scans.push(options);return {A:{digest:'a'.repeat(64)}}},async scanAsync(root,names,options){scans.push(options);if(scanWait)await scanWait.promise;if(options.signal?.aborted)throw Error('scan retired');return {A:{digest:'a'.repeat(64)}}}};
  const context={window:{__nnk__:nnk,require:fakeRequire},Date,console,btoa,atob,AbortController,
    setTimeout(fn,ms){timers.set(++id,{fn,ms,at:clock+ms});return id;},clearTimeout:key=>timers.delete(key),
    setInterval(){throw Error('Unexpected module interval');},clearInterval(){}};
  for(const name of ['manifest','rtc'])runInNewContext(readFileSync(new URL('../../online-kernel/src/'+name+'.js',import.meta.url),'utf8'),context);
  nnk.modules.manifest.install();
  const port={onmessage:null,closed:0,messages:[],start(){},close(){this.closed++;},postMessage(value){this.messages.push(structuredClone(value));}};
  const core=createEngineEndpoint(nnk,{info:{role:'guest',scope},port,isCurrent:()=>current,documentToken:'fixture-only'});
  async function command(action,args={},type='command'){
    const requestId='fixture-request-'+(++id);await core.handleMessage({type,scope,requestId,command:action,args});
    return port.messages.findLast(value=>value.type==='result'&&value.requestId===requestId);
  }
  async function prepare(){
    const approved=await command('approve-peer',{peerId:'actual-host-fixture'});if(!approved.ok)throw Error(approved.error.message);
    const result=await command('prepare-guest',{peerId:'actual-host-fixture'});if(!result.ok)throw Error(result.error.message);await drain();return nnk.env.game.ws;
  }
  async function game(raw,seq=1,overrideScope=scope){await core.handleMessage({type:'game',scope:overrideScope,peerId:'actual-host-fixture',seq,raw});}
  function tick(ms){clock+=ms;for(const [key,timer]of [...timers])if(timer.at<=clock){timers.delete(key);timer.fn();}}
  const sent=()=>port.messages.filter(value=>value.type==='send').map(value=>({peerId:value.peerId,scope:value.scope,payload:JSON.parse(value.raw)}));
  async function cancel(){return core.detach('Guest current enrollment cancelled');}
  return {nnk,events,timers,scans,context,scope,port,core,command,prepare,game,tick,sent,cancel,
    invalidate(){current=false;},stats:()=>({reloads,nativeOpens,nativeMessages})};
}
