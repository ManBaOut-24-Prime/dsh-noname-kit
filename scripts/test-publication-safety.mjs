import testPaths from './fixtures/test-paths.cjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import childProcess from 'node:child_process';
import {fileURLToPath} from 'node:url';
// Inject managed helper failures at the process boundary; all filesystem,
// lease, hash and ACL operations still use the shipped implementations.
let helperFault=null;
const spawn=childProcess.spawn;
childProcess.spawn=function(command,args,options){
  let hashRequest;
  if(helperFault&&options.env?.NNK_BATCH_PUBLISH_REQUEST){
    const request=JSON.parse(fs.readFileSync(options.env.NNK_BATCH_PUBLISH_REQUEST));
    helperFault.requests.push(request);
    const source=args.at(-1).replace(/\r\n/g,'\n'),fault=helperFault.mode;
    const injected=fault==='before-move'?source.replace('if($command -eq 1){',"if($command -eq 1){throw 'Injected publication failure'};if($command -eq 1){"):
      fault==='after-move'?source.replace('$published=$true',"$published=$true;throw 'Injected post-publication failure'"):
      fault==='no-done'?source.replace('Reply $request.done',"throw 'Injected completion communication failure';Reply $request.done"):
      fault==='hash-window'?source.replace('    foreach($entry in $request.entries){\n        $file=CheckedPath $entry.path\n',"    [IO.File]::WriteAllText($RequestFile+'.hash-held','1');while(-not [IO.File]::Exists($RequestFile+'.hash-tested')){Start-Sleep -Milliseconds 20}\n    foreach($entry in $request.entries){\n        $file=CheckedPath $entry.path\n"):source;
    assert.notEqual(injected,source,'fault injection must match the actual helper');args=[...args.slice(0,-1),injected];
    if(fault==='hash-window')hashRequest=options.env.NNK_BATCH_PUBLISH_REQUEST;
  }
  const child=spawn.call(this,command,args,options);
  if(hashRequest)spawn(process.execPath,[fileURLToPath(import.meta.url),'--hash-window',hashRequest],{stdio:'ignore',windowsHide:true}).unref();
  return child;
};
const core=createRequire(import.meta.url)('../online-kernel/lib/batch-files.cjs');
childProcess.spawn=spawn;
const base=testPaths.assertTestPath(process.env.NNK_PUBLICATION_OUTPUT||testPaths.tempPrefix("publication-tests-")+randomUUID());
fs.mkdirSync(base,{recursive:true});
const sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
const hash=b=>createHash('sha256').update(b).digest('hex');
const names=['Audit-A','Audit-B'];
function fixture(){const root=fs.mkdtempSync(path.join(base,'fixture-'));for(const name of names){const dir=path.join(root,'extension',name);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(dir+'/extension.js','// old '+name+' inert review fixture\n');fs.writeFileSync(dir+'/data.txt','old '+name+' data\n');fs.writeFileSync(dir+'/local-extra.txt','preserved '+name+'\n')}return root}
function transaction(root,hook){const payload={};const batch={extensions:names.map(name=>({name,files:['extension.js','data.txt'].map(p=>{const bytes=Buffer.from(p==='extension.js'?'// new '+name+' inert review fixture\n':'new '+name+' data\n');payload[name+'/'+p]=bytes;return {path:p,size:bytes.length,sha256:hash(bytes)}})}))};const t=new core.Transaction(root,batch,{session:'1'.repeat(32),peerSession:'2'.repeat(32),proposal:'3'.repeat(32),digest:core.manifestDigest(batch)},{hook});for(let i=0;i<t.files.length;i++)t.putFile(i,payload[t.files[i].name+'/'+t.files[i].path]);t.prepare();return t}
function publication(t){const controls=fs.readdirSync(t.folder).filter(n=>/^publication-.*\.control$/.test(n));assert.equal(controls.length,1);const control=path.join(t.folder,controls[0]);return {control,done:control.replace(/\.control$/,'.done'),ready:control.replace(/\.control$/,'.ready')}}
function waitDone(file){const until=Date.now()+10000;while(!fs.existsSync(file)&&Date.now()<until)sleep(10);assert.equal(fs.existsSync(file),true,'helper must finish its controlled failure');return JSON.parse(fs.readFileSync(file,'utf8'))}
function complete(root,which){for(const name of names){for(const p of ['extension.js','data.txt']){const bytes=fs.readFileSync(root+'/extension/'+name+'/'+p);const wanted=Buffer.from(p==='extension.js'?'// '+which+' '+name+' inert review fixture\n':which+' '+name+' data\n');assert.equal(hash(bytes),hash(wanted))}assert.equal(fs.readFileSync(root+'/extension/'+name+'/local-extra.txt','utf8'),'preserved '+name+'\n')}assert.equal(fs.existsSync(root+'/nnk-batches/active'),false);assert.equal(core.recover(root).status,'none')}
if(process.argv[2]==='--contender'){
  const root=process.argv[3],errors={};for(const [key,fn] of [['begin',()=>transaction(root)],['recover',()=>core.recover(root)],['ordinary',()=>core.acquireWriteLease(root)]]){try{fn();throw Error('Conflicting owner was admitted')}catch(error){assert.match(error.message,/lease.*busy/i);errors[key]=error.message}}
  console.log(JSON.stringify({pid:process.pid,errors}));process.exit(0);
}
if(process.argv[2]==='--hash-window'){
  const request=process.argv[3],attempts=[];let failure;
  try{const until=Date.now()+10000;while(!fs.existsSync(request+'.hash-held')&&Date.now()<until)sleep(10);assert.equal(fs.existsSync(request+'.hash-held'),true);const r=JSON.parse(fs.readFileSync(request)),file=r.entries.find(e=>e.path.endsWith('data.txt')).path,before=fs.readFileSync(file);
    for(const [name,fn] of [['write',()=>fs.writeFileSync(file,'damage')],['rename',()=>fs.renameSync(file,file+'.moved')]]){let code;try{fn()}catch(error){code=error.code}attempts.push({name,code});if(name==='rename'&&!code)fs.renameSync(file+'.moved',file)}
    assert.equal(hash(fs.readFileSync(file)),hash(before));for(const a of attempts)assert.ok(['EPERM','EACCES','EBUSY'].includes(a.code),'hash-window '+a.name+' must be excluded by open handles');
  }catch(error){failure=error.message}finally{fs.writeFileSync(request+'.hash-result.json',JSON.stringify({attempts,failure}));fs.writeFileSync(request+'.hash-tested','1')}
  process.exit(failure?1:0);
}
let passed=0;const records=[];
async function test(name,fn){if(process.env.NNK_PUBLICATION_FILTER&&!name.includes(process.env.NNK_PUBLICATION_FILTER))return;try{await fn();passed++;console.log('  ✓ '+name)}catch(error){fs.writeFileSync(path.join(base,'results.json'),JSON.stringify({passed,records,failure:{name,message:error.message,stack:error.stack}},null,2));throw error}fs.writeFileSync(path.join(base,'results.json'),JSON.stringify({passed,records},null,2))}
await test('healthy helper protects and publishes the whole authorized generation',()=>{const root=fixture();let checked=0;const attempts=[];const t=transaction(root,event=>{if(event!=='verified:new')return;checked++;const dir=t.folder+'/workspace/Audit-A',file=dir+'/data.txt';for(const [name,fn] of [['write',()=>fs.writeFileSync(file,'damage')],['rename',()=>fs.renameSync(file,file+'.moved')],['add',()=>fs.writeFileSync(dir+'/unexpected','extra')]]){let code;assert.throws(fn,error=>{code=error.code;return ['EPERM','EACCES','EBUSY'].includes(code)});attempts.push({name,code})}});assert.equal(t.commit(()=>true).status,'committed');assert.equal(checked,1);complete(root,'new');records.push({case:'healthy',root,attempts})});
for(const which of ['new','old'])await test(which+' helper failure after validation cannot publish altered hidden content',()=>{
  const root=fixture();let t,checked=0,doneRecord,changed=false,before,ino;
  t=transaction(root,event=>{if(which==='old'&&event==='new:Audit-B'){core.recover(root,{owned:true,expectedId:t.id,lock:t.lock,hook:t.hook});throw Error('cancel before durable commit')}if(event!=='verified:'+which||checked++)return;const files=publication(t);fs.truncateSync(files.control,0);doneRecord=waitDone(files.done);assert.equal(doneRecord.ok,false);const target=t.folder+'/workspace/Audit-A/data.txt';before=fs.readFileSync(target);ino=String(fs.statSync(target,{bigint:true}).ino);fs.writeFileSync(target,Buffer.alloc(before.length,0x78));changed=true;assert.equal(String(fs.statSync(target,{bigint:true}).ino),ino)});
  let result,error;try{result=t.commit(()=>true)}catch(e){error={message:e.message,outcome:e.outcome}}
  const hidden=t.folder+'/workspace',formal=root+'/extension',state=core._test.stateRead(t.folder);
  records.push({case:which+'-helper-failure-and-content-change',root,result,error,doneRecord,changed,checked,formalExists:fs.existsSync(formal),activeExists:fs.existsSync(root+'/nnk-batches/active'),phase:state.phase,hiddenHash:fs.existsSync(hidden)?hash(fs.readFileSync(hidden+'/Audit-A/data.txt')):null});
  assert.equal(changed,true);assert.equal(error?.outcome?.status,'recovery_required');assert.equal(core.inspect(root).status,'pending');assert.equal(fs.existsSync(formal),false,'unverified generation must remain hidden');assert.equal(fs.existsSync(root+'/nnk-batches/active'),true);assert.equal(fs.existsSync(hidden),true);assert.equal(fs.existsSync(t.folder+'/descriptor.json'),true);assert.equal(hash(fs.readFileSync(hidden+'/Audit-A/data.txt')),hash(Buffer.alloc(before.length,0x78)));assert.equal(state.phase,which==='new'?'committed':'rolled_back');if(which==='new')for(const name of names)assert.equal(fs.readFileSync(t.folder+'/old/'+name+'/data.txt','utf8'),'old '+name+' data\n');
  assert.throws(()=>t.abort(),/SHA-256/);assert.equal(fs.existsSync(formal),false);assert.equal(JSON.parse(fs.readFileSync(root+'/nnk-batches/active')).released,true);assert.throws(()=>core.recover(root),/SHA-256/);assert.equal(fs.existsSync(root+'/nnk-batches/active'),true);
  fs.writeFileSync(hidden+'/Audit-A/data.txt',before);assert.equal(core.recover(root).status,which==='new'?'committed':'rolled_back');complete(root,which);
});
await test('terminated ready helper cannot perform the parent publication; retry validates afresh',()=>{
  const root=fixture();let killed=false,pid;const t=transaction(root,event=>{if(event!=='verified:new')return;const files=publication(t);pid=JSON.parse(fs.readFileSync(files.ready)).pid;process.kill(pid);const until=Date.now()+5000;while(Date.now()<until){try{process.kill(pid,0);sleep(10)}catch(error){if(error.code!=='ESRCH')throw error;killed=true;break}}assert.equal(killed,true);assert.equal(fs.existsSync(root+'/extension'),false);assert.equal(fs.existsSync(files.done),false);assert.throws(()=>fs.writeFileSync(t.folder+'/workspace/Audit-A/data.txt','damage'))});
  assert.equal(t.commit(()=>true).status,'committed');assert.equal(killed,true);complete(root,'new');const dones=fs.readdirSync(t.folder).filter(n=>n.endsWith('.done')).map(n=>JSON.parse(fs.readFileSync(t.folder+'/'+n)));assert.equal(dones.length,1);assert.equal(dones[0].published,true);records.push({case:'terminated-helper',root,pid,dones});
});
await test('persistent helper failure before move retains isolation, commit truth and recovery materials',()=>{
  const root=fixture(),t=transaction(root);helperFault={mode:'before-move',requests:[]};
  try{assert.throws(()=>t.commit(()=>true),error=>error.outcome?.status==='recovery_required');assert.equal(fs.existsSync(root+'/extension'),false);assert.equal(fs.existsSync(root+'/nnk-batches/active'),true);assert.equal(core._test.stateRead(t.folder).phase,'committed');assert.equal(helperFault.requests.length,2);for(const r of helperFault.requests){const done=JSON.parse(fs.readFileSync(r.done));assert.equal(done.ok,false);assert.equal(done.published,false)}for(const name of names)assert.equal(fs.readFileSync(t.folder+'/old/'+name+'/data.txt','utf8'),'old '+name+' data\n');records.push({case:'before-move-failure',root,requests:helperFault.requests})}finally{helperFault=null}
  assert.equal(t.abort().status,'committed');complete(root,'new');
});
for(const mode of ['after-move','no-done'])await test(mode+' failure cannot discard a durable committed generation or clear active',()=>{
  const root=fixture(),t=transaction(root);helperFault={mode,requests:[]};
  try{assert.throws(()=>t.commit(()=>true),error=>error.outcome?.status==='recovery_required');assert.equal(core._test.stateRead(t.folder).phase,'committed');assert.equal(fs.existsSync(root+'/nnk-batches/active'),true);assert.equal(fs.existsSync(t.folder+'/descriptor.json'),true);assert.equal(fs.existsSync(t.folder+'/workspace'),false);for(const name of names){assert.equal(fs.readFileSync(root+'/extension/'+name+'/data.txt','utf8'),'new '+name+' data\n');assert.equal(fs.readFileSync(t.folder+'/old/'+name+'/data.txt','utf8'),'old '+name+' data\n')}assert.equal(core.generation(root),t.id);records.push({case:mode,root,requests:helperFault.requests})}finally{helperFault=null}
  assert.equal(t.abort().status,'committed');complete(root,'new');
});
await test('parent marker failure cancels the helper and preserves a forward recovery entrance',()=>{
  const root=fixture(),t=transaction(root),rename=fs.renameSync;fs.renameSync=function(from,to){if(String(to)===path.join(root,'nnk-batches/generation.json'))throw Error('Injected generation fsync boundary failure');return rename.apply(this,arguments)};
  try{assert.throws(()=>t.commit(()=>true),error=>error.outcome?.status==='recovery_required');assert.equal(fs.existsSync(root+'/extension'),false);assert.equal(core._test.stateRead(t.folder).phase,'committed');assert.equal(fs.existsSync(root+'/nnk-batches/active'),true);const dones=fs.readdirSync(t.folder).filter(n=>n.endsWith('.done')).map(n=>JSON.parse(fs.readFileSync(t.folder+'/'+n)));assert.equal(dones.length,2);for(const done of dones){assert.equal(done.ok,true);assert.equal(done.published,false)}records.push({case:'parent-marker-failure',root,dones})}finally{fs.renameSync=rename}
  assert.equal(t.abort().status,'committed');complete(root,'new');
});
await test('parent exception before command cannot publish via finally and only fresh validation succeeds',()=>{
  const root=fixture(),t=transaction(root,event=>{if(event==='verified:new')throw Error('Injected parent exception')});assert.equal(t.commit(()=>true).status,'committed');const dones=fs.readdirSync(t.folder).filter(n=>n.endsWith('.done')).map(n=>JSON.parse(fs.readFileSync(t.folder+'/'+n)));assert.equal(dones.length,2);assert.deepEqual(dones.map(d=>d.published).sort(),[false,true]);complete(root,'new');records.push({case:'parent-exception',root,dones});
});
await test('a different process cannot acquire conflicting transaction, recovery or ordinary-write rights',()=>{
  const root=fixture(),t=transaction(root);try{const result=childProcess.spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--contender',root],{encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(result.status,0,result.stdout+result.stderr);const observed=JSON.parse(result.stdout);assert.notEqual(observed.pid,process.pid);t.lock.check();records.push({case:'interprocess-conflict',root,observed})}finally{t.abort()}complete(root,'old');
});
await test('hash handles exclude deletion and writers before ACL protection takes over',()=>{
  const root=fixture(),t=transaction(root);helperFault={mode:'hash-window',requests:[]};try{assert.equal(t.commit(()=>true).status,'committed');assert.equal(helperFault.requests.length,1);const file=helperFault.requests[0].ready.replace(/\.ready$/,'.json')+'.hash-result.json',observed=JSON.parse(fs.readFileSync(file));assert.equal(observed.failure,undefined);assert.equal(observed.attempts.length,2);records.push({case:'hash-to-acl-handoff',root,observed})}finally{helperFault=null}complete(root,'new');
});
console.log(`全部通过: ${passed} 项`);
