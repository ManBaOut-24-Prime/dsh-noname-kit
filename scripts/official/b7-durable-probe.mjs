import testPaths from '../fixtures/test-paths.cjs';
// Programmatic Electron process-tree crash, same origin/profile, real official config
// and extension functions. All fixtures/logs are outside the engine and repository.
import {spawn,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync,copyFileSync,readdirSync,lstatSync,renameSync,unlinkSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const sourceRoot=fileURLToPath(new URL('../../',import.meta.url));
const exe=testPaths.testPath("temp/programmatic-electron/programmatic.exe");
const bootstrap=testPaths.testPath("temp/programmatic-electron/resources/app/probe.cjs");
const before=readFileSync(bootstrap);
const testRoot=testPaths.tempPrefix("b7-durable-")+randomUUID();mkdirSync(testRoot,{recursive:true});
const results=[],guardedRoots=[];
writeFileSync(bootstrap,`import(${JSON.stringify(new URL('./b7-durable-main.mjs',import.meta.url).href)});\n`);
async function run(options){
  const result=testRoot+'/'+options.label+'-'+options.phase+'-'+randomUUID()+'.json';
  const child=spawn(exe,[],{env:{...process.env,NNK_GATE_OPTIONS:JSON.stringify({...options,result,sourceRoot}),TEMP:testPaths.tempDir(),TMP:testPaths.tempDir()},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const ended=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));let value;
  try{
    const deadline=Date.now()+40000;
    while(!existsSync(result)){if(child.exitCode!==null)throw Error(output);if(Date.now()>deadline)throw Error('Probe timed out');await new Promise(r=>setTimeout(r,100))}
    value=JSON.parse(readFileSync(result));assert.equal(value.ok,true,JSON.stringify(value));
    if(options.phase==='lock'||options.waitForKill){
      if(options.phase==='lock')assert.equal(value.waitingForWholeProcessKill,true);
      const killed=spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{encoding:'utf8',windowsHide:true});assert.equal(killed.status,0,killed.stdout+killed.stderr);
      value.wholeProcessTreeKilled=true;
    }
    const status=await ended;if(options.phase!=='lock'&&!options.waitForKill)assert.equal(status.code,0,output);
    results.push({label:options.label,profile:options.userData,origin:'http://127.0.0.1:'+value.port,...value});return value;
  }finally{
    writeFileSync(result+'.console.log',output);
    if(child.exitCode===null)spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});
  }
}
function powershell(script,env={}){
  const environment={...process.env,...env};for(const key of Object.keys(environment))if(key.toLowerCase()==='psmodulepath')delete environment[key];
  const r=spawnSync(process.env.SystemRoot+'/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-Command','[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);'+script],{encoding:'utf8',windowsHide:true,env:environment,maxBuffer:16*1024*1024});
  assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout.trim();
}
function entries(root){const out=[];function walk(path,isRoot){const st=lstatSync(path);assert.equal(st.isSymbolicLink(),false);out.push({path,isRoot,isDirectory:st.isDirectory()});if(st.isDirectory())for(const n of readdirSync(path))walk(path+'/'+n,false)}walk(root,true);return out}
function acl(mode,root,items){
  const request=testRoot+'/acl-'+randomUUID()+'.json';writeFileSync(request,JSON.stringify({mode,root,entries:items}));
  const script=readFileSync(new URL('./b7-acl-helper.ps1',import.meta.url),'utf8');
  const output=powershell('& { '+script+' } $env:NNK_GATE_ACL_REQUEST',{NNK_GATE_ACL_REQUEST:request});return mode==='capture'?JSON.parse(output):null;
}
// Windows may set SE_DACL_AUTO_INHERITED during SetAccessControl/rename. Compare
// ACEs and protection exactly; AI is a derived control bit, not an access grant.
function canonical(items){return items.map(e=>({...e,sddl:e.sddl.replace(/^D:([^()]*)/,(_,flags)=>'D:'+flags.replace('AI',''))}))}
try{
  for(const label of ['Old','Latest']){
    const fixture=testRoot+'/'+label;mkdirSync(fixture,{recursive:true});
    const base={label,fixture,nativeHttp:process.env.NNK_GATE_NATIVE_HTTP==='1',engineRoot:testPaths.officialRoot(label),userData:testRoot+'/'+label+'-primary'};
    const seed=await run({...base,phase:'seed'});base.port=seed.port;
    await run({...base,phase:'seed',userData:testRoot+'/'+label+'-secondary'});
    const locked=await run({...base,phase:'lock'});assert.equal(locked.strictDurability,true);
    const restart=await run({...base,phase:'restart'});assert.equal(restart.unfinishedNewTop,0);assert.equal(restart.markerBeforeImport.id,'a'.repeat(32));
    const other=await run({...base,phase:'other-profile',userData:testRoot+'/'+label+'-secondary'});assert.equal(other.unfinishedNewTop,1);assert.equal(other.markerBeforeImport,null);
    copyFileSync(fixture+'/restore-config.txt',fixture+'/noname.config.txt');
    const restore=await run({...base,phase:'config-restore'});assert.equal(restore.unfinishedNewTop,1);assert.equal(restore.markerBeforeImport,null);
    // Offline Node-only recovery feasibility probe: no renderer, engine or network.
    const journal=JSON.parse(readFileSync(fixture+'/pending-journal.json'));for(const name of journal.extensions){
      const bytes=readFileSync(fixture+'/old/'+name+'.js');assert.equal(createHash('sha256').update(bytes).digest('hex'),journal.old[name]);copyFileSync(fixture+'/old/'+name+'.js',fixture+'/extension/'+name+'/extension.js');
    }
    const restored=await run({...base,phase:'offline-restored'});assert.equal(restored.unfinishedNewTop,0);
    // Alternative gate: deny payload reads in the filesystem, independent of config.
    for(const name of journal.extensions){const file=fixture+'/extension/'+name+'/extension.js';writeFileSync(file,readFileSync(file,'utf8').replace('generation:"old"','generation:"new"'))}
    const guarded=[];
    // Include a protected DACL: root inheritance alone must fail this control.
    powershell('$a=Get-Acl -LiteralPath $env:NNK_GATE_ACL_FILE;$a.SetAccessRuleProtection($true,$true);Set-Acl -LiteralPath $env:NNK_GATE_ACL_FILE -AclObject $a',{NNK_GATE_ACL_FILE:fixture+'/extension/B7-durable-A/extension.js'});
    for(const name of journal.extensions){const dir=fixture+'/extension/'+name;const item={dir,current:dir,saved:acl('capture',dir,entries(dir))};guarded.push(item);guardedRoots.push(item)}
    for(const g of guarded){const r=spawnSync('icacls.exe',[g.dir,'/deny','*S-1-1-0:(OI)(CI)(RD)'],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stdout+r.stderr)}
    const parentOnly=await run({...base,phase:'acl-parent-only'});assert.equal(parentOnly.unfinishedNewTop,1,'Protected file bypass must be reproduced');
    for(const g of guarded)acl('restore',g.dir,g.saved);
    for(const g of guarded){const items=g.saved.map(e=>({...e,...(!e.isDirectory?{sha256:createHash('sha256').update(readFileSync(e.path)).digest('hex')}: {})}));acl('freeze',g.dir,items)}
    const denied=e=>['EACCES','EPERM'].includes(e.code);
    for(const g of guarded){const file=g.dir+'/extension.js';assert.throws(()=>readFileSync(file),denied);assert.throws(()=>writeFileSync(file,'bad'),denied);assert.throws(()=>unlinkSync(file),denied)}
    const coldAcl=await run({...base,phase:'acl-cold',waitForKill:true});assert.equal(coldAcl.unfinishedNewTop,0);assert.equal(Object.values(coldAcl.counts).every(c=>c.top===0&&c.factory===0&&c.precontent===0),true);
    const crashedAcl=await run({...base,phase:'acl-crash-restart',nativeReload:true});assert.equal(crashedAcl.unfinishedNewTop,0);assert.equal(crashedAcl.beforeNativeReload.unfinishedNewTop,0);
    copyFileSync(fixture+'/restore-config.txt',fixture+'/noname.config.txt');
    const configAcl=await run({...base,phase:'acl-config-restore'});assert.equal(configAcl.unfinishedNewTop,0);
    const profileAcl=await run({...base,phase:'acl-other-profile',userData:testRoot+'/'+label+'-secondary'});assert.equal(profileAcl.unfinishedNewTop,0);
    // Moving a guarded generation keeps its deny rules; offline restoration uses
    // exact saved DACLs, including the protected child, without engine/network.
    for(const g of guarded){const original=g.dir,moved=fixture+'/quarantined-'+original.split('/').at(-1);renameSync(original,moved);g.current=moved;
      assert.throws(()=>readFileSync(moved+'/extension.js'),denied);
      const relocated=g.saved.map(e=>({...e,path:e.path.replace(original.replaceAll('/','\\'),moved.replaceAll('/','\\'))}));
      acl('restore',moved,relocated);assert.deepEqual(canonical(acl('capture',moved,entries(moved))),canonical(relocated));renameSync(moved,original);g.current=original;
    }
    const activated=await run({...base,phase:'acl-whole-verified-activated'});assert.equal(activated.unfinishedNewTop,2);
  }
  const report={ok:true,gatePassed:true,testRoot,results,note:'Config isolation rejected. Explicit filesystem deny rules on every payload entry (including protected DACLs) prevent real official imports across cold/native reload/whole process-tree crash/config restore/other profile; guarded directory rename preserves isolation; offline Node/PowerShell restores exact DACLs without network. This proves an ACL candidate in controlled Windows fixtures, NOT a complete production transaction or permission to unpause. Production must persist original DACLs and verify protected immutable stages before publication, restore only after whole old/new coherence, and handle every permission/rename/journal failure.'};
  writeFileSync(testPaths.outputPath("b7-durable-gate.json"),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:true,testRoot,scenarios:results.length,gatePassed:true}));
}finally{
  try{for(const g of guardedRoots){const saved=g.saved.map(e=>({...e,path:e.path.replace(g.dir.replaceAll('/','\\'),g.current.replaceAll('/','\\'))}));acl('restore',g.current,saved)}}finally{writeFileSync(bootstrap,before)}
}
