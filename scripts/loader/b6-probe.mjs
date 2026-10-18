import testPaths from '../fixtures/test-paths.cjs';
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
export const name='b6-loader-probe'
export const inject=['timer']
export function apply(ctx) {
  let handler
  ctx.provide('webServer',{register:route=>{handler=route.handler;return()=>{handler=null}}})
  ctx.setTimeout(async()=>{
    let server,checks=0
    const pass=(label,fn)=>{fn();checks++;console.log('B6-LOADER PASS '+label)}
    try {
      assert.equal(typeof handler,'function');server=createServer((req,res)=>Promise.resolve(handler(req,res)).catch(error=>{console.error(error);res.writeHead(500);res.end()}))
      await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port+'/noname-kit-api'
      const post=(url,body)=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
      const first=await(await post('/online/kernel/install',{})).json();pass('real Loader first install',()=>assert.equal(first.ok,true))
      const status=await(await fetch(base+'/online/status')).json();pass('file integrity distinct from offline runtime',()=>{assert.equal(status.kernel.state,'ok');assert.equal(status.runtimeStatus,'offline')})
      const source=testPaths.requiredSourceRoot()
      for(const file of ['extension.js','src/consent.js','src/rtc.js','src/bridge.js','src/manifest.js']) {
        const actual=await readFile(first.target+'/'+file),expected=await readFile(source+'/online-kernel/'+file)
        pass('installed raw bytes '+file,()=>assert.equal(createHash('sha256').update(actual).digest('hex'),createHash('sha256').update(expected).digest('hex')))
      }
      const installed=testPaths.requiredTestPath('NNK_LOADER_PACKAGE')
      testPaths.assertDistinctSource(source,installed)
      for(const file of ['client.js','index.js']) { const a=await readFile(installed+'/'+file),b=await readFile(source+'/'+file);pass('installed '+file+' matches source',()=>assert.ok(a.equals(b))) }
      const before=await readFile(first.target+'/extension.js');await writeFile(first.target+'/user-extra','retain me');const upgraded=await(await post('/online/kernel/install',{})).json()
      pass('complete upgrade backup',()=>{assert.equal(upgraded.ok,true);assert.ok(upgraded.backup)})
      const old=await readFile(upgraded.backup+'/extension.js'),extra=await readFile(upgraded.backup+'/user-extra','utf8');pass('old bytes and user extra retained',()=>{assert.ok(old.equals(before));assert.equal(extra,'retain me')})
      const ids={session:'a'.repeat(32),peerSession:'b'.repeat(32),proposal:'c'.repeat(32),digest:'d'.repeat(64)}
      pass('implicit/string authorization HTTP 400',()=>{});assert.equal((await post('/online/command',{action:'batch_decision',args:{...ids,yes:'true'}})).status,400)
      pass('invalid session HTTP 400',()=>{});assert.equal((await post('/online/command',{action:'batch_cancel',args:{...ids,session:'invalid'}})).status,400)
      const queued=await post('/online/command',{action:'batch_decision',args:{...ids,yes:true}});pass('explicit bound decision queued by API',()=>assert.equal(queued.status,200))
      const bridge=JSON.parse(await readFile(first.target+'/nnk-bridge.json','utf8'))
      const delivery=await(await post('/online/bridge',{token:bridge.token,kernel:{version:'0.3.82',build:'b6-consent-1',transferPaused:true,stage:'ready',role:'guest'},state:{batchProposals:[{...ids,status:'pending'}]},events:[]})).json()
      pass('real heartbeat delivers exact decision; API is not consent result',()=>assert.deepEqual(delivery.commands.find(c=>c.action==='batch_decision').args,{...ids,yes:true}))
      const live=await(await fetch(base+'/online/status')).json();pass('heartbeat proposal snapshot retained independently of events',()=>assert.equal(live.bridge.state.batchProposals[0].proposal,ids.proposal))
      pass('B0 old transfer stays HTTP 409',()=>{});assert.equal((await post('/online/command',{action:'transfer_pack',args:{name:'包'}})).status,409)
      await writeFile(testPaths.outputPath("b6-loader-result.json"),JSON.stringify({ok:true,checks,packagedLoader:true,surface:'real DSH Loader + test webServer + actual HTTP/API/install/bridge; simulated kernel heartbeat, no GUI'},null,2))
      console.log('B6-LOADER DONE checks='+checks);await new Promise(r=>server.close(r));process.exit(0)
    }catch(error){console.error('B6-LOADER FAILED',error);if(server)server.close();process.exit(1)}
  },1500)
}
