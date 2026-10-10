import testPaths from '../fixtures/test-paths.cjs';
// Create a retained recovery fixture using the exact installed package core.
import {mkdirSync,writeFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
const root=process.argv[2],core=createRequire(import.meta.url)(process.argv[3])
testPaths.assertTestPath(root,{parent:testPaths.tempDir(),prefix:'b7-loader-'})
mkdirSync(root+'/extension/untouched/empty',{recursive:true});writeFileSync(root+'/noname.js','');writeFileSync(root+'/extension/untouched/user.dat','untouched')
const names=['甲包','乙包'];for(const name of names){mkdirSync(root+'/extension/'+name);writeFileSync(root+'/extension/'+name+'/extension.js','old-'+name)}
const bytes=name=>Buffer.from('new-'+name),hash=b=>createHash('sha256').update(b).digest('hex')
const batch=core.normalize({extensions:names.map(name=>({name,files:[{path:'extension.js',size:bytes(name).length,sha256:hash(bytes(name))}]}))})
const tx=new core.Transaction(root,batch,{session:'a'.repeat(32),peerSession:'b'.repeat(32),proposal:'c'.repeat(32),digest:core.manifestDigest(batch)},{hook:e=>{if(e==='permissions:new:乙包')process.exit(86)}})
tx.files.forEach((f,i)=>tx.putFile(i,bytes(f.name)));tx.prepare();tx.commit(()=>true);throw Error('Crash point was not reached')
