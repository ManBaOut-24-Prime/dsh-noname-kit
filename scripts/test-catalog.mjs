#!/usr/bin/env node
/** Read-only catalog checks against authored, disposable source fixtures. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, symlink, rm } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import testPaths from './fixtures/test-paths.cjs'
import { listCatalog, readCatalog } from '../src/catalog.js'

const home = testPaths.assertTestPath(await mkdtemp(testPaths.tempPrefix('catalog-')))
const game = testPaths.assertTestPath(join(home, 'game'))
const checks = [], failures = [], skipped = []
async function check(name, fn) { try { await fn(); checks.push(name) } catch (error) { failures.push({ name, message: error.stack || String(error) }) } }
async function put(file, code) { const target = join(game, file); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, code) }
async function snapshot(dir, rel = '') { const out = {}; for (const e of await readdir(join(dir, rel), { withFileTypes: true })) { const key = join(rel, e.name), full = join(dir, key), info = await lstat(full); if (info.isSymbolicLink()) out[key] = 'link'; else if (info.isDirectory()) Object.assign(out, await snapshot(dir, key)); else out[key] = createHash('sha256').update(await readFile(full)).digest('hex') } return out }
try {
  await mkdir(game, { recursive: true })
  await put('character/heroes.js', `throw new Error('Source must never execute');
const characters={fixture_alpha:{sex:'male',group:'wei',hp:4,skills:['fixture_guard']},fixture_á:{sex:'female',group:'wu',hp:3,skills:[]}};
const skills={fixture_guard:{trigger:{player:'phaseBegin'},content(){}}};
export default {name:'heroes',character:characters,skill:skills,translate:{fixture_alpha:'Alpha',fixture_á:'Accent',fixture_guard:'Guard'}};`)
  await put('character/rank.js', `export default {s:['fixture_alpha']};`)
  await put('card/deck.js', `const cards$1={fixture_token:{type:'basic'}};export default {name:'deck',card:cards$1,translate:{fixture_token:'Token'}};`)
  await put('mode/story.js', `export const type='mode';const story={name:'story',skill:{fixture_rule:{forced:true}},translate:{story:'Story'}};export default story;`)
  await put('mode/federation/index.js', `import character from './src/character/base.js';import skill from './src/skill/base.js';export const type='mode';export default {name:'federation',character,skill};`)
  await put('mode/federation/src/character/base.js', `import {lib} from 'noname';const Character=lib.element.Character;export default {fixture_union:new Character({sex:'male',group:'wei',hp:4,skills:['fixture_union_rule']})};`)
  await put('mode/federation/src/character/unreachable.js', `const characters={fixture_unreachable:{hp:9,skills:[]}};export default characters;`)
  await put('mode/federation/src/skill/base.js', `export default {fixture_union_rule:{forced:true}};`)
  await put('extension/ModuleFixture/extension.js', `import {game} from 'noname';export default {name:'ModuleFixture',content(){const mode={name:'fixture_embedded',skill:{fixture_embedded_rule:{forced:true}},translate:{fixture_embedded:'Embedded'}};game.addMode('fixture_embedded',mode);}};`)
  await put('extension/ModuleFixture/character/character.js', `const characters={fixture_ext:{sex:'male',group:'qun',hp:4,skills:['fixture_ext_rule']}};export default characters;`)
  await put('extension/ModuleFixture/character/skill.js', `const skills={fixture_ext_rule:{forced:true}};export default skills;`)
  await put('extension/DuplicateFixture/extension.js', `export default {name:'DuplicateFixture'};`)
  await put('extension/DuplicateFixture/a.js', `const characters={fixture_duplicate:{hp:3,skills:[]}};export default characters;`)
  await put('extension/DuplicateFixture/b.js', `const characters={fixture_duplicate:{hp:4,skills:[]}};export default characters;`)
  await put('extension/DynamicFixture/extension.js', `import {game} from 'noname';export default {name:'DynamicFixture',content(){const id=computeModeId();game.addMode(id,{name:id,skill:{fixture_dynamic_rule:{forced:true}}});}};`)
  const before = await snapshot(game)
  let catalog
  await check('builtin pack grouping and auxiliary metadata', async () => { catalog = await listCatalog(game,{source:'builtin',includeEntries:true}); assert.equal(catalog.ok,true); assert.equal(catalog.readOnly,true); assert.deepEqual(catalog.packs.map(p=>`${p.kind}:${p.pack}`).sort(),['card:deck','character:heroes','mode:federation','mode:story']); assert.ok(catalog.coverage.auxiliaryFiles.includes('character/rank.js')) })
  await check('Unicode character entries and exact file ownership', async () => { const p=catalog.packs.find(p=>p.pack==='heroes'); assert.ok(p.entries.some(e=>e.kind==='character'&&e.id==='fixture_á'&&e.file==='character/heroes.js')); assert.ok(p.entries.every(e=>e.readOnly===true)) })
  await check('alias default card descriptor', async () => { const p=catalog.packs.find(p=>p.pack==='deck'); assert.equal(p.counts.card,1); assert.ok(p.entries.some(e=>e.id==='fixture_token')) })
  await check('builtin mode registration is listed', async () => { const p=catalog.packs.find(p=>p.pack==='story'); assert.ok(p.modes.some(m=>m.id==='story')); assert.equal(p.counts.skill,1) })
  await check('multifile mode follows character and skill imports', async () => { const p=catalog.packs.find(p=>p.pack==='federation'); assert.ok(p.files.includes('mode/federation/src/character/base.js')); assert.ok(p.entries.some(e=>e.id==='fixture_union'&&e.file==='mode/federation/src/character/base.js')); assert.ok(p.entries.some(e=>e.id==='fixture_union_rule')); assert.ok(!p.entries.some(e=>e.id==='fixture_unreachable')); assert.equal(p.inventoryScope,'registered-entry') })
  await check('catalog entry read uses exact inclusive source range', async () => { const r=await readCatalog(game,{source:'builtin',kind:'character',pack:'heroes',entry:'character:fixture_á'}); assert.equal(r.ok,true); assert.equal(r.readOnly,true); assert.equal(r.code,"fixture_á:{sex:'female',group:'wu',hp:3,skills:[]}") })
  await check('official whole-file read stays readonly', async () => { const r=await readCatalog(game,{source:'builtin',kind:'card',pack:'deck'}); assert.equal(r.ok,true); assert.match(r.code,/const cards\$1=/); assert.equal(r.file,'card/deck.js'); assert.equal(r.readOnly,true) })
  await check('multifile mode child source is readable', async () => { const r=await readCatalog(game,{source:'builtin',kind:'mode',pack:'federation',entry:'character:fixture_union'}); assert.equal(r.ok,true); assert.match(r.code,/new Character/); assert.equal(r.file,'mode/federation/src/character/base.js') })
  await check('embedded extension mode is callable from catalog', async () => { const c=await listCatalog(game,{source:'extension',kind:'mode',pack:'ModuleFixture'}); assert.equal(c.ok,true); assert.equal(c.packs.length,1); assert.ok(c.packs[0].modes.some(m=>m.id==='fixture_embedded')); const r=await readCatalog(game,{source:'extension',kind:'mode',pack:'ModuleFixture',entry:'mode:fixture_embedded'}); assert.equal(r.ok,true); assert.match(r.code,/fixture_embedded_rule/); assert.equal(r.file,'extension/ModuleFixture/extension.js') })
  await check('all modules of an installed extension are included', async () => { const c=await listCatalog(game,{source:'extension',kind:'character',pack:'ModuleFixture'}); assert.equal(c.ok,true); assert.ok(c.packs[0].entries.some(e=>e.id==='fixture_ext')); assert.ok(c.packs[0].entries.some(e=>e.id==='fixture_ext_rule')) })
  await check('dynamic registration stays an explicit coverage gap',async()=>{const c=await listCatalog(game,{source:'extension',kind:'mode',pack:'DynamicFixture'});assert.equal(c.coverage.complete,false);assert.ok(c.coverage.gaps.some(g=>g.code==='dynamic-registration'||g.code==='static-unresolved'));assert.ok(!c.packs.some(p=>p.modes.some(m=>m.id==='computeModeId')))})
  await check('duplicate physical IDs require source selection', async () => { const c=await listCatalog(game,{source:'extension',kind:'character',pack:'DuplicateFixture'}); assert.equal(c.packs[0].counts.character,1); assert.equal(c.packs[0].definitionCounts.character,2); assert.equal(c.packs[0].ambiguities[0].sources.length,2); const r=await readCatalog(game,{source:'extension',kind:'character',pack:'DuplicateFixture',entry:'character:fixture_duplicate'}); assert.equal(r.ok,false); assert.equal(r.candidates.length,2); const selected=await readCatalog(game,{source:'extension',kind:'character',pack:'DuplicateFixture',entry:'character:fixture_duplicate',file:'extension/DuplicateFixture/b.js'}); assert.equal(selected.ok,true); assert.match(selected.code,/hp:4/) })
  await check('cross-pack file read is refused', async () => { const r=await readCatalog(game,{source:'builtin',kind:'character',pack:'heroes',file:'card/deck.js'}); assert.equal(r.ok,false); assert.match(r.error,/不属于/) })
  for (const file of ['../outside.js','/outside.js','C:/outside.js','character/../outside.js','character\\..\\outside.js','character/.private.js','character/heroes.json']) await check('refuse unsafe file '+file,async()=>{ const r=await readCatalog(game,{source:'builtin',kind:'character',pack:'heroes',file}); assert.equal(r.ok,false) })
  for (const pack of ['..','../heroes','heroes/x','heroes\\x','C:heroes','.hidden']) await check('refuse unsafe pack '+pack,async()=>{ const r=await listCatalog(game,{source:'builtin',kind:'character',pack}); assert.equal(r.ok,false) })
  await check('missing config fails explicitly',async()=>{ const r=await listCatalog(''); assert.equal(r.ok,false); assert.equal(r.readOnly,true) })
  await check('normal catalog/read never modifies input bytes',async()=>{assert.deepEqual(await snapshot(game),before)})
  await put('mode/broken.js','export default { broken: ; }')
  await check('parse failures are coverage gaps',async()=>{const r=await listCatalog(game,{source:'builtin',kind:'mode'});assert.ok(r.coverage.gaps.some(g=>g.code==='parse-failed'&&g.file==='mode/broken.js'));assert.equal(r.coverage.complete,false)})
  await put('mode/oversized.js',' '.repeat(8*1024*1024+1))
  await check('oversized source is refused without silent coverage',async()=>{const r=await listCatalog(game,{source:'builtin',kind:'mode',pack:'oversized'});assert.ok(r.coverage.gaps.some(g=>g.code==='unreadable-file'&&g.file==='mode/oversized.js'));const read=await readCatalog(game,{source:'builtin',kind:'mode',pack:'oversized'});assert.equal(read.ok,false)})
  const outside=testPaths.assertTestPath(join(home,'outside'));await mkdir(outside,{recursive:true});await writeFile(join(outside,'character.js'),"const characters={fixture_escape:{hp:9,skills:[]}};export default characters;")
  let linkReady=false
  try { await symlink(outside,join(game,'character','escape'),process.platform==='win32'?'junction':'dir');linkReady=true } catch(error){skipped.push({name:'symlink escape fixture',reason:error.code||error.message})}
  if(linkReady) await check('realpath and symlink escape are refused',async()=>{const r=await listCatalog(game,{source:'builtin',kind:'character',includeEntries:true});assert.ok(r.coverage.gaps.some(g=>g.code==='symlink-skipped'));assert.ok(!r.packs.some(p=>p.entries.some(e=>e.id==='fixture_escape')));const read=await readCatalog(game,{source:'builtin',kind:'character',pack:'escape'});assert.equal(read.ok,false)})
} finally {
  const resolvedHome=testPaths.assertTestPath(home), relativeGame=relative(resolvedHome,game)
  assert.ok(relativeGame&&!isAbsolute(relativeGame)&&relativeGame!=='..'&&!relativeGame.startsWith('..\\')&&!relativeGame.startsWith('../'))
  await rm(resolvedHome,{recursive:true,force:true})
}
for(const failure of failures) console.error(JSON.stringify(failure))
console.log(JSON.stringify({suite:'catalog',passed:checks.length,failed:failures.length,skipped,checks}))
if(failures.length)process.exitCode=1
