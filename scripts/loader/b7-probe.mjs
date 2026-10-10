import testPaths from '../fixtures/test-paths.cjs';
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile,writeFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {createRequire} from 'node:module'
export const name='b7-loader-probe'
export const inject=['timer']
export function apply(ctx) {
  let handler
  ctx.provide('webServer',{register:route=>{handler=route.handler;return()=>{handler=null}}})
  ctx.setTimeout(async()=>{
    let server,checks=0
    const pass=(label,fn)=>{fn();checks++;console.log('B7-LOADER PASS '+label)}
    try {
      assert.equal(typeof handler,'function');server=createServer((req,res)=>Promise.resolve(handler(req,res)).catch(error=>{console.error(error);res.writeHead(500);res.end()}))
      await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port+'/noname-kit-api'
      const post=(url,body={})=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
      const status=await(await fetch(base+'/online/status')).json(),root=testPaths.requiredTestPath('NNK_B7_LOADER_ROOT')
      pass('real Loader recognizes withdrawn game directory with pending recovery',()=>{assert.equal(status.active,true);assert.equal(status.batchRecovery.phase,'committed');assert.equal(existsSync(root+'/extension'),false)})
      pass('offline kernel and no bridge are allowed for recovery',()=>assert.equal(status.runtimeStatus,'offline'))
      const denied=await post('/online/kernel/install');pass('installer cannot recreate a missing formal directory',()=>{assert.equal(denied.status,400);assert.equal(existsSync(root+'/extension'),false)})
      const result=await(await post('/online/batch/recover')).json();pass('actual HTTP finishes complete new batch offline',()=>assert.equal(result.status,'committed'))
      for(const name of ['甲包','乙包'])pass('new bytes restored '+name,()=>assert.equal(createRequire(import.meta.url)('node:fs').readFileSync(root+'/extension/'+name+'/extension.js','utf8'),'new-'+name))
      pass('unrelated folder and empty directory remain',()=>{assert.equal(existsSync(root+'/extension/untouched/empty'),true);assert.equal(createRequire(import.meta.url)('node:fs').readFileSync(root+'/extension/untouched/user.dat','utf8'),'untouched')})
      pass('idempotent offline recovery',()=>{});assert.equal((await(await post('/online/batch/recover')).json()).status,'none')
      const install=await(await post('/online/kernel/install')).json();pass('install available after recovery',()=>assert.equal(install.ok,true))
      const source=process.env.NNK_SOURCE_ROOT
      for(const file of ['extension.js','lib/batch-files.cjs','lib/batch-acl.ps1','lib/batch-lock.ps1','src/isolation.js']) {
        const actual=await readFile(install.target+'/'+file),expected=await readFile(source+'/online-kernel/'+file);pass('packaged installed bytes '+file,()=>assert.ok(actual.equals(expected)))
      }
      const installed=new URL('../../',import.meta.url)
      for(const file of ['index.js','client.js','src/batch.js','src/kernel-install.js']) {const actual=await readFile(new URL(file,installed)),expected=await readFile(source+'/'+file);pass('packaged source bytes '+file,()=>assert.ok(actual.equals(expected)))}
      pass('legacy content still rejected',()=>{});assert.equal((await post('/online/command',{action:'transfer_pack',args:{name:'甲包'}})).status,409)
      const done=await(await fetch(base+'/online/status')).json();pass('recovery status cleared; installed hash exact; runtime remains offline',()=>{assert.equal(done.batchRecovery.status,'none');assert.equal(done.kernel.state,'ok');assert.equal(done.runtimeStatus,'offline')})
      await writeFile(testPaths.outputPath("b7-loader-result.json"),JSON.stringify({ok:true,checks,packagedLoader:true,surface:'real packaged DSH Loader + test webServer + actual HTTP/offline recovery/install; no GUI/engine'},null,2))
      console.log('B7-LOADER DONE checks='+checks);await new Promise(r=>server.close(r));process.exit(0)
    }catch(error){console.error('B7-LOADER FAILED',error);if(server)server.close();process.exit(1)}
  },1500)
}
