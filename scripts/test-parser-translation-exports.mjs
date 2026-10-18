#!/usr/bin/env node
/** Contextual translation inventories stay read-only and retain runtime coverage gaps. */
import assert from 'node:assert/strict'
import * as blocks from '../src/blocks.js'
import { sourceModel, sourceSections, sourceProperties } from '../src/module-parser.js'

let passed = 0
const failures = []
async function test(label, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + label) }
  catch (error) { failures.push({ label, message: error.message }); console.error('  ✗ ' + label + '\n    ' + error.message) }
}
const ids = (model, kind = 'translate') => model.tables.filter(t => t.kind === kind).map(t => t.id).sort()
const translations = `export const skillTranslation = {
  fixture_power: "技能",
  fixture_power_info: "说明",
};
`
const options = { file: 'source/skillTranslation.js' }
const inferred = (code, file = options.file) => sourceModel(code, { file })
function noWriteAuthority(code, file = options.file) {
  const context = { file }
  const model = inferred(code, file)
  assert.ok(model.tables.length > 0)
  assert.ok(model.tables.every(t => t.readOnly && t.indirect))
  for (const kind of ['translate', 'skill', 'card', 'character']) {
    for (const section of sourceSections(code, kind, context)) {
      const properties = sourceProperties(code, section.open, section.close, context)
      for (const table of model.tables.filter(t => t.kind === kind && t.file === file)) {
        const property = properties.find(p => p.start === table.start)
        if (property) assert.equal(property.readOnly, true)
      }
    }
  }
  assert.ok(blocks.migrateCode(code, context).error)
  assert.equal(blocks.checkFidelity(code, code.replace('技能', '新技能'), ['translate:fixture_power'], context).ok, false)
}

for (const [file, exported] of [
  ['characterTranslation.js', 'translation'],
  ['skillTranslation.js', 'skillTranslation'],
  ['cardTranslations.js', 'cardTranslations'],
  ['translations.js', 'translations'],
  ['SOURCE/CHARACTERTRANSLATION.JS', 'characterTranslation'],
]) {
  await test('named static translations use file context: ' + file, () => {
    const model = inferred('export const ' + exported + '={fixture_name:"名称",fixture_name_info:"说明"};', file)
    assert.deepEqual(ids(model), ['fixture_name', 'fixture_name_info'])
    assert.ok(model.tables.every(t => t.readOnly && t.indirect))
  })
}
await test('an export alias resolves its actual static translation binding', () => {
  const model = inferred('const labels={fixture_name:"名称"};export { labels as skillTranslation };')
  assert.deepEqual(ids(model), ['fixture_name'])
  assert.ok(model.tables.every(t => t.readOnly && t.indirect))
})
await test('a contextual default translation table is also read-only', () => {
  noWriteAuthority(translations.replace('export const skillTranslation =', 'export default'), options.file)
})
for (const [label, file, code] of [
  ['an unexported variable', 'characterTranslation.js', 'const translation={fixture_false:"假"};export const note="metadata";'],
  ['an unrelated named export', 'skillTranslation.js', 'export const config={fixture_false:"假"};'],
  ['a variable in another file', 'settings.js', 'export const translation={fixture_false:"假"};'],
  ['a lookalike filename suffix', 'characterTranslation.js.bak', 'export const translation={fixture_false:"假"};'],
  ['a translation directory name', 'skillTranslation.js/data.js', 'export const translation={fixture_false:"假"};'],
  ['strings and comments', 'skillTranslation.js', 'export const text="export const skillTranslation={fixture_false:1}";/* export const translation={fixture_ghost:1}; */'],
]) {
  await test(label + ' cannot become a contextual translation root', () => assert.deepEqual(ids(inferred(code, file)), []))
}
for (const [label, code] of [
  ['a reassigned export', 'export let skillTranslation={fixture_stale:"旧"};skillTranslation={fixture_next:"新"};'],
  ['a reassigned alias source', 'let source={fixture_stale:"旧"};export const skillTranslation=source;source={fixture_next:"新"};'],
  ['an unresolved cyclic alias', 'const first=second;const second=first;export { first as skillTranslation };'],
  ['an external reexport', 'export { labels as skillTranslation } from "external-module";'],
]) {
  await test(label + ' has a gap instead of stale translation entries', () => {
    const model = inferred(code)
    assert.deepEqual(ids(model), [])
    assert.ok(model.unresolved.some(gap => gap.kind === 'translate'))
  })
}
await test('a parameter shadow does not poison the actual exported translation table', () => {
  const code = 'export const skillTranslation={fixture_name:"名称"};function unused(skillTranslation){skillTranslation={fixture_false:"假"};}'
  assert.deepEqual(ids(inferred(code)), ['fixture_name'])
})
await test('unsafe translation IDs remain excluded', () => {
  const model = inferred('export const skillTranslation={"__proto__":"x",constructor:"x",prototype:"x",fixture_name:"名称"};')
  assert.deepEqual(ids(model), ['fixture_name'])
})
await test('a translation factory is not invoked or inferred as a table', () => {
  const code = 'export const skillTranslation=()=>{globalThis.__translationFixtureExecuted=true;return {fixture_false:"假"}};'
  const model = inferred(code)
  assert.deepEqual(ids(model), [])
  assert.ok(model.unresolved.length > 0)
  assert.equal(Object.hasOwn(globalThis, '__translationFixtureExecuted'), false)
})
await test('new contextual named tables cannot gain migration or editScope authority', () => noWriteAuthority(translations))
await test('raw anchors around a contextual table do not make the table writable', () => {
  const code = translations.replace('  fixture_power:', '  //#noname-kit-begin translate:fixture_power\n  fixture_power:')
    .replace('\n};', '\n  //#noname-kit-end translate:fixture_power\n};')
  assert.deepEqual(blocks.scanEffectiveAnchored(code, options), [])
  const result = blocks.assembleBlocks(code, [{ kind: 'translate', id: 'fixture_power', code: 'fixture_power:"新技能",fixture_power_info:"说明",' }], [], [], options)
  assert.ok(result.errors.length > 0)
  assert.equal(result.code, code)
})
await test('nested contextual translation wrappers retain read-only authority', () => {
  const code = 'export const skillTranslation = {\n  fixture_label: "标签",\n  translate: {\n    fixture_power: "技能",\n  },\n};\n'
  noWriteAuthority(code)
})
await test('other kinds inside a contextual wrapper cannot acquire inferred write authority', () => {
  const code = 'export const skillTranslation = {\n  fixture_label: "标签",\n  translate: { fixture_power: "技能" },\n  skill: { fixture_nested: {} },\n};\n'
  noWriteAuthority(code)
  assert.deepEqual(inferred(code).tables.filter(t => t.kind !== 'translate'), [])
  assert.ok(inferred(code).unresolved.some(g => g.reason === 'Non-translation field in a derived translation table'))
})
await test('unsupported object-only translation wrappers cannot become writable tables', () => {
  const code = 'export const skillTranslation={translate:{fixture_power:"技能"},skill:{fixture_nested:{}}};'
  assert.ok(inferred(code).tables.every(t => t.readOnly && t.indirect))
  assert.deepEqual(blocks.scanEffectiveAnchored(code, options), [])
})
await test('existing canonical translation tables retain their original migration behavior', () => {
  const code = 'export const translate = {\n  fixture_power: "技能",\n  fixture_power_info: "说明",\n};\n'
  const context = { file: 'translate.js' }
  assert.ok(sourceModel(code, context).tables.every(t => !t.readOnly && !t.indirect))
  assert.equal(blocks.migrateCode(code, context).error, undefined)
})
await test('a contextual alias of an existing canonical table does not revoke its original permission', () => {
  const code = 'const translate = {\n  fixture_power: "技能",\n  fixture_power_info: "说明",\n};\nexport { translate as translation };\n'
  const context = { file: 'translate.js' }
  assert.ok(sourceModel(code, context).tables.every(t => !t.readOnly && !t.indirect))
  assert.equal(blocks.migrateCode(code, context).error, undefined)
})
await test('a contextual default alias preserves an existing canonical table permission', () => {
  const code = 'const translate = {\n  fixture_power: "技能",\n  fixture_power_info: "说明",\n};\nexport default translate;\n'
  assert.ok(inferred(code).tables.every(t => !t.readOnly && !t.indirect))
  assert.equal(blocks.migrateCode(code, options).error, undefined)
})
await test('an invalid translation alias does not revoke an existing skill table permission', () => {
  const code = 'const skills = {\n  fixture_existing: {},\n};\nexport { skills as skillTranslation };\n'
  const model = inferred(code)
  assert.deepEqual(ids(model, 'skill'), ['fixture_existing'])
  assert.deepEqual(ids(model), [])
  assert.ok(model.tables.every(t => !t.readOnly && !t.indirect))
  assert.equal(blocks.migrateCode(code, options).error, undefined)
})

