#!/usr/bin/env node
/** B2 behavioral probes. Legacy transfer is unpaused only in this isolated VM copy. */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

const require = createRequire(import.meta.url)
const source = name => fs.readFileSync(new URL('../online-kernel/src/' + name + '.js', import.meta.url), 'utf8')
const quiet = { log() {}, warn() {}, error() {} }
const home = fs.mkdtempSync(path.join(tmpdir(), 'nnk-b2-'))
let passed = 0, failed = 0, seq = 0
async function test(label, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + label) }
  catch (error) { failed++; console.error('  ✗ ' + label + ': ' + error.message) }
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function receiver() {
  const root = path.join(home, String(++seq))
  const acks = [], events = []
  const lib = { message: { client: {}, server: {} } }
  const nnk = { state: {}, env: { lib, game: { send: (func, msg) => acks.push({ func, ...msg }) } }, modules: {
    config: { get: () => 300 }, compat: { gameRoot: () => root }, bridge: { emit: (type, data) => events.push({ type, data }) },
  } }
  const code = source('transfer')
  assert.equal((code.match(/var TRANSFER_PAUSED = true;/g) || []).length, 1)
  runInNewContext(code.replace('var TRANSFER_PAUSED = true;', 'var TRANSFER_PAUSED = false;'), {
    window: { __nnk__: nnk, require }, console: quiet, Buffer, Uint8Array, atob, btoa, setTimeout, clearTimeout,
  })
  nnk.modules.transfer.install()
  const handlers = lib.message.client
  const begin = files => handlers.nnk_tx_begin({ id: 1, name: '包', integrity: 'sha256-v1', total: files.reduce((n, f) => n + f.size, 0), files })
  const file = (rel, bytes, hash = digest(bytes)) => {
    handlers.nnk_tx_file({ id: 1, name: '包', rel, size: bytes.length, sha256: hash })
    handlers.nnk_tx_data({ id: 1, rel, b64: bytes.toString('base64') })
  }
  return { root, acks, events, handlers, begin, file, target: rel => path.join(root, 'extension', '包', rel), done: () => handlers.nnk_tx_done({ id: 1 }) }
}
const entry = (rel, bytes) => ({ rel, size: bytes.length, sha256: digest(bytes) })
try {
  await test('normal nonempty single file counts the final flush and ACKs done', () => {
    const k = receiver(), bytes = Buffer.from('new')
    k.begin([entry('extension.js', bytes)]); k.file('extension.js', bytes); k.done()
    assert.equal(k.acks.at(-1).type, 'done')
    assert.equal(fs.readFileSync(k.target('extension.js')).toString(), 'new')
    assert.equal(k.events.filter(e => e.type === 'transfer_done').length, 1)
  })
  await test('same-length different local content is replaced with verified bytes', () => {
    const k = receiver(), bytes = Buffer.from('new')
    fs.mkdirSync(path.dirname(k.target('extension.js')), { recursive: true })
    fs.writeFileSync(k.target('extension.js'), 'old')
    k.begin([entry('extension.js', bytes)]); k.file('extension.js', bytes); k.done()
    assert.equal(fs.readFileSync(k.target('extension.js')).toString(), 'new')
    assert.equal(k.acks.at(-1).type, 'done')
  })
  await test('same-length corrupted input fails SHA-256 and preserves old content', () => {
    const k = receiver(), expected = Buffer.from('new'), bad = Buffer.from('bad')
    fs.mkdirSync(path.dirname(k.target('extension.js')), { recursive: true })
    fs.writeFileSync(k.target('extension.js'), 'old')
    k.begin([entry('extension.js', expected)]); k.file('extension.js', bad, digest(expected)); k.done()
    assert.equal(k.acks.at(-1).type, 'fail')
    assert.equal(fs.readFileSync(k.target('extension.js')).toString(), 'old')
    assert.ok(k.events.some(e => /SHA-256/.test(e.data.message || '')))
    assert.ok(!k.events.some(e => e.type === 'transfer_done'))
    assert.ok(!fs.existsSync(k.target('extension.js') + '.nnk-part'))
  })
  await test('multiple files including empty final file count once across boundaries', () => {
    const k = receiver(), a = Buffer.from('a'), b = Buffer.alloc(0)
    k.begin([entry('extension.js', a), entry('empty.js', b)])
    k.file('extension.js', a); k.file('empty.js', b); k.done(); k.done()
    assert.equal(k.acks.filter(a => a.type === 'done').length, 1)
    assert.equal(fs.readFileSync(k.target('empty.js')).length, 0)
  })
  await test('old lists without integrity fields safely fail before creating files', () => {
    const k = receiver()
    k.handlers.nnk_tx_begin({ id: 1, name: '包', total: 3, files: [{ rel: 'extension.js', size: 3 }] })
    k.file('extension.js', Buffer.from('new')); k.done()
    assert.equal(k.acks.at(-1).type, 'fail')
    assert.ok(!fs.existsSync(k.target('extension.js')))
  })
  await test('repeated file cannot substitute for an omitted list entry', () => {
    const k = receiver(), a = Buffer.from('a')
    k.begin([entry('extension.js', a), entry('other.js', a)])
    k.file('extension.js', a); k.file('extension.js', a); k.done()
    assert.equal(k.acks.at(-1).type, 'fail')
    assert.ok(!k.events.some(e => e.type === 'transfer_done'))
  })
  await test('targeted sender ignores unrelated bridge backpressure and sends hashes', async () => {
    const root = path.join(home, 'sender')
    fs.mkdirSync(path.join(root, 'extension', '包'), { recursive: true })
    fs.writeFileSync(path.join(root, 'extension', '包', 'extension.js'), 'new')
    const events = [], frames = [], timers = []
    const lib = { message: { client: {}, server: {} } }
    const target = { bridgeId: 'wanted', _entered: true, channel: { bufferedAmount: 0 }, send: frame => {
      const [func, msg] = JSON.parse(frame); frames.push([func, msg])
      if (func === 'nnk_tx_begin' || func === 'nnk_tx_done') queueMicrotask(() => lib.message.server.nnk_tx_ack.call(target, { id: msg.id, type: func === 'nnk_tx_begin' ? 'ready' : 'done' }))
    } }
    const nnk = { state: { host: { bridges: [target, { bridgeId: 'other', _entered: true, channel: { bufferedAmount: 999999 } }] } }, env: { lib }, modules: {
      config: { get: () => 300 }, compat: { gameRoot: () => root }, bridge: { emit: (type, data) => events.push({ type, data }) },
    } }
    runInNewContext(source('transfer').replace('var TRANSFER_PAUSED = true;', 'var TRANSFER_PAUSED = false;'), {
      window: { __nnk__: nnk, require }, console: quiet, Buffer, Uint8Array, atob, btoa,
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearTimeout() {},
    })
    nnk.modules.transfer.install(); nnk.modules.transfer.start('包', 'wanted')
    for (let i = 0; i < 8; i++) await Promise.resolve()
    assert.ok(frames.some(([func]) => func === 'nnk_tx_data'))
    assert.equal(frames[0][1].files[0].sha256, digest(Buffer.from('new')))
    assert.ok(events.some(e => e.type === 'transfer_done'))
    assert.ok(!timers.some(t => t.ms === 40))
  })
  await test('RTC recovery clears the first outage even inside the JS liveness window', () => {
    let now = 1000, tick, dead = 0, state = 'disconnected'
    const nnk = { modules: {}, state: {} }
    runInNewContext(source('rtc'), { window: { __nnk__: nnk }, Date: { now: () => now }, setInterval: fn => { tick = fn; return 1 }, clearInterval() {}, console: quiet })
    const channel = { readyState: 'open', bufferedAmount: 0, send() {} }
    nnk.modules.rtc.startPing(channel, () => dead++, null, () => state)
    now = 23500; tick()
    now = 26000; state = 'connected'; tick(); channel.onmessage()
    now = 28500; state = 'disconnected'; tick()
    now = 48000; tick(); assert.equal(dead, 0)
    now = 51000; tick(); assert.equal(dead, 1)
  })
  await test('extension dump reports both content and UI with the shared classifier', () => {
    const events = []
    const root = path.join(home, 'compat')
    fs.mkdirSync(path.join(root, 'extension', '联机助手'), { recursive: true })
    fs.writeFileSync(path.join(root, 'extension', '联机助手', 'extension.js'), '')
    const lib = { config: { extensions: [] }, extensions: [['内容', null, null, null, { character: { character: { hero: [] } } }, false], ['美化', null, null, null, { character: { character: {} } }, false]] }
    const nnk = { state: {}, env: { lib, game: {}, _status: {} }, modules: { config: { get: () => false }, bridge: { emit: (type, data) => events.push({ type, data }) } } }
    runInNewContext(source('compat'), { window: { __nnk__: nnk, require }, process: { cwd: () => root, execPath: path.join(root, 'game.exe') }, console: quiet })
    nnk.modules.compat.dumpExtensions()
    assert.deepEqual(Array.from(events[0].data.skipped), ['内容(内容扩展被关)', '美化'])
  })
} finally { fs.rmSync(home, { recursive: true, force: true }) }
console.log(`全部通过:${passed} 项; 失败:${failed}`)
if (failed) process.exitCode = 1
