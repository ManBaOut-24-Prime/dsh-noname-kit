/** Full official startup isolation/recovery matrix on explicitly marked fixtures.
 * Config is imported through the engine's normal noname.config.txt mechanism.
 * The extension probes use shared DOM counters, including sandboxed factories.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {OfficialShell,fingerprint} from './full-boot-probe.mjs';
import {installKernel} from '../../src/online.js';
const require=createRequire(import.meta.url),core=require('../../online-kernel/lib/batch-files.cjs');
const names=['F3-A','F3-B'],hash=b=>createHash('sha256').update(b).digest('hex');
function code(name,generation){const hit=stage=>`document.documentElement.setAttribute('data-g1-${name}-${stage}',${JSON.stringify(generation)});document.documentElement.setAttribute('data-g1-${name}-${stage}-count',String(Number(document.documentElement.getAttribute('data-g1-${name}-${stage}-count')||0)+1));`;
  return `export const type='extension';${hit('top')}export default function(){${hit('factory')}return {name:${JSON.stringify(name)},connect:true,config:{},package:{character:{character:{${JSON.stringify(name+'-unit')}:['male','wei',4,[]]}}},precontent:function(){${hit('precontent')}}}}`;
}
if(process.argv[2]==='--crash'){
  const request=JSON.parse(fs.readFileSync(process.argv[3],'utf8')),tx=new core.Transaction(request.root,request.batch,request.binding,{hook:event=>{if(event===request.point)process.exit(86)}});
  for(let i=0;i<request.bytes.length;i++)tx.putFile(i,Buffer.from(request.bytes[i],'base64'));tx.prepare();tx.commit(()=>true);process.exit(87);
}
function seed(root,autoImport=false){const config={mode:'connect',extensions:['联机助手',...names],extension_联机助手_enable:true,extension_auto_import:autoImport,show_splash:'off',new_tutorial:false,nnk_unlockUIExtensions:true};for(const n of names)config['extension_'+n+'_enable']=true;
  fs.writeFileSync(path.join(root,'noname.config.txt'),Buffer.from(JSON.stringify({config,data:{}}),'utf8').toString('base64'));
}
function resetProbes(root){for(const n of names){fs.mkdirSync(path.join(root,'extension',n),{recursive:true});fs.writeFileSync(path.join(root,'extension',n,'extension.js'),code(n,'old'));fs.writeFileSync(path.join(root,'extension',n,'data.txt'),'old '+n);fs.writeFileSync(path.join(root,'extension',n,'personal.txt'),'retained '+n)}}
function request(root,point){const extensions=names.map(name=>({name,files:[{path:'extension.js',bytes:Buffer.from(code(name,'new'))},{path:'data.txt',bytes:Buffer.from('new '+name)}]})),data=new Map(extensions.flatMap(e=>e.files.map(f=>[e.name+'/'+f.path,f.bytes]))),batch=core.normalize({extensions:extensions.map(e=>({name:e.name,files:e.files.map(f=>({path:f.path,size:f.bytes.length,sha256:hash(f.bytes)}))}))});
  return {root,point,batch,binding:{session:'a'.repeat(32),peerSession:'b'.repeat(32),proposal:'c'.repeat(32),digest:core.manifestDigest(batch)},bytes:batch.extensions.flatMap(e=>e.files.map(f=>data.get(e.name+'/'+f.path).toString('base64')))};
}
function positive(value,generation){assert.equal(value.bootComplete,true);assert.equal(value.bootStage,'ready');assert.equal(value.kernelVersion,'0.3.87');assert.equal(value.paused,true);assert.equal(value.legacyPaused,true);assert.deepEqual(value.enabled,[true,true]);assert.equal(value.disableFlag,null);
  for(const n of names)for(const stage of ['top','factory','precontent']){assert.equal(value.counts['data-g1-'+n.toLowerCase()+'-'+stage],generation);assert.equal(value.counts['data-g1-'+n.toLowerCase()+'-'+stage+'-count'],'1')}
}
function isolated(value,root){assert.equal(fs.existsSync(path.join(root,'extension')),false,'An unexpected formal namespace was created');assert.ok(fs.existsSync(path.join(root,'nnk-batches','active')));assert.deepEqual(value.enabled,[true,true]);assert.equal(value.disableFlag,null);
  assert.equal(value.node,true);assert.deepEqual(value.counts,{});assert.equal(value.url,'http://localhost:8089/index.html');
}
const roots=[process.env.NNK_G1_OLD,process.env.NNK_G1_LATEST].filter(Boolean),out=process.env.NNK_G1_OUTPUT;if(!roots.length||!out)throw Error('Set NNK_G1_OLD/NNK_G1_LATEST and NNK_G1_OUTPUT to marked fixture/output directories');fs.mkdirSync(out,{recursive:true});
const results=[];let checks=0;
function record(value){results.push(value);fs.writeFileSync(path.join(out,'full-boot-results.json'),JSON.stringify({checks,results},null,2))}
async function cold(official,label){const shell=new OfficialShell(official,out,label);try{await shell.start();return await shell.observe({allowBootFailure:true})}finally{await shell.close()}}
for(const official of roots){
  const marker=JSON.parse(fs.readFileSync(path.join(official,'.nnk-full-fixture.json'),'utf8'));assert.equal(marker.kind,'noname-kit-full-engine-fixture');const root=path.join(official,'resources/app'),original=fingerprint(official);
  assert.equal(fs.existsSync(path.join(root,'nnk-batches','active')),false,'An earlier test transaction must be recovered explicitly');
  // Existing actual Loader bridge configuration is retained when supplied.
  const configFile=path.join(root,'extension/联机助手/nnk-bridge.json'),bridge=fs.existsSync(configFile)?JSON.parse(fs.readFileSync(configFile,'utf8')):{baseUrl:'http://127.0.0.1:59999/noname-kit-api',token:'a'.repeat(64)};
  assert.equal(installKernel({nonameDir:root,baseUrl:bridge.baseUrl,token:bridge.token}).ok,true);
  resetProbes(root);seed(root);const first=await cold(official,marker.version+'-whole-old');positive(first,'old');checks++;record({...first,expected:'whole-old'});console.log(marker.version+' whole-old passed');
  for(const [point,outcome]of [['withdraw','rolled_back'],['permissions:new:F3-A','committed']]){
    resetProbes(root);seed(root);const input=request(root,point),file=path.join(out,marker.version+'-'+point.replaceAll(':','-')+'-request.json');fs.writeFileSync(file,JSON.stringify(input));
    const crash=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--crash',file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(crash.status,86,crash.stdout+crash.stderr);assert.equal(fs.existsSync(path.join(root,'extension')),false);
    const label=marker.version+'-'+point.replaceAll(':','-'),shell=new OfficialShell(official,out,label);let hidden,reloaded;
    try{await shell.start();hidden=await shell.observe({allowBootFailure:true});isolated(hidden,root);checks++;record({...hidden,expected:'isolated-cold',point});
      await shell.configure({extension_auto_import:true});reloaded=await shell.reload();isolated(reloaded,root);assert.equal(reloaded.autoImport,true);checks++;record({...reloaded,expected:'isolated-native-reload-auto-discovery',point});
    }finally{await shell.close()}
    // Hard-killed shell, then its original cold startup reads durable config.
    const restarted=await cold(official,label+'-crash-restart');isolated(restarted,root);assert.equal(restarted.autoImport,true);checks++;record({...restarted,expected:'isolated-shell-crash-restart',point});
    const result=core.recover(root);assert.equal(result.status,outcome);assert.equal(core.recover(root).status,'none');checks++;
    for(const n of names)assert.equal(fs.readFileSync(path.join(root,'extension',n,'personal.txt'),'utf8'),'retained '+n);
    const final=await cold(official,label+'-recovered');positive(final,outcome==='committed'?'new':'old');checks++;record({...final,expected:outcome==='committed'?'whole-new':'whole-old',point,recovery:result});
    console.log(marker.version+' '+point+' isolation/recovery passed');
  }
  assert.deepEqual(fingerprint(official),original);checks++;record({version:marker.version,originalSourcesUnchanged:true,original});
}
fs.writeFileSync(path.join(out,'full-boot-results.json'),JSON.stringify({ok:true,checks,results},null,2));console.log('FULL-BOOT GATE PASS checks='+checks);
