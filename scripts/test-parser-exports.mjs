#!/usr/bin/env node
/** Authored fixtures for static exports, registration discovery and write boundaries. */
import assert from 'node:assert/strict'
import * as blocks from '../src/blocks.js'
import * as parser from '../src/module-parser.js'

const keys = (code, options) => blocks.scanBlocks(code, options).blocks.map(b => b.key).sort()
const model = (code, options = {}) => {
  assert.equal(typeof parser.sourceModel, 'function', 'the static source model is exported')
  return parser.sourceModel(code, options)
}
const wrap = (kind, id, body) => `//#noname-kit-begin ${kind}:${id}\n${body}\n//#noname-kit-end ${kind}:${id}`
function rejected(result, original) {
  assert.ok(result.errors.length > 0)
  assert.equal(result.code, original)
}
const CARD_PROPERTY = '  fixture_token: { power: 1 },'
const SHARED = `const cards$1 = {
${CARD_PROPERTY}
};
const descriptor = { card: cards$1, package: { card: { ...cards$1 } } };
export { descriptor as default };
`
let passed = 0
const failures = []
async function test(label, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + label) }
  catch (error) { failures.push({ label, message: error.message }); console.error('  ✗ ' + label + '\n    ' + error.message) }
}

await test('named default exports expose their actual descriptor tables', () => {
  const code = `const descriptor = {
  character: { fixture_hero: { skills: ["fixture_skill"] } },
  card: { fixture_token: {} },
};
const type = "card";
export { descriptor as default, type };
`
  assert.deepEqual(keys(code), ['card:fixture_token', 'character:fixture_hero'])
})
await test('a descriptor reference resolves a nonstandard table binding', () => {
  const code = 'const cards$1 = { fixture_token: {} };\nconst pack = { card: cards$1 };\nexport { pack as default };\n'
  assert.deepEqual(keys(code), ['card:fixture_token'])
})
await test('object spreads retain the referenced physical table entries', () => {
  const code = 'const cards$1 = { fixture_token: {} };\nexport default { card: { ...cards$1 } };\n'
  assert.deepEqual(keys(code), ['card:fixture_token'])
})
await test('an unrelated top-level variable is not a registered content table', () => {
  const code = 'const cards$1 = { fixture_false: {} };\nconst options = { skill: { fixture_other: {} } };\nexport default { name: "Fixture", package: {} };\n'
  assert.deepEqual(keys(code), [])
})
await test('local card and skill variables inside business callbacks remain private', () => {
  const code = `export default {
  card: { fixture_token: {
    content() {
      const card = { fixture_false_card: {} };
      const skill = { fixture_false_skill: {} };
      return { card, skill };
    },
  } },
};
`
  assert.deepEqual(keys(code), ['card:fixture_token'])
})
await test('a same-file alias chain resolves to a registered descriptor', () => {
  const code = 'const cards$1 = { fixture_token: {} };\nconst pack = { card: cards$1 };\nconst alias = pack;\nexport { alias as default };\n'
  assert.deepEqual(keys(code), ['card:fixture_token'])
})
await test('cyclic aliases cannot create a guessed content table', () => {
  const code = 'const first = second;\nconst second = first;\nexport { first as default };\n'
  assert.deepEqual(keys(code), [])
})
await test('a callback parameter cannot bind to a same-named outer table', () => {
  const code = 'const cards$1 = { fixture_outer: {} };\ngame.import("card", function (cards$1) { return { card: cards$1 }; });\n'
  assert.deepEqual(keys(code), [])
})
await test('multiple references to one physical property do not create duplicate IDs', () => {
  assert.deepEqual(keys(SHARED), ['card:fixture_token'])
  const result = blocks.migrateCode(SHARED)
  assert.equal(result.error, undefined)
  assert.equal(result.blocks, 1)
  assert.equal(blocks.stripAnchors(result.code), SHARED)
  const changed = CARD_PROPERTY.replace('power: 1', 'power: 9')
  const written = blocks.assembleBlocks(result.code, [{ kind: 'card', id: 'fixture_token', code: changed }])
  assert.deepEqual(written.errors, [])
  assert.equal(written.code, result.code.replace(CARD_PROPERTY, changed))
})
await test('distinct physical definitions of one ID do not grant write permission', () => {
  const code = `const first = {
${wrap('card', 'fixture_same', '  fixture_same: { power: 1 },')}
};
const second = {
  fixture_same: { power: 2 },
};
export default { card: first, package: { card: second } };
`
  assert.deepEqual(blocks.scanEffectiveAnchored(code), [])
  rejected(blocks.assembleBlocks(code, [{ kind: 'card', id: 'fixture_same', code: 'fixture_same: {},' }]), code)
  rejected(blocks.assembleBlocks(code, [], [], ['card:fixture_same']), code)
  assert.ok(blocks.migrateCode(code).error)
})
for (const [kind, file, code] of [
  ['character', 'character.js', 'export default { fixture_item: { skills: [] } };\n'],
  ['card', 'card.js', 'export default { fixture_item: { type: "basic" } };\n'],
  ['skill', 'skill.js', 'export default { fixture_item: { content() {} } };\n'],
  ['translate', 'translate.js', 'export default { fixture_item: "Item", fixture_item_info: "Description" };\n'],
]) {
  await test('anonymous ' + kind + ' data tables require their known filename context', () => {
    assert.deepEqual(keys(code), [])
    assert.deepEqual(keys(code, { file }), [kind + ':fixture_item'])
    assert.deepEqual(keys(code, { file: 'meta.js' }), [])
  })
}
await test('the parser cache keeps filename contexts separate for identical source', () => {
  const code = 'export default { fixture_label: "Label" };\n'
  assert.deepEqual(keys(code, { file: 'translate.js' }), ['translate:fixture_label'])
  assert.deepEqual(keys(code, { file: 'meta.js' }), [])
  assert.deepEqual(keys(code, { file: 'translate.js' }), ['translate:fixture_label'])
})
await test('descriptor metadata is never reinterpreted as anonymous content', () => {
  const code = 'export default { name: "Fixture", start() {}, package: {}, fixture_fake: {} };\n'
  assert.deepEqual(keys(code, { file: 'card.js' }), [])
  assert.deepEqual(keys(code, { file: 'skill.js' }), [])
})
await test('anonymous translation migration and edits preserve its surrounding bytes', () => {
  const code = 'const metadata = "preserve";\nexport default {\n  fixture_label: "Label",\n  fixture_label_info: "Description",\n};\n'
  const options = { file: 'translate.js' }
  const result = blocks.migrateCode(code, options)
  assert.equal(result.error, undefined)
  assert.equal(result.blocks, 1)
  assert.equal(blocks.stripAnchors(result.code, options), code)
  assert.match(blocks.extractBlock(result.code, 'translate', 'fixture_label', options), /Description/)
  const changed = '  fixture_label: "Changed",\n  fixture_label_info: "Description",'
  const written = blocks.assembleBlocks(result.code, [{ kind: 'translate', id: 'fixture_label', code: changed }], [], [], options)
  assert.deepEqual(written.errors, [])
  assert.equal(written.code, result.code.replace('fixture_label: "Label"', 'fixture_label: "Changed"'))
})
const LITERAL_MODE = `export default function () {
  return {
    name: "FixtureExtension",
    content() {
      game.addMode("fixture_mode", {
        name: "fixture_mode",
        character: { fixture_mode_hero: { skills: [] } },
        start() {},
      });
    },
  };
}
`
await test('a literal addMode descriptor in extension content is discovered statically', () => {
  const result = model(LITERAL_MODE, { file: 'extension.js' })
  assert.deepEqual(result.registrations.map(({ kind, id }) => ({ kind, id })), [{ kind: 'mode', id: 'fixture_mode' }])
  const registration = result.registrations[0]
  assert.equal(registration.descriptor.file, 'extension.js')
  assert.equal(registration.dynamic, false)
  assert.deepEqual(keys(LITERAL_MODE, { file: 'extension.js' }), ['character:fixture_mode_hero'])
})
await test('a top-level mode descriptor binding resolves inside extension content', () => {
  const code = `const modeDescriptor = { name: "fixture_mode", card: { fixture_mode_token: {} }, start() {} };
export default function () { return { name: "Fixture", content() { game.addMode("fixture_mode", modeDescriptor); } }; }
`
  const result = model(code, { file: 'extension.js' })
  assert.deepEqual(result.registrations.map(r => r.id), ['fixture_mode'])
  assert.equal(result.registrations[0].descriptor.open, code.indexOf('{'))
  assert.deepEqual(keys(code, { file: 'extension.js' }), ['card:fixture_mode_token'])
})
await test('skill business callbacks do not create discovered mode registrations', () => {
  const code = `const skills = { fixture_skill: { content() { game.addMode("fixture_false_mode", { card: { fixture_false: {} } }); } } };
export default skills;
`
  const result = model(code, { file: 'skill.js' })
  assert.deepEqual(result.registrations, [])
  assert.deepEqual(keys(code, { file: 'skill.js' }), ['skill:fixture_skill'])
})
await test('a content parameter cannot resolve a mode descriptor from an outer namesake', () => {
  const code = `const modeDescriptor = { card: { fixture_outer: {} } };
export default { name: "Fixture", content(modeDescriptor) { game.addMode("fixture_dynamic", modeDescriptor); } };
`
  const result = model(code, { file: 'extension.js' })
  assert.deepEqual(result.registrations.map(r => r.id), ['fixture_dynamic'])
  assert.equal(result.registrations[0].descriptor, null)
  assert.equal(result.registrations[0].dynamic, true)
  assert.deepEqual(keys(code, { file: 'extension.js' }), [])
})
await test('cross-file tables retain source ownership and are explicitly read-only references', () => {
  const entry = 'import cards from "./definitions.js";\nexport default { card: cards };\n'
  const definition = 'const cards$1 = {\n  fixture_remote: {},\n};\nexport { cards$1 as default };\n'
  const options = { file: 'extension.js', modules: new Map([['extension.js', entry], ['definitions.js', definition]]) }
  const result = model(entry, options)
  const table = result.tables.find(t => t.kind === 'card' && t.id === 'fixture_remote')
  assert.ok(table)
  assert.equal(table.file, 'definitions.js')
  assert.equal(table.readOnly, true)
  assert.equal(table.indirect, true)
  assert.deepEqual(keys(entry, options), [])
  rejected(blocks.assembleBlocks(entry, [{ kind: 'card', id: 'fixture_remote', code: 'fixture_remote: {},' }], [], [], options), entry)
})
await test('unresolved imports do not manufacture same-file offsets or write permissions', () => {
  const code = 'import cards from "./missing.js";\nexport default { card: cards };\n'
  const result = model(code, { file: 'extension.js', modules: {} })
  assert.deepEqual(result.tables, [])
  assert.ok(result.unresolved.length > 0)
  assert.deepEqual(keys(code, { file: 'extension.js' }), [])
})
await test('a verified native Character import is recognized while remaining read-only', () => {
  const property = '  fixture_constructed: new NativeCharacter({ sex: "male", group: "wei", hp: 4, skills: ["fixture_skill"] }),'
  const code = 'import { Character as NativeCharacter } from "../../../../noname/library/element/index.js";\nexport default {\n' + property + '\n};\n'
  const options = { file: 'mode/fixture/src/character/constructors.js' }
  const result = model(code, options)
  const entry = result.tables.find(t => t.id === 'fixture_constructed')
  assert.ok(entry)
  assert.equal(entry.kind, 'character')
  assert.equal(entry.readOnly, true)
  assert.deepEqual(entry.skillIds, ['fixture_skill'])
  assert.deepEqual(keys(code, options), ['character:fixture_constructed'])
  assert.ok(blocks.migrateCode(code, options).error)
  const anchored = code.replace(property, wrap('character', 'fixture_constructed', property))
  assert.deepEqual(blocks.scanEffectiveAnchored(anchored, options), [])
  rejected(blocks.assembleBlocks(anchored, [{ kind: 'character', id: 'fixture_constructed', code: 'fixture_constructed: {},' }], [], [], options), anchored)
})
await test('an arbitrary or shadowed constructor named Character is not native content evidence', () => {
  for (const code of [
    'import { Character } from "./vendor.js";\nexport default { fixture_false: new Character({ skills: [] }) };\n',
    'function Character(value) { return value; }\nexport default { fixture_false: new Character({ skills: [] }) };\n',
  ]) {
    const options = { file: 'character/constructors.js' }
    assert.deepEqual(model(code, options).tables, [])
    assert.deepEqual(keys(code, options), [])
  }
})
for (const [label, body] of [
  ['an uncalled helper', 'function neverCalled() { game.addMode("fixture_false_mode", { card: { fixture_false: {} } }); }'],
  ['a local namesake game object', 'const game = { addMode() {} }; game.addMode("fixture_false_mode", { card: { fixture_false: {} } });'],
  ['a returned nested function', 'return function helper() { game.addMode("fixture_false_mode", { card: { fixture_false: {} } }); };'],
]) {
  await test(label + ' cannot register editable mode content through a lifecycle ancestor', () => {
    const code = 'export default { name: "Fixture", content() { ' + body + ' } };\n'
    const options = { file: 'extension.js' }
    assert.deepEqual(model(code, options).registrations, [])
    assert.deepEqual(keys(code, options), [])
  })
}
const COMPILED_SKILLS = `const skillsA = {
  fixture_alpha: {},
};
const skillsB = {
  fixture_beta: {},
};
const namespaceA = Object.freeze(Object.defineProperty({ __proto__: null, default: skillsA }, Symbol.toStringTag, { value: "Module" }));
const namespaceB = Object.freeze(Object.defineProperty({ __proto__: null, default: skillsB }, Symbol.toStringTag, { value: "Module" }));
const modules = Object.assign({ "./alpha.js": namespaceA, "./beta.js": namespaceB });
const skills = Object.assign({}, ...Object.values(modules).map(module => module.default));
export default { name: "Fixture", skill: { ...skills } };
`
await test('a verified compiled namespace aggregation exposes every source skill read-only', () => {
  const options = { file: 'extension.js' }
  const result = model(COMPILED_SKILLS, options)
  assert.deepEqual(result.tables.filter(t => t.kind === 'skill').map(t => t.id).sort(), ['fixture_alpha', 'fixture_beta'])
  assert.ok(result.tables.every(t => t.readOnly && t.indirect))
  assert.deepEqual(keys(COMPILED_SKILLS, options), ['skill:fixture_alpha', 'skill:fixture_beta'])
  assert.ok(blocks.migrateCode(COMPILED_SKILLS, options).error)
})
await test('a mapper with side effects is not interpreted as a pure namespace projection', () => {
  const code = COMPILED_SKILLS.replace('module => module.default', 'module => { globalThis.__fixtureMapperExecuted = true; return module.default; }')
  const result = model(code, { file: 'extension.js' })
  assert.deepEqual(result.tables, [])
  assert.ok(result.unresolved.length > 0)
  assert.equal(Object.hasOwn(globalThis, '__fixtureMapperExecuted'), false)
})
await test('a shadowed Object intrinsic cannot authorize compiled-table inference', () => {
  const code = 'const Object = { assign() {}, values() {}, freeze() {}, defineProperty() {} };\n' + COMPILED_SKILLS
  const result = model(code, { file: 'extension.js' })
  assert.deepEqual(result.tables, [])
  assert.ok(result.unresolved.length > 0)
})
await test('reassigning an aggregation source does not preserve its stale static entries', () => {
  const code = COMPILED_SKILLS.replace('const modules =', 'let modules =').replace('const skills =', 'modules = {};\nconst skills =')
  const result = model(code, { file: 'extension.js' })
  assert.deepEqual(result.tables, [])
  assert.ok(result.unresolved.length > 0)
})
await test('reassigning a canonical table binding cannot expose its initial entries', () => {
  const code = 'let skills = { fixture_stale: {} };\nskills = unknownTable;\nexport default { skill: skills };\n'
  assert.deepEqual(keys(code), [])
  assert.deepEqual(model(code).tables, [])
})
const MODE_CALL = 'game.addMode("fixture_controlled", { card: { fixture_controlled_card: {} } });'
for (const [label, body] of [
  ['a false if branch', 'if (false) { ' + MODE_CALL + ' }'],
  ['an unselected conditional branch', 'false ? ' + MODE_CALL.slice(0, -1) + ' : null;'],
  ['short-circuited logical branches', 'false && ' + MODE_CALL.slice(0, -1) + '; true || ' + MODE_CALL.slice(0, -1) + ';'],
  ['loops with false conditions', 'while (false) { ' + MODE_CALL + ' } for (; false;) { ' + MODE_CALL + ' }'],
]) {
  await test(label + ' cannot register absent mode content', () => {
    const code = 'export default { name: "Fixture", content() { ' + body + ' } };\n'
    assert.deepEqual(model(code, { file: 'extension.js' }).registrations, [])
    assert.deepEqual(keys(code, { file: 'extension.js' }), [])
  })
}
await test('a statically true registration branch retains its real descriptor', () => {
  const code = 'export default { name: "Fixture", content() { if (true) { ' + MODE_CALL + ' } } };\n'
  const result = model(code, { file: 'extension.js' })
  assert.deepEqual(result.registrations.map(r => r.id), ['fixture_controlled'])
  assert.equal(result.registrations[0].dynamic, false)
  assert.deepEqual(keys(code, { file: 'extension.js' }), ['card:fixture_controlled_card'])
})
await test('an unknown registration condition is reported as conditional coverage', () => {
  const code = 'export default { name: "Fixture", content() { if (unknownFlag) { ' + MODE_CALL + ' } } };\n'
  const result = model(code, { file: 'extension.js' })
  assert.deepEqual(result.registrations.map(r => r.id), ['fixture_controlled'])
  assert.equal(result.registrations[0].dynamic, true)
  assert.ok(result.unresolved.some(x => x.kind === 'mode'))
})

console.log(JSON.stringify({ passed, failed: failures.length, total: passed + failures.length, failures }, null, 2))
if (failures.length) process.exitCode = 1