for (const [label, packageCode] of [
  ['an awaited resolver call', 'await helper.resolve(factory)'],
  ['an arbitrary factory call', 'makePackage()'],
  ['an unbound package value', 'unknownPackage'],
  ['an unresolved package spread', '{ ...makePackage() }'],
  ['a package factory without a return', 'function () { unknownOperation(); }'],
]) {
  await test(label + ' leaves a package coverage gap while static leaves remain readable', () => {
    const code = 'export default async function () { return { name:"Fixture", package:' + packageCode + ' }; }'
    const model = sourceModel(code, { file: 'extension.js', allModules: true, modules: { 'skill.js': 'export const skills={fixture_available:{}};' } })
    assert.deepEqual(ids(model, 'skill'), ['fixture_available'])
    assert.ok(model.unresolved.some(gap => /package/i.test(gap.reason)))
    assert.deepEqual(model.registrations, [])
  })
}
await test('a known static package retains its existing descriptor recognition', () => {
  const code = 'export default {name:"Fixture",package:{skill:{skill:{fixture_actual:{}}}}};'
  const model = sourceModel(code, { file: 'extension.js' })
  assert.deepEqual(ids(model, 'skill'), ['fixture_actual'])
  assert.equal(model.unresolved.some(gap => /package/i.test(gap.reason)), false)
})

await test('a required package still diagnoses an object already visited through a descriptor spread', () => {
  const code = 'const packageData={...makePackage()}; export default {...packageData,package:packageData};'
  assert.ok(sourceModel(code, {file:'extension.js'}).unresolved.some(g => /Package descriptor requires runtime evaluation/.test(g.reason)))
})

console.log(JSON.stringify({ passed, failed: failures.length, total: passed + failures.length, failures }, null, 2))
if (failures.length) process.exitCode = 1
