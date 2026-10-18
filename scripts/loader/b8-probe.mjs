import testPaths from '../fixtures/test-paths.cjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export const name='b8-loader-probe';export const inject=['timer'];
export function apply(ctx){let handler;ctx.provide('webServer',{register:route=>{handler=route.handler;return()=>handler=null}});
  ctx.setTimeout(async()=>{let server,child,checks=0;const pass=(name,fn)=>{fn();checks++;console.log('B8-LOADER PASS '+name)};
    try{
      assert.equal(typeof handler,'function');server=createServer((req,res)=>Promise.resolve(handler(req,res)).catch(e=>{console.error(e);res.writeHead(500);res.end()}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
      const base='http://127.0.0.1:'+server.address().port+'/noname-kit-api',post=(url,body={})=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),root=testPaths.requiredTestPath('NNK_B8_LOADER_ROOT');
      const install=await(await post('/online/kernel/install')).json();pass('real packaged Loader installs B8 kernel',()=>assert.equal(install.ok,true));
      const source=testPaths.requiredSourceRoot(),installed=new URL('../../',import.meta.url);
      testPaths.assertDistinctSource(source,installed);
      for(const file of ['extension.js','src/batch.js','src/guest.js','src/consent.js','src/rtc.js','src/isolation.js','src/bridge.js','lib/batch-runtime.cjs','lib/batch-wire.cjs','lib/batch-files.cjs']){const a=await readFile(install.target+'/'+file),b=await readFile(source+'/online-kernel/'+file);pass('exact installed content '+file,()=>assert.ok(a.equals(b)))}
      for(const file of ['index.js','client.js','src/batch.js']){const a=await readFile(new URL(file,installed)),b=await readFile(source+'/'+file);pass('packaged source '+file,()=>assert.ok(a.equals(b)))}
      const shipped=await readFile(install.target+'/src/batch.js','utf8');pass('immutable production candidate pause',()=>assert.match(shipped,/var CONTENT_PAUSED=true;/));
      const out=root+'/b8-child-ready.json';child=spawn(process.execPath,[fileURLToPath(new URL('./b8-control-child.mjs',import.meta.url)),root,out],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const ended=new Promise(r=>child.once('exit',r));
      async function wait(file){for(let i=0;i<800;i++){if(existsSync(file))return;if(child.exitCode!==null)throw Error(output);await new Promise(r=>setTimeout(r,40))}throw Error('Child deadline exceeded')}
      await wait(out);const {binding,folder}=JSON.parse(await readFile(out));
      const pending=await(await fetch(base+'/online/status')).json();pass('blocked receiver inside publication exposed offline with formal namespace absent',()=>{assert.equal(pending.batchRecovery.phase,'frozen');assert.equal(existsSync(root+'/extension'),false)});
      pass('invalid cancellation rejected',()=>{});assert.equal((await post('/online/command',{action:'batch_cancel',args:{...binding,session:'bad'}})).status,400);
      assert.equal((await post('/online/command',{action:'batch_cancel',args:{...binding,proposal:'f'.repeat(32)}})).status,200);pass('stale bound cancellation cannot change current control',()=>{});assert.equal((await readFile(folder+'/cancel.bin'))[0],0);
      assert.equal((await post('/online/command',{action:'batch_cancel',args:binding})).status,200);await wait(out+'.done');assert.equal(await ended,0,output);pass('API writes revocation seen by separate live receiver process',()=>assert.equal(JSON.parse(requireText(out+'.done')).status,'rolled_back'));
      for(const name of ['B8-loader-A','B8-loader-B'])pass('cancelled batch restores original '+name,()=>assert.equal(requireText(root+'/extension/'+name+'/extension.js'),'old '+name));
      const bridge=JSON.parse(await readFile(install.target+'/nnk-bridge.json','utf8'));const delivery=await(await post('/online/bridge',{token:bridge.token,kernel:{version:'0.3.84',build:'b8-batch-1',transferPaused:true,stage:'ready',role:'guest'},state:{batchFilesPaused:true,fileBatches:[{...binding,status:'unknown',total:10,received:10}]},events:[]})).json();
      pass('actual bridge delivers cancellation binding',()=>assert.ok(delivery.commands.some(c=>c.action==='batch_cancel'&&c.args.proposal===binding.proposal)));
      const status=await(await fetch(base+'/online/status')).json();pass('file truth retained apart from metadata and offline journal',()=>{assert.equal(status.bridge.state.fileBatches[0].status,'unknown');assert.equal(status.batchRecovery.status,'none')});
      pass('legacy transfer endpoint remains blocked',()=>{});assert.equal((await post('/online/command',{action:'transfer_pack',args:{name:'B8-loader-target'}})).status,409);
      await writeFile(testPaths.outputPath("b8-loader-result.json"),JSON.stringify({ok:true,checks,packagedLoader:true,surface:'Actual DSH Loader + test webServer + HTTP/install/cancellation across live receiver process/bridge state. Simulated heartbeat; no GUI or engine.'},null,2));console.log('B8-LOADER DONE checks='+checks);await new Promise(r=>server.close(r));process.exit(0);
    }catch(error){console.error('B8-LOADER FAILED',error);if(child?.exitCode===null)child.kill();server?.close();process.exit(1)}
  },1500)
}
import {readFileSync} from 'node:fs';const requireText=file=>readFileSync(file,'utf8');
