import testPaths from '../fixtures/test-paths.cjs';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const source=fileURLToPath(new URL('../../',import.meta.url)),bootstrap=testPaths.testPath("temp/programmatic-electron/resources/app/probe.cjs"),before=readFileSync(bootstrap),out=[];
try{
  writeFileSync(bootstrap,"(async()=>{await import('"+testPaths.sourceUrl('scripts/official/batch-main.mjs')+"')})().catch(e=>{console.error(e);require('electron').app.exit(1)});");
  for(const label of ['Old','Latest']){
    const fixture=mkdtempSync(testPaths.tempPrefix("b8-official-")+label+'-');
    const child=spawn(testPaths.testPath("temp/programmatic-electron/programmatic.exe"),[label],{windowsHide:true,env:{...process.env,NNK_BATCH_PROBE:'b8',NNK_B8_ROOT:fixture,NNK_SOURCE_ROOT:source,NNK_ENGINE_ROOT:testPaths.officialRoot(label),TEMP:testPaths.tempDir(),TMP:testPaths.tempDir()},stdio:['ignore','pipe','pipe']});
    let text='';child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>text+=b);const timeout=setTimeout(()=>child.kill(),180000);
    const code=await new Promise(r=>child.once('exit',r));clearTimeout(timeout);writeFileSync(`${testPaths.logsDir()}/b8-official-${label}.console.log`,text);assert.equal(code,0,text.slice(-6000));
    const result=JSON.parse(readFileSync(`${testPaths.logsDir()}/b8-official-${label}.json`));assert.equal(result.ok,true);out.push(result);console.log(label+': '+result.checks.length+' checks passed');
  }
  writeFileSync(testPaths.outputPath("b8-official-results.json"),JSON.stringify({ok:true,out},null,2));
}finally{writeFileSync(bootstrap,before)}
