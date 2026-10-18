#!/usr/bin/env node
/** Unicode entry IDs retain their source spelling across bounded reads and writes. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import testPaths from './fixtures/test-paths.cjs'
import { ENTRY_ID_SOURCE, isEntryId } from '../src/entry-id.js'
import * as blocks from '../src/blocks.js'
import { collectDefinedIds, syntaxCheck } from '../src/validate.js'
import { listEntries, listEntrySkills, readExtension, migrateAnchors, writeExtension, safeEntryFilePath } from '../src/write.js'

let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name) }
  catch (error) { failures.push({ name, message: error.message }); console.error('  ✗ ' + name + ': ' + error.message) }
}
const source = `const skills = {
  "技能甲": { power: 1 },
  "éclat": { power: 2 },
  "e\u0301clat": { power: 3 },
};
export default skills;
`
const character = `export default {
  "武将甲": { sex: "male", group: "wei", hp: 4, skills: ["技能甲", "éclat"] },
  "武将乙": { sex: "female", group: "wu", hp: 3, skills: [] },
};
`
const translate = `export default {
  "武将甲": "甲将",
  "武将乙": "乙将",
  "技能甲": "甲技",
  "技能甲_info": "摸一张牌。",
  "éclat": "光辉",
  "éclat_info": "保留一张牌。",
};
`
const characterOptions = { file: 'modules/character.js' }
const skillOptions = { file: 'modules/skill.js' }
const home = testPaths.assertTestPath(await mkdtemp(testPaths.tempPrefix('entry-ids-')))
const game = testPaths.assertTestPath(join(home, 'game'))
const folder = 'EntryFixture'
const packageDir = join(game, 'extension', folder)
try {
  for (const id of ['cs_a', '技能甲', '𠮷野', 'éclat', 'e\u0301clat', '$skill', '技能-$1', '123', '_']) {
    await test('accept content ID ' + id, () => assert.equal(isEntryId(id), true))
  }
  for (const id of ['', '../x', 'a/b', 'a\\b', 'a:b', 'a b', 'a\nb', '\u200d', '💡', '__proto__', 'constructor', 'prototype']) {
    await test('reject unsafe content ID ' + JSON.stringify(id), () => assert.equal(isEntryId(id), false))
  }
  await test('exported pattern accepts Unicode only with the specified Unicode flag', () => {
    assert.equal(new RegExp('^(?:' + ENTRY_ID_SOURCE + ')$', 'u').test('技能-é'), true)
  })
  await test('canonically equivalent spellings remain distinct stored IDs', () => {
    assert.deepEqual(blocks.virtualSkillBlocks(source, skillOptions).map(b => b.id), ['技能甲', 'éclat', 'e\u0301clat'])
  })
  await test('anonymous default table needs its known file context', () => {
    assert.equal(blocks.scanBlocks(character).blocks.length, 0)
    assert.deepEqual(blocks.scanBlocks(character, characterOptions).blocks.map(b => b.id), ['武将甲', '武将乙'])
  })
  const migrated = blocks.migrateCode(character, characterOptions)
  await test('Unicode anonymous table can build a bounded index', () => {
    assert.equal(migrated.error, undefined)
    assert.equal(migrated.blocks, 2)
    assert.equal(blocks.scanEffectiveAnchored(migrated.code, characterOptions).length, 2)
    assert.equal(blocks.stripAnchors(migrated.code, characterOptions), character)
  })
  await test('Unicode anchored entry reads by the same ID', () => {
    assert.match(blocks.extractBlock(migrated.code, 'character', '武将甲', characterOptions), /skills/)
  })
  await test('Unicode block replacement retains the other entry exactly', () => {
    const originalOther = blocks.extractBlock(migrated.code, 'character', '武将乙', characterOptions)
    const result = blocks.assembleBlocks(migrated.code, [{ kind: 'character', id: '武将甲', code: '"武将甲": { sex: "male", hp: 5, skills: ["技能甲"] }' }], [], [], characterOptions)
    assert.deepEqual(result.errors, [])
    assert.equal(blocks.extractBlock(result.code, 'character', '武将乙', characterOptions), originalOther)
  })
  await test('Unicode scoped full replacement protects adjacent entries', () => {
    assert.equal(blocks.checkFidelity(source, source.replace('power: 1', 'power: 9'), ['skill:技能甲'], skillOptions).ok, true)
    assert.equal(blocks.checkFidelity(source, source.replace('power: 2', 'power: 9'), ['skill:技能甲'], skillOptions).ok, false)
  })
  await test('invalid scope keys never authorize changes', () => {
    for (const scope of ['skill:../x', 'skill:constructor', 'skill:技能 甲', 'skill:技能甲:extra']) {
      assert.equal(blocks.checkFidelity(source, source, [scope], skillOptions).ok, false)
    }
  })
  await test('unsafe block IDs are rejected without producing changed code', () => {
    for (const id of ['__proto__', 'constructor', 'a/b', 'a:b']) {
      const result = blocks.assembleBlocks(migrated.code, [{ kind: 'character', id, code: '"武将甲": {}' }], [], [], characterOptions)
      assert.ok(result.errors.length)
      assert.equal(result.code, migrated.code)
    }
  })
  await test('Unicode definition collection retains all distinct IDs', () => {
    assert.deepEqual(new Set(collectDefinedIds(source, skillOptions)), new Set(['技能甲', 'éclat', 'e\u0301clat']))
  })
  await test('runtime dot and quoted assignment definitions use static Unicode keys', () => {
    const code = 'pack.skill.技能甲 = {}; lib.character["拼音-é"] = {}; pack.card.$card = {};'
    assert.deepEqual(new Set(collectDefinedIds(code)), new Set(['技能甲', '拼音-é', '$card']))
  })
  await test('strings and comments cannot create phantom assignment IDs', () => {
    assert.deepEqual(collectDefinedIds('const example = "pack.skill.幻影 = {}"; // lib.card.幽灵 = {}\n'), [])
  })
  await test('module syntax accepts Unicode bindings, reexports and top-level await without execution', () => {
    for (const code of ['import 武将 from "./character.js";\nexport { 武将 as default };', 'export { default as 武将 } from "./character.js";', 'await Promise.resolve();\nexport default {};']) {
      assert.equal(syntaxCheck(code, 'module').ok, true)
    }
    assert.equal(syntaxCheck('export default {', 'module').ok, false)
  })
  await mkdir(join(packageDir, 'modules'), { recursive: true })
  await writeFile(join(packageDir, 'extension.js'), 'export default { name: "EntryFixture" };\n')
  await writeFile(join(packageDir, 'modules', 'character.js'), character)
  await writeFile(join(packageDir, 'modules', 'skill.js'), source)
  await writeFile(join(packageDir, 'modules', 'translate.js'), translate)
  await test('package listing preserves Unicode IDs, file ownership and names', async () => {
    const result = await listEntries(game, folder, 'character')
    assert.equal(result.ok, true)
    assert.equal(result.entries.length, 2)
    assert.equal(result.entries.find(x => x.id === '武将甲').name, '甲将')
    assert.equal(result.entries.find(x => x.id === '武将甲').file, 'modules/character.js')
  })
  await test('entry skills preserve Unicode IDs and resolve translated names', async () => {
    assert.deepEqual((await listEntrySkills(game, folder, '武将甲')).skills, [{ id: '技能甲', name: '甲技' }, { id: 'éclat', name: '光辉' }])
  })
  await test('quoted skills and escaped literals are decoded without reading example strings', async () => {
    const escaped = character.replace('skills: ["技能甲", "éclat"]', 'example: \'skills: ["fake_skill"]\', "skills": ["\\u6280\\u80fd\\u7532", "éclat"]')
    assert.notEqual(escaped, character)
    try {
      await writeFile(join(packageDir, 'modules', 'character.js'), escaped)
      assert.deepEqual((await listEntrySkills(game, folder, '武将甲')).skills, [{ id: '技能甲', name: '甲技' }, { id: 'éclat', name: '光辉' }])
    } finally { await writeFile(join(packageDir, 'modules', 'character.js'), character) }
  })
  await test('block reads route Unicode keys to the actual anonymous module', async () => {
    const result = await readExtension(game, folder, { block: 'character:武将甲' })
    assert.equal(result.block.file, 'modules/character.js')
    assert.match(result.code, /武将甲/)
    assert.ok((await readExtension(game, folder, { block: 'character:../x' })).error)
  })
  await test('relative aliases resolve to the canonical file context', async () => {
    assert.equal(safeEntryFilePath(game, folder, '././extension.js').rel, 'extension.js')
    const result = await readExtension(game, folder, { file: '././modules/character.js', block: 'character:武将甲' })
    assert.equal(result.file, 'modules/character.js')
    assert.equal(result.block.file, 'modules/character.js')
  })
  await test('entry file aliases cannot downgrade semantic validation', async () => {
    const result = await writeExtension(game, { folder: 'AliasFixture', file: './extension.js', code: 'export default {};' })
    assert.equal(result.wrote, false)
    assert.match(result.errors[0].message, /name/)
    await assert.rejects(readFile(join(game, 'extension', 'AliasFixture', 'extension.js')), { code: 'ENOENT' })
  })
  if (process.platform === 'win32') {
    await test('Windows case aliases of the entry file retain semantic validation', async () => {
      const result = await writeExtension(game, { folder: 'CaseAliasFixture', file: 'EXTENSION.JS', code: 'export default {};' })
      assert.equal(result.wrote, false)
      assert.match(result.errors[0].message, /name/)
      await assert.rejects(readFile(join(game, 'extension', 'CaseAliasFixture', 'extension.js')), { code: 'ENOENT' })
    })
  }
  await test('package block directory passes each module context', async () => {
    const result = await readExtension(game, folder, { listBlocks: true })
    assert.ok(result.blocks.blocks.some(b => b.key === 'character:武将甲' && b.file === 'modules/character.js'))
    assert.ok(result.blocks.blocks.some(b => b.key === 'translate:技能甲' && b.file === 'modules/translate.js'))
  })
  await test('isolated module migration and Unicode write retain other source bytes', async () => {
    const result = await migrateAnchors(game, folder, 'modules/character.js')
    assert.equal(result.ok, true)
    const old = await readFile(join(packageDir, 'modules', 'character.js'), 'utf8')
    const originalOther = blocks.extractBlock(old, 'character', '武将乙', characterOptions)
    const written = await writeExtension(game, { folder, file: 'modules/character.js', blocks: [{ kind: 'character', id: '武将甲', code: '"武将甲": { sex: "male", hp: 5, skills: ["技能甲"] }' }] })
    assert.equal(written.wrote, true)
    const updated = await readFile(join(packageDir, 'modules', 'character.js'), 'utf8')
    assert.equal(blocks.extractBlock(updated, 'character', '武将乙', characterOptions), originalOther)
    assert.equal(await readFile(join(packageDir, 'modules', 'translate.js'), 'utf8'), translate)
  })
  await test('unannounced Unicode definition deletion is refused before overwrite', async () => {
    const old = await readFile(join(packageDir, 'modules', 'skill.js'), 'utf8')
    const result = await writeExtension(game, { folder, file: 'modules/skill.js', edits: [{ find: '  "技能甲": { power: 1 },\n', replace: '' }] })
    assert.equal(result.wrote, false)
    assert.match(result.errors[0].message, /消失/)
    assert.equal(await readFile(join(packageDir, 'modules', 'skill.js'), 'utf8'), old)
  })
  await test('verified constructor entries are readable without acquiring inferred write scope', () => {
    const code = 'import { lib } from "noname";\nconst Character = lib.element.Character;\nexport default {\n  "武将构造": new Character({ sex: "male", hp: 4, skills: [] }),\n};\n'
    assert.ok(blocks.virtualCharacterBlocks(code, characterOptions).some(b => b.id === '武将构造'))
    assert.ok(blocks.migrateCode(code, characterOptions).error)
    assert.equal(blocks.checkFidelity(code, code.replace('hp: 4', 'hp: 5'), ['character:武将构造'], characterOptions).ok, false)
    const result = blocks.assembleBlocks(code, [{ kind: 'character', id: '武将构造', code: '"武将构造": {}' }], [], [], characterOptions)
    assert.ok(result.errors.length)
    assert.equal(result.code, code)
  })
  await test('an arbitrary constructor cannot masquerade as a character definition', () => {
    const code = 'class Character {}\nexport default {\n  "伪武将": new Character({ sex: "male", hp: 4, skills: [] }),\n};\n'
    assert.deepEqual(blocks.virtualCharacterBlocks(code, characterOptions), [])
  })
  await test('declared Unicode block deletion retains other distinct definitions', async () => {
    assert.equal((await migrateAnchors(game, folder, 'modules/skill.js')).ok, true)
    const result = await writeExtension(game, { folder, file: 'modules/skill.js', deletes: ['skill:技能甲'] })
    assert.equal(result.wrote, true)
    const updated = await readFile(join(packageDir, 'modules', 'skill.js'), 'utf8')
    assert.deepEqual(new Set(collectDefinedIds(updated, skillOptions)), new Set(['éclat', 'e\u0301clat']))
  })
} finally { await rm(testPaths.assertTestPath(home), { recursive: true, force: true }) }
console.log(JSON.stringify({ passed, failed: failures.length, failures }, null, 2))
if (failures.length) process.exitCode = 1
