import testPaths from './fixtures/test-paths.cjs';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,openSync,closeSync,linkSync,copyFileSync} from 'node:fs';
import {spawnSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),core=require('../online-kernel/lib/batch-files.cjs');
const base=testPaths.tempPrefix("b7-files-")+randomUUID();mkdirSync(base,{recursive:true});
const hash=x=>createHash('sha256').update(x).digest('hex');
function fixture(){const root=base+'/'+randomUUID();mkdirSync(root+'/extension/甲包/empty',{recursive:true});
  writeFileSync(root+'/extension/甲包/extension.js','old entry');writeFileSync(root+'/extension/甲包/user.dat','用户额外内容');
  const bytes=[Buffer.from('new entry甲'),Buffer.from('new entry乙'),Buffer.from('{"v":2}')];
  const batch=core.normalize({extensions:[{name:'甲包',files:[{path:'extension.js',size:bytes[0].length,sha256:hash(bytes[0])}]},{name:'乙包',files:[{path:'extension.js',size:bytes[1].length,sha256:hash(bytes[1])},{path:'data/config.json',size:bytes[2].length,sha256:hash(bytes[2])}]}]});
  const content=new Map([['甲包/extension.js',bytes[0]],['乙包/extension.js',bytes[1]],['乙包/data/config.json',bytes[2]]]);
  const binding={session:'a'.repeat(32),peerSession:'b'.repeat(32),proposal:'c'.repeat(32),digest:core.manifestDigest(batch)};
  return {root,batch,binding,content};
}
let passed=0;
async function test(name,fn){if(process.env.NNK_B7_TEST_FILTER&&!name.includes(process.env.NNK_B7_TEST_FILTER))return;await fn();passed++;process.stdout.write('  ✓ '+name+'\n')}
function fill(f,tx){tx.files.forEach((v,i)=>tx.putFile(i,f.content.get(v.name+'/'+v.path)))}
function old(f){assert.equal(readFileSync(f.root+'/extension/甲包/extension.js','utf8'),'old entry');assert.equal(existsSync(f.root+'/extension/乙包'),false);assert.equal(readFileSync(f.root+'/extension/甲包/user.dat','utf8'),'用户额外内容');assert.deepEqual(readdirSync(f.root+'/extension/甲包/empty'),[])}
function fresh(f){assert.equal(readFileSync(f.root+'/extension/甲包/extension.js','utf8'),'new entry甲');assert.equal(readFileSync(f.root+'/extension/乙包/extension.js','utf8'),'new entry乙');assert.equal(readFileSync(f.root+'/extension/乙包/data/config.json','utf8'),'{"v":2}');assert.equal(readFileSync(f.root+'/extension/甲包/user.dat','utf8'),'用户额外内容')}
if(process.argv[2]==='--crash'){
  const request=JSON.parse(readFileSync(process.argv[3])),f={...request,content:new Map(request.content.map(([k,v])=>[k,Buffer.from(v,'base64')]))};
  const tx=new core.Transaction(f.root,f.batch,f.binding,{hook:event=>{
    if(request.rollbackCrash&&event==='new:乙包')core.recover(f.root,{owned:true,expectedId:tx.id,lock:tx.lock,hook:point=>{if(point===request.event)process.exit(77)}});
    if(event===request.event)process.exit(77);
  }});fill(f,tx);
  if(request.abort){core.recover(f.root,{owned:true,expectedId:tx.id,lock:tx.lock,hook:event=>{if(event===request.event)process.exit(77)}});process.exit(78)}
  tx.prepare();tx.commit(()=>true);process.exit(78);
}
function crash(f,event,abort=false,rollbackCrash=false){
  const request=f.root+'/crash.json';writeFileSync(request,JSON.stringify({...f,content:[...f.content].map(([k,v])=>[k,v.toString('base64')]),event,abort,rollbackCrash}));
  const r=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--crash',request],{encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(r.status,77,r.stdout+r.stderr);
}
await test('whole Chinese multi-extension batch, real ACL freeze, extras and empty directories',()=>{
  const f=fixture(),tx=new core.Transaction(f.root,f.batch,f.binding);tx.files.forEach((v,i)=>tx.putFile(i,f.content.get(v.name+'/'+v.path)));tx.prepare();
  assert.equal(readFileSync(f.root+'/extension/甲包/extension.js','utf8'),'old entry');
  assert.equal(tx.commit(()=>true).status,'committed');assert.equal(readFileSync(f.root+'/extension/甲包/extension.js','utf8'),'new entry甲');
  assert.equal(readFileSync(f.root+'/extension/乙包/extension.js','utf8'),'new entry乙');assert.equal(readFileSync(f.root+'/extension/甲包/user.dat','utf8'),'用户额外内容');
  assert.deepEqual(readdirSync(f.root+'/extension/甲包/empty'),[]);assert.equal(core.inspect(f.root).status,'none');
});
for(const name of ['../bad','联机助手','boss','coin','cardpile','CON','a.','a:b'])await test('reject unsafe or official stock extension '+name,()=>{
  assert.throws(()=>core.normalize({extensions:[{name,files:[{path:'extension.js',size:0,sha256:hash('')}]}]}));
});
await test('manifest rejects case aliases, path traversal, file/directory collision and wrong binding before any transaction',()=>{
  const f=fixture(),file={path:'extension.js',size:0,sha256:hash('')};
  for(const files of [[file,{...file,path:'EXTENSION.js'}],[file,{...file,path:'../data'}],[file,{...file,path:'folder'},{...file,path:'folder/a'}]])assert.throws(()=>core.normalize({extensions:[{name:'包',files}]}));
  assert.throws(()=>new core.Transaction(f.root,f.batch,{...f.binding,digest:'d'.repeat(64)}));old(f);assert.equal(existsSync(f.root+'/nnk-batches'),false);
});
await test('incomplete, altered content and conflicting duplicate never change formal files',()=>{
  const f=fixture(),tx=new core.Transaction(f.root,f.batch,f.binding);try{
    assert.throws(()=>tx.putFile(0,Buffer.from('bad')));assert.throws(()=>tx.prepare());fill(f,tx);fill(f,tx);
    writeFileSync(tx.folder+'/received/甲包/extension.js','altered');assert.throws(()=>tx.putFile(0,f.content.get('甲包/extension.js')));
  }finally{tx.abort()}old(f);
});
await test('overlapping transactions cannot acquire the native filesystem lease',()=>{
  const f=fixture(),tx=new core.Transaction(f.root,f.batch,f.binding);try{assert.throws(()=>new core.Transaction(f.root,f.batch,f.binding),/busy/);assert.equal(core.inspect(f.root).id,tx.id)}finally{tx.abort()}old(f);
});
await test('hardlinked local content is rejected without changing unrelated data',()=>{
  const f=fixture();linkSync(f.root+'/extension/甲包/user.dat',f.root+'/outside.dat');const tx=new core.Transaction(f.root,f.batch,f.binding);fill(f,tx);
  try{assert.throws(()=>tx.prepare(),/hardlinks/)}finally{tx.abort()}old(f);assert.equal(readFileSync(f.root+'/outside.dat','utf8'),'用户额外内容');
});
await test('a writer opened before freeze prevents publication; full old batch remains readable',()=>{
  const f=fixture(),tx=new core.Transaction(f.root,f.batch,f.binding);fill(f,tx);tx.prepare();const fd=openSync(f.root+'/extension/甲包/user.dat','r+');
  try{assert.throws(()=>tx.commit(()=>true),e=>e.outcome.status==='rolled_back')}finally{closeSync(fd);tx.abort()}old(f);assert.equal(core.inspect(f.root).status,'none');
});
await test('a reader excluding Delete prevents namespace withdrawal without changing old files',async()=>{
  const f=fixture(),tx=new core.Transaction(f.root,f.batch,f.binding);fill(f,tx);tx.prepare();const request=f.root+'/reader.json',ready=f.root+'/reader.ready';
  writeFileSync(request,JSON.stringify({root:f.root,lock:f.root+'/extension/甲包/user.dat',active:f.root+'/none',ready,pid:process.pid}));
  const script=readFileSync(new URL('../online-kernel/lib/batch-lock.ps1',import.meta.url),'utf8').replace('[IO.FileAccess]::ReadWrite','[IO.FileAccess]::Read').replace('[IO.FileShare]::None','[IO.FileShare]::Read').replace('[IO.FileMode]::OpenOrCreate','[IO.FileMode]::Open');
  const child=spawn(process.env.SystemRoot+'/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-Command','& { '+script+' } $env:NNK_BATCH_READER'],{env:{SystemRoot:process.env.SystemRoot,NNK_BATCH_READER:request},stdio:'ignore',windowsHide:true});
  const ended=new Promise(r=>child.once('exit',r));
  try{const deadline=Date.now()+6000;while(!existsSync(ready)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,25));assert.equal(JSON.parse(readFileSync(ready)).ok,true);assert.throws(()=>tx.commit(()=>true),e=>e.outcome.status==='rolled_back'&&e.syscall==='rename')}finally{child.kill();await ended;tx.abort()}old(f);
});
await test('partial ACL failure restores the entire old batch and permits retry',()=>{
  const f=fixture(),tx=new core.Transaction(f.root,f.batch,f.binding,{aclFailAfter:2});fill(f,tx);tx.prepare();assert.throws(()=>tx.commit(()=>true),e=>e.outcome.status==='rolled_back');old(f);
  const retry=new core.Transaction(f.root,f.batch,f.binding);fill(f,retry);retry.prepare();assert.equal(retry.commit(()=>true).status,'committed');fresh(f);
});
await test('cancellation after one new directory is published rolls back all extensions',()=>{
  const f=fixture();let authorized=true;const tx=new core.Transaction(f.root,f.batch,f.binding,{hook:event=>{if(event==='new:乙包')authorized=false}});fill(f,tx);tx.prepare();
  assert.throws(()=>tx.commit(()=>authorized),e=>e.outcome.status==='rolled_back');old(f);
});
await test('tampered staged bytes reject freeze; no changed version becomes readable',()=>{
  const f=fixture(),tx=new core.Transaction(f.root,f.batch,f.binding);fill(f,tx);tx.prepare();writeFileSync(tx.folder+'/next/甲包/extension.js','changed after validation');
  assert.throws(()=>tx.commit(()=>true),e=>e.outcome.status==='rolled_back');old(f);
});
for(const event of ['received:0','state:prepared','state:armed','freeze','state:frozen','withdraw','state:withdrawn','old:甲包','new:乙包','new:甲包','state:committed','permissions:new:乙包','permissions:new:甲包','publish:new','state:complete'])await test('process crash at '+event+' has whole-batch offline recovery',()=>{
  const f=fixture();crash(f,event);const before=core.inspect(f.root);assert.equal(before.ownerAlive,false);
  if(['freeze','state:frozen','old:甲包','new:乙包','new:甲包'].includes(event)){
    if(existsSync(f.root+'/extension'))for(const name of readdirSync(f.root+'/extension'))assert.throws(()=>readFileSync(f.root+'/extension/'+name+'/extension.js'),e=>['EACCES','EPERM'].includes(e.code));
  }
  const result=core.recover(f.root),committed=['state:committed','permissions:new:乙包','permissions:new:甲包','publish:new','state:complete'].includes(event);
  assert.equal(result.status,committed?'committed':'rolled_back');if(committed)fresh(f);else old(f);assert.equal(core.inspect(f.root).status,'none');assert.equal(core.recover(f.root).status,'none');
});
await test('receiving abort interrupted after durable rolled_back can finish without a descriptor',()=>{
  const f=fixture();crash(f,'state:rolled_back',true);assert.equal(core.recover(f.root).status,'rolled_back');old(f);assert.equal(core.inspect(f.root).status,'none');
});
await test('a torn newest journal slot falls back to the previous state and restores whole old batch',()=>{
  const f=fixture();crash(f,'state:frozen');const a=core.inspect(f.root),folder=f.root+'/nnk-batches/'+a.id,fd=openSync(folder+'/state.bin','r+');
  try{const state=core._test.stateRead(folder);require('node:fs').writeSync(fd,Buffer.from('torn'),0,4,(state.seq%2)*8192)}finally{closeSync(fd)}
  assert.equal(core.recover(f.root).status,'rolled_back');old(f);
});
await test('invalid descriptor fails closed; intact retained descriptor permits offline retry',()=>{
  const f=fixture();crash(f,'new:乙包');const a=core.inspect(f.root),file=f.root+'/nnk-batches/'+a.id+'/descriptor.json',bytes=readFileSync(file);copyFileSync(file,file+'.backup');writeFileSync(file,'{}');
  assert.throws(()=>core.recover(f.root),/integrity/);assert.equal(existsSync(f.root+'/extension'),false);
  writeFileSync(file,bytes);
  assert.equal(core.recover(f.root).status,'rolled_back');old(f);
});
await test('publication waits until all new permissions are ready',()=>{
  const f=fixture();crash(f,'permissions:new:乙包');
  try{assert.equal(existsSync(f.root+'/extension'),false,'No extension may become readable before the whole permission batch finishes')}
  finally{core.recover(f.root)}fresh(f);
});
await test('an asynchronous ordinary writer holds the lease across awaits and nested operations',async()=>{
  const f=fixture(),{withBatchWrite}=await import('../src/batch.js');let release;
  const work=withBatchWrite(f.root,()=>new Promise(r=>{release=r}));
  assert.throws(()=>new core.Transaction(f.root,f.batch,f.binding),/busy/);release();await work;
  await withBatchWrite(f.root,()=>withBatchWrite(f.root,async()=>{writeFileSync(f.root+'/extension/甲包/extra.txt','retain')}));
  const tx=new core.Transaction(f.root,f.batch,f.binding);tx.abort();old(f);assert.equal(readFileSync(f.root+'/extension/甲包/extra.txt','utf8'),'retain');
});
await test('ordinary write and kernel install refuse pending recovery before recreating extension/',async()=>{
  const f=fixture();writeFileSync(f.root+'/noname.js','');crash(f,'new:乙包');assert.equal(existsSync(f.root+'/extension'),false);
  try{
    const {writeExtension}=await import('../src/write.js'),{copyImages}=await import('../src/images.js'),{copyAudios}=await import('../src/audio.js'),{installKernelFiles}=await import('../src/kernel-install.js');
    await assert.rejects(writeExtension(f.root,{folder:'新包',code:'bad'}),/离线恢复/);await assert.rejects(copyImages(f.root,{folder:'新包',images:[]}),/离线恢复/);await assert.rejects(copyAudios(f.root,{folder:'新包',audios:[]}),/离线恢复/);
    assert.equal(installKernelFiles({root:f.root}).ok,false);assert.equal(existsSync(f.root+'/extension'),false);
  }finally{core.recover(f.root)}old(f);
});
for(const point of ['state:rolled_back','permissions:old:甲包','publish:old'])await test('rollback process crash at '+point+' remains recoverable as the whole old batch',()=>{
  const f=fixture();crash(f,point,false,true);assert.equal(core.recover(f.root).status,'rolled_back');old(f);
});
await test('ENOSPC while staging leaves formal old files untouched and can abort',()=>{
  const f=fixture(),tx=new core.Transaction(f.root,f.batch,f.binding);fill(f,tx);const io=require('node:fs'),before=io.copyFileSync;
  io.copyFileSync=(source,dest)=>{if(dest.includes('next'))throw Object.assign(Error('injected disk full'),{code:'ENOSPC'});return before(source,dest)};
  try{assert.throws(()=>tx.prepare(),e=>e.code==='ENOSPC')}finally{io.copyFileSync=before;tx.abort()}old(f);
});
await test('persistent disk fault after commit remains isolated and retry finishes the whole new batch',()=>{
  const f=fixture(),io=require('node:fs'),before=io.openSync;const tx=new core.Transaction(f.root,f.batch,f.binding,{hook:event=>{
    if(event==='state:committed')io.openSync=(file,...args)=>{if(String(file).includes('restore-new-'))throw Object.assign(Error('injected disk full'),{code:'ENOSPC'});return before(file,...args)};
  }});fill(f,tx);tx.prepare();
  try{assert.throws(()=>tx.commit(()=>true),e=>e.outcome.status==='recovery_required');assert.equal(existsSync(f.root+'/extension'),false)}finally{io.openSync=before}
  assert.equal(tx.abort().status,'committed');fresh(f);
});
await test('rollback rename fault leaves no formal partial new generation and retry restores all old files',()=>{
  const f=fixture(),io=require('node:fs'),before=io.renameSync;let authorized=true;const tx=new core.Transaction(f.root,f.batch,f.binding,{hook:event=>{
    if(event==='new:甲包'){authorized=false;io.renameSync=(from,to)=>{if(String(from).includes('old'))throw Object.assign(Error('injected rename lock'),{code:'EPERM'});return before(from,to)}}
  }});fill(f,tx);tx.prepare();
  try{assert.throws(()=>tx.commit(()=>authorized),e=>e.outcome.status==='recovery_required');assert.equal(existsSync(f.root+'/extension'),false)}finally{io.renameSync=before}
  assert.equal(tx.abort().status,'rolled_back');old(f);
});
await test('failure after whole namespace exposure reports durable committed new files, never rolls back exposed code',()=>{
  const f=fixture(),tx=new core.Transaction(f.root,f.batch,f.binding,{hook:event=>{if(event==='publish:new')throw Error('injected after exposure')}});fill(f,tx);tx.prepare();
  assert.equal(tx.commit(()=>true).status,'committed');fresh(f);assert.equal(core.inspect(f.root).status,'none');
});
await test('a closed old attempt cannot abort or write a replacement attempt',()=>{
  const f=fixture(),oldTx=new core.Transaction(f.root,f.batch,f.binding);oldTx.abort();const next=new core.Transaction(f.root,f.batch,f.binding);
  try{assert.equal(oldTx.abort().status,'closed');assert.throws(()=>oldTx.putFile(0,Buffer.alloc(0)));assert.equal(core.inspect(f.root).id,next.id)}finally{next.abort()}old(f);
});
await test('protected child permissions, unrelated directory identities and extra timestamps survive whole-root publication',()=>{
  const f=fixture(),request=f.root+'/acl-test.json',dir=f.root+'/extension/甲包';require('node:fs').utimesSync(dir+'/user.dat',1234567890,1234567890);
  const original=core._test.capture(f.root,dir,core._test.tree(dir),request),entry=original.find(r=>r.relative==='extension.js');entry.sddl=entry.sddl.replace('D:','D:P');
  core._test.acl(f.root,request,'restore',core._test.rowsAt(dir,original));
  mkdirSync(f.root+'/extension/其他包/empty',{recursive:true});writeFileSync(f.root+'/extension/其他包/untouched','keep');
  const untouched=f.root+'/extension/其他包',beforeID=String(require('node:fs').statSync(untouched,{bigint:true}).ino),permissions=core._test.capture(f.root,dir,core._test.tree(dir),request);
  const tx=new core.Transaction(f.root,f.batch,f.binding);fill(f,tx);tx.prepare();assert.equal(tx.commit(()=>true).status,'committed');fresh(f);
  const after=core._test.capture(f.root,dir,core._test.tree(dir),request),canonical=s=>s.replace(/D:([^()]*)/,(_,flags)=>'D:'+flags.replace('AI',''));
  for(const old of permissions)assert.equal(canonical(after.find(r=>r.relative===old.relative).sddl),canonical(old.sddl));
  assert.equal(String(require('node:fs').statSync(untouched,{bigint:true}).ino),beforeID);assert.equal(require('node:fs').statSync(dir+'/user.dat').mtimeMs,1234567890000);assert.equal(readFileSync(untouched+'/untouched','utf8'),'keep');assert.deepEqual(readdirSync(untouched+'/empty'),[]);
});
await test('a reused live PID with a different start time cannot prevent offline recovery',()=>{
  const f=fixture();crash(f,'received:0');const file=f.root+'/nnk-batches/active',owner=JSON.parse(readFileSync(file));
  writeFileSync(file,JSON.stringify({...owner,pid:process.pid,born:'1'}));assert.equal(core.recover(f.root).status,'rolled_back');old(f);
});
console.log('全部通过: '+passed+' 项');
