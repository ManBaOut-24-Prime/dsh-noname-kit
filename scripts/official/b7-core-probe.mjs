import testPaths from '../fixtures/test-paths.cjs';
// Uses the production transaction core and the actual official import/config/HTTP
// paths. All process kills target children created by this probe, never user apps.
import {spawn,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),core=require('../../online-kernel/lib/batch-files.cjs');
const names=['B7-durable-A','B7-durable-B'];
const payload=(name,generation)=>Buffer.from(`export const type='extension';\nwindow.__b7Counts[${JSON.stringify(name)}]={generation:${JSON.stringify(generation)},top:1,factory:0,precontent:0};\nexport default function(){window.__b7Counts[${JSON.stringify(name)}].factory++;return {name:${JSON.stringify(name)},config:{},package:{},precontent:function(){window.__b7Counts[${JSON.stringify(name)}].precontent++}}}\n`);
const digest=b=>createHash('sha256').update(b).digest('hex');
function transaction(root,event){
  const batch=core.normalize({extensions:names.map(name=>({name,files:[{path:'extension.js',size:payload(name,'new').length,sha256:digest(payload(name,'new'))}]}))});
  const tx=new core.Transaction(root,batch,{session:'a'.repeat(32),peerSession:'b'.repeat(32),proposal:'c'.repeat(32),digest:core.manifestDigest(batch)},{hook:e=>{if(e===event)process.exit(86)}});
  tx.files.forEach((f,i)=>tx.putFile(i,payload(f.name,'new')));tx.prepare();tx.commit(()=>true);throw Error('Crash point was not reached');
}
if(process.argv[2]==='--crash')transaction(process.argv[3],process.argv[4]);
const testRoot=testPaths.tempPrefix("b7-core-")+randomUUID();mkdirSync(testRoot,{recursive:true});
const sourceRoot=fileURLToPath(new URL('../../',import.meta.url)),bootstrap=testPaths.testPath("temp/programmatic-electron/resources/app/probe.cjs"),before=readFileSync(bootstrap),results=[];
const exe=testPaths.testPath("temp/programmatic-electron/programmatic.exe");
async function run(options){
  const result=testRoot+'/'+options.label+'-'+options.phase+'-'+randomUUID()+'.json';
  const child=spawn(exe,[],{env:{...process.env,NNK_GATE_OPTIONS:JSON.stringify({...options,result,sourceRoot,nativeHttp:true}),TEMP:testPaths.tempDir(),TMP:testPaths.tempDir()},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const ended=new Promise(r=>child.once('exit',r));
  try{
    const deadline=Date.now()+45000;while(!existsSync(result)){if(child.exitCode!==null||Date.now()>deadline)throw Error('Official core probe failed: '+output);await new Promise(r=>setTimeout(r,100))}
    const value=JSON.parse(readFileSync(result));assert.equal(value.ok,true,JSON.stringify(value));
    if(options.waitForKill){assert.equal(spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).status,0);value.wholeProcessTreeKilled=true}
    const code=await ended;if(!options.waitForKill)assert.equal(code,0,output);results.push({label:options.label,...value});return value;
  }finally{writeFileSync(result+'.console.log',output);if(child.exitCode===null){child.kill();await ended}}
}
function crash(root,event){const r=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--crash',root,event],{encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(r.status,86,r.stdout+r.stderr)}
function zero(result){assert.equal(Object.values(result.counts).every(c=>c.top===0&&c.factory===0&&c.precontent===0),true,JSON.stringify(result.counts))}
function whole(result,generation){assert.equal(Object.values(result.counts).every(c=>c.generation===generation&&c.top===1&&c.factory===1&&c.precontent===1),true,JSON.stringify(result.counts))}
writeFileSync(bootstrap,`import(${JSON.stringify(new URL('./b7-durable-main.mjs',import.meta.url).href)});\n`);
try{
  for(const label of ['Old','Latest']){
    for(const event of ['new:B7-durable-A','permissions:new:B7-durable-A']){
      const fixture=testRoot+'/'+label+'-'+event.replaceAll(':','-');mkdirSync(fixture,{recursive:true});
      for(const name of names){mkdirSync(fixture+'/extension/'+name,{recursive:true});writeFileSync(fixture+'/extension/'+name+'/extension.js',payload(name,'old'))}
      mkdirSync(fixture+'/extension/untouched/empty',{recursive:true});writeFileSync(fixture+'/extension/untouched/user.dat','retain exactly');
      const base={label,fixture,engineRoot:testPaths.officialRoot(label),userData:fixture+'-primary'};
      const seed=await run({...base,phase:'seed',createRestoreConfig:true});base.port=seed.port;
      await run({...base,phase:'seed',userData:fixture+'-secondary'});whole(await run({...base,phase:'core-old-cached'}),'old');
      crash(fixture,event);assert.equal(existsSync(fixture+'/extension'),false);
      zero(await run({...base,phase:'core-pending-cold',waitForKill:true}));
      zero(await run({...base,phase:'core-pending-crash-restart',nativeReload:true}));
      copyFileSync(fixture+'/restore-config.txt',fixture+'/noname.config.txt');zero(await run({...base,phase:'core-config-restore'}));
      zero(await run({...base,phase:'core-other-profile',userData:fixture+'-secondary'}));
      const outcome=core.recover(fixture),committed=event.startsWith('permissions:');assert.equal(outcome.status,committed?'committed':'rolled_back');
      whole(await run({...base,phase:'core-offline-recovered'}),committed?'new':'old');assert.equal(readFileSync(fixture+'/extension/untouched/user.dat','utf8'),'retain exactly');
      assert.equal(core.inspect(fixture).status,'none');
    }
  }
  const report={ok:true,gatePassed:true,scope:'production whole-namespace transaction + actual official config/import/HTTP functions; hidden programmatic Electron, no GUI/full boot',testRoot,coreHash:digest(readFileSync(sourceRoot+'/online-kernel/lib/batch-files.cjs')),aclHash:digest(readFileSync(sourceRoot+'/online-kernel/lib/batch-acl.ps1')),lockHash:digest(readFileSync(sourceRoot+'/online-kernel/lib/batch-lock.ps1')),results};
  writeFileSync(testPaths.outputPath("b7-core-gate.json"),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:true,gatePassed:true,scenarios:results.length,testRoot}));
}finally{writeFileSync(bootstrap,before)}
