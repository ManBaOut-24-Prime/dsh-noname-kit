import testPaths from './fixtures/test-paths.cjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),core=require('../online-kernel/lib/batch-files.cjs'),runtime=require('../online-kernel/lib/batch-runtime.cjs');
const base=testPaths.tempPrefix("f1-recovery-")+randomUUID();fs.mkdirSync(base,{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(){const root=path.join(base,randomUUID());for(const n of ['A','B']){fs.mkdirSync(root+'/extension/'+n,{recursive:true});for(const f of ['extension.js','data','extra'])fs.writeFileSync(root+'/extension/'+n+'/'+f,'old '+n+'/'+f)}return root}
function tx(root,hook){const batch=core.normalize({extensions:['A','B'].map(name=>({name,files:['extension.js','data'].map(file=>{const bytes=Buffer.from('new '+name+'/'+file);return {path:file,size:bytes.length,sha256:hash(bytes)}})}))});const t=new core.Transaction(root,batch,{session:'a'.repeat(32),peerSession:'b'.repeat(32),proposal:'c'.repeat(32),digest:core.manifestDigest(batch)},{hook});for(let i=0;i<t.files.length;i++){const f=t.files[i];t.putFile(i,Buffer.from('new '+f.name+'/'+f.path))}t.prepare();return t}
function folder(root){return path.join(root,'nnk-batches',JSON.parse(fs.readFileSync(root+'/nnk-batches/active')).id)}
function whole(root,which){for(const n of ['A','B']){for(const f of ['extension.js','data'])assert.equal(fs.readFileSync(root+'/extension/'+n+'/'+f,'utf8'),which+' '+n+'/'+f);assert.equal(fs.readFileSync(root+'/extension/'+n+'/extra','utf8'),'old '+n+'/extra')}}
function crash(root,mode,event){const r=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--child',root,mode,event],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(r.status,86,r.stdout+r.stderr)}
if(process.argv[2]==='--child'){const [root,mode,event]=process.argv.slice(3);const hook=e=>{if(e===event)process.exit(86)};if(mode==='commit')tx(root,hook).commit(()=>true);else core.recover(root,{hook});throw Error('Exit hook was not reached')}
let passed=0;async function test(name,fn){await fn();passed++;console.log('  ✓ '+name)}
for(const g of ['old','new'])await test('interrupted '+g+' permission restore rejects same-inode byte corruption and remains retryable',()=>{
  const root=fixture();if(g==='new')crash(root,'commit','permissions:new:A');else{crash(root,'commit','new:B');crash(root,'recover','permissions:old:A')}
  const target=path.join(folder(root),'workspace/A/data'),ino=fs.statSync(target,{bigint:true}).ino;fs.writeFileSync(target,'');assert.equal(fs.statSync(target,{bigint:true}).ino,ino);
  assert.throws(()=>core.recover(root),/size|SHA-256/);assert.equal(fs.existsSync(root+'/extension'),false);assert.equal(fs.existsSync(root+'/nnk-batches/active'),true);
  fs.writeFileSync(target,g+' A/data');assert.equal(core.recover(root).status,g==='new'?'committed':'rolled_back');whole(root,g);assert.equal(core.recover(root).status,'none');
});
await test('publication guards exclude content writers and path changes until rename',()=>{const root=fixture();let verified=0;const t=tx(root,e=>{if(e==='verified:new'){verified++;const p=path.join(t.folder,'workspace/A/data');assert.throws(()=>fs.writeFileSync(p,'damage'));assert.throws(()=>fs.renameSync(p,p+'.other'));assert.throws(()=>fs.writeFileSync(path.join(t.folder,'workspace/A/unexpected'),'extra'))}});assert.equal(t.commit(()=>true).status,'committed');assert.equal(verified,1);whole(root,'new')});
await test('publication control writer overlap cannot release guards or produce false recovery',()=>{
  const root=fixture();let held=false,endedEarly=false,writerOpened=false;const t=tx(root,event=>{if(event!=='verified:new')return;held=true;const control=fs.readdirSync(t.folder).find(n=>n.startsWith('publication-')&&n.endsWith('.control')),file=path.join(t.folder,control),fd=fs.openSync(file,'r+');
    try{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);endedEarly=fs.existsSync(file.replace(/\.control$/,'.done'));let writer;try{writer=fs.openSync(path.join(t.folder,'workspace/A/data'),'r+');writerOpened=true}catch(error){if(!['EPERM','EACCES'].includes(error.code))throw error}finally{if(writer!==undefined)fs.closeSync(writer)}}finally{fs.closeSync(fd)}
  });assert.equal(t.commit(()=>true).status,'committed');assert.equal(held,true);assert.equal(endedEarly,false,'Publisher ended while its live controller held a control writer');assert.equal(writerOpened,false,'Publication protection ended before rename');whole(root,'new');assert.equal(fs.existsSync(root+'/nnk-batches/active'),false);
});
await test('lease control writer overlap cannot release a live native mutex',()=>{
  const root=fixture(),lease=core.acquireWriteLease(root),dir=path.join(root,'nnk-batches/leases'),file=path.join(dir,fs.readdirSync(dir).find(n=>n.endsWith('.control'))),fd=fs.openSync(file,'r+');
  try{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);lease.check();assert.equal(fs.existsSync(file.replace(/\.control$/,'.done')),false)}finally{fs.closeSync(fd);lease.release()}
});
await test('rollback failure and failed abort release ownership for live-process recovery',()=>{const root=fixture(),t=tx(root,e=>{if(e==='new:B')throw Error('stop before commit')}),original=fs.renameSync;let inject=true;fs.renameSync=function(from,to){if(inject&&String(from).startsWith(t.folder+path.sep+'old'+path.sep))throw Object.assign(Error('temporary old rename'),{code:'EPERM'});return original.apply(this,arguments)};
  try{assert.throws(()=>t.commit(()=>true),e=>e.outcome?.status==='recovery_required');assert.throws(()=>t.abort(),/temporary/);inject=false;assert.equal(core.recover(root).status,'rolled_back');whole(root,'old');assert.equal(core.recover(root).status,'none');assert.throws(()=>t.putFile(0,Buffer.from('old owner')))}finally{fs.renameSync=original}
});
await test('armed slot downgrade after withdrawal preserves index and restores real namespace',()=>{const root=fixture();crash(root,'commit','withdraw');const file=folder(root)+'/state.bin',before=fs.readFileSync(file),state=core._test.stateRead(folder(root));assert.equal(state.phase,'armed');before[(state.seq%2)*8192]=0;fs.writeFileSync(file,before);assert.equal(core._test.stateRead(folder(root)).phase,'prepared');assert.equal(core.recover(root).status,'rolled_back');whole(root,'old');assert.equal(core.recover(root).status,'none')});
await test('unprepared state cannot clear active with a hidden namespace',()=>{const root=fixture(),t=tx(root);fs.renameSync(root+'/extension',t.folder+'/workspace');const bytes=fs.readFileSync(t.folder+'/state.bin'),s=core._test.stateRead(t.folder);bytes[(s.seq%2)*8192]=0;fs.writeFileSync(t.folder+'/state.bin',bytes);assert.throws(()=>t.abort(),/Unprepared/);assert.equal(fs.existsSync(root+'/nnk-batches/active'),true);assert.equal(fs.existsSync(root+'/extension'),false);fs.renameSync(t.folder+'/workspace',root+'/extension');assert.equal(core.recover(root).status,'rolled_back');whole(root,'old')});
function observer(root){return runtime.createRuntime({state:{},env:{lib:{version:'1.11.6',config:{}},game:{},_status:{}},modules:{compat:{gameRoot:()=>root}}})}
await test('disk pending blocks every socket and old recovery clears only the pending gate',()=>{const root=fixture(),watch=observer(root);assert.equal(watch.canEnter({}),true);const t=tx(root);assert.equal(watch.canEnter({}),false);t.abort();assert.equal(watch.canEnter({}),true)});
await test('offline forward recovery publishes a persistent generation requiring fresh runtime',()=>{const root=fixture(),watch=observer(root);crash(root,'commit','permissions:new:A');assert.equal(watch.canEnter({}),false);assert.equal(core.recover(root).status,'committed');assert.equal(watch.canEnter({}),false);assert.equal(observer(root).canEnter({}),true);whole(root,'new')});
console.log(`全部通过: ${passed} 项`);
