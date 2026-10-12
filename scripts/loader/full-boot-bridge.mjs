/** Real packaged Loader HTTP bridge for a marked official boot fixture. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {networkInterfaces} from 'node:os';
export const name='full-boot-loader-bridge';export const inject=['timer'];
export function apply(ctx){let handler;ctx.provide('webServer',{register(route){handler=route.handler;return()=>{handler=null}}});ctx.setTimeout(async()=>{
  let server;try{
    const root=process.env.NNK_FULL_ROOT,out=process.env.NNK_FULL_BRIDGE_OUTPUT,stop=process.env.NNK_FULL_BRIDGE_STOP;
    assert.ok(root&&out&&stop);const marker=JSON.parse(readFileSync(root+'/../../.nnk-full-fixture.json','utf8'));assert.equal(marker.kind,'noname-kit-full-engine-fixture');assert.equal(typeof handler,'function');
    server=createServer((req,res)=>Promise.resolve(handler(req,res)).catch(e=>{console.error(e);res.writeHead(500);res.end()}));await new Promise(r=>server.listen(0,process.env.NNK_FULL_PEER_MATRIX==='1'?'0.0.0.0':'127.0.0.1',r));
    const base='http://127.0.0.1:'+server.address().port+'/noname-kit-api';
    const response=await fetch(base+'/online/kernel/install',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),install=await response.json();assert.equal(install.ok,true,JSON.stringify(install));
    const peers=[];
    if(process.env.NNK_FULL_PEER_MATRIX==='1'){
      const address=Object.values(networkInterfaces()).flat().find(a=>a.family==='IPv4'&&!a.internal)?.address;if(!address)throw Error('No local nonloopback interface for actual TCP peer matrix');
      const bridge=JSON.parse(readFileSync(install.target+'/nnk-bridge.json','utf8')),remote='http://'+address+':'+server.address().port+'/noname-kit-api';
      const binding={session:'a'.repeat(32),peerSession:'b'.repeat(32),proposal:'c'.repeat(32),digest:'d'.repeat(64)};
      for(const origin of [null,'https://outside.invalid',base]){
        const headers={host:'127.0.0.1:'+server.address().port,...(origin?{origin}:{})};
        const read=await fetch(remote+'/online/status',{headers}),command=await fetch(remote+'/online/command',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({action:'batch_decision',args:{...binding,yes:true}})});
        assert.equal(read.status,403);assert.equal(command.status,403);peers.push({origin,read:read.status,command:command.status});
      }
      const forged=await fetch(remote+'/online/bridge',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({token:bridge.token,state:{},events:[]})});assert.equal(forged.status,403);peers.push({knownBridgeToken:forged.status});
    }
    writeFileSync(out,JSON.stringify({base,pid:process.pid,target:install.target,actualTcpPeers:peers}));console.log('FULL-BOOT-LOADER READY');
    const timer=setInterval(()=>{if(existsSync(stop)){clearInterval(timer);server.close(()=>process.exit(0))}},250);timer.unref();
  }catch(error){console.error(error);server?.close();process.exit(1)}
},1000)}
