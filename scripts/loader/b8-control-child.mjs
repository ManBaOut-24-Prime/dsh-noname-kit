import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const require=createRequire(import.meta.url),core=require('../../online-kernel/lib/batch-files.cjs'),root=process.argv[2],out=process.argv[3];
const bytes=Buffer.from('candidate content'),names=['B8-loader-A','B8-loader-B'],batch=core.normalize({extensions:names.map(name=>({name,files:[{path:'extension.js',size:bytes.length,sha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex')}]}))});
for(const name of names){mkdirSync(root+'/extension/'+name);writeFileSync(root+'/extension/'+name+'/extension.js','old '+name)}
const binding={session:'a'.repeat(32),peerSession:'b'.repeat(32),proposal:'c'.repeat(32),digest:core.manifestDigest(batch)};
const tx=new core.Transaction(root,batch,binding,{hook:e=>{if(e!=='new:B8-loader-A')return;
  writeFileSync(out,JSON.stringify({binding,folder:tx.folder}));const deadline=Date.now()+45000;
  while(readFileSync(tx.folder+'/cancel.bin')[0]!==1){if(Date.now()>deadline)throw Error('Cancel test deadline exceeded');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30)}
}});for(let i=0;i<2;i++)tx.putChunk(i,0,bytes,true);
writeFileSync(tx.folder+'/grant.json',JSON.stringify(binding));writeFileSync(tx.folder+'/cancel.bin',Buffer.from([0]));tx.prepare();
try{tx.commit(()=>readFileSync(tx.folder+'/cancel.bin')[0]===0);throw Error('Cancellation was ignored')}
catch(error){if(error.outcome?.status!=='rolled_back')throw error;writeFileSync(out+'.done',JSON.stringify(error.outcome))}
