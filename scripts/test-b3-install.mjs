#!/usr/bin/env node
/** Installation faults and real subprocess exit probes, confined to temporary fake game roots. */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { kernelStatus } from '../src/online.js'
import batchFiles from '../online-kernel/lib/batch-files.cjs'

const source = fileURLToPath(new URL('../online-kernel/', import.meta.url))
const code = fs.readFileSync(new URL('../src/kernel-install.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
function installer(fault = '', crash = '') {
  let copies = 0, thrown = false
  const fds = new Map()
  const fail = () => { thrown = true; throw Object.assign(new Error('injected ' + fault), { code: fault === 'copy' ? 'ENOSPC' : 'EPERM' }) }
  const io = { ...fs,
    copyFileSync: (...args) => { if (fault === 'copy' && ++copies === 2) fail(); return fs.copyFileSync(...args) },
    openSync: (name, ...args) => { if (!thrown && fault === 'config' && String(name).endsWith('nnk-bridge.json')) fail(); if (!thrown && fault === 'stamp' && String(name).endsWith('.nnk-kernel.json')) fail(); const fd = fs.openSync(name, ...args); fds.set(fd, name); return fd },
    renameSync: (from, to) => {
      if (!thrown && fault === 'backup' && String(to).includes('nnk-kernel-backups')) fail()
      if (!thrown && ['switch', 'rollback'].includes(fault) && String(from).endsWith(path.sep + 'new')) fail()
      if (fault === 'rollback' && String(from).includes('nnk-kernel-backups')) fail()
      fs.renameSync(from, to)
      if (crash === 'journal' && String(to).endsWith('active.json') || crash === 'old' && String(to).includes('nnk-kernel-backups') || crash === 'new' && String(from).endsWith(path.sep + 'new')) process.exit(77)
    },
    unlinkSync: name => { fs.unlinkSync(name); if (crash === 'complete' && String(name).endsWith('active.json')) process.exit(77) },
  }
  const context = { fs: io, batchFiles, createHash, randomUUID, ...path, process }
  runInNewContext(code.replace(/^import .*\n/gm, '').replace(/export /g, '') + '\nglobalThis.api = { installKernelFiles, kernelContentHash };', context)
  return context.api
}
const args = root => ({ root, source, version: '0.3.81', build: 'b2-local-1', baseUrl: 'http://127.0.0.1/test', token: 'fixture-only' })
if (process.argv[2] === '--crash') {
  installer('', process.argv[4]).installKernelFiles(args(process.argv[3]))
  process.exit(2)
}
let passed = 0, seq = 0
const home = fs.mkdtempSync(path.join(tmpdir(), 'nnk-b3-'))
function check(label, fn) { fn(); passed++; console.log('  ✓ ' + label) }
function fixture(old = true) {
  const root = path.join(home, String(++seq)), target = path.join(root, 'extension', '联机助手')
  fs.mkdirSync(path.join(root, 'extension'), { recursive: true })
  if (old) {
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'extension.js'), 'old complete kernel')
    fs.writeFileSync(path.join(target, 'nnk-bridge.json'), '{"token":"old-fixture"}')
    fs.writeFileSync(path.join(target, 'user-extra'), 'keep in backup')
  }
  fs.mkdirSync(path.join(root, 'extension', '其他扩展'))
  fs.writeFileSync(path.join(root, 'extension', '其他扩展', 'extension.js'), 'untouched')
  return { root, target }
}
function assertOld(k) {
  assert.equal(fs.readFileSync(path.join(k.target, 'extension.js'), 'utf8'), 'old complete kernel')
  assert.equal(fs.readFileSync(path.join(k.target, 'nnk-bridge.json'), 'utf8'), '{"token":"old-fixture"}')
  assert.equal(fs.readFileSync(path.join(k.target, 'user-extra'), 'utf8'), 'keep in backup')
  assert.equal(fs.readFileSync(path.join(k.root, 'extension', '其他扩展', 'extension.js'), 'utf8'), 'untouched')
}
try {
  for (const fault of ['copy', 'config', 'stamp', 'backup', 'switch']) check(fault + ' failure restores the complete old kernel and retry succeeds', () => {
    const k = fixture()
    const result = installer(fault).installKernelFiles(args(k.root))
    assert.equal(result.ok, false); assert.equal(result.recoveryRequired, undefined); assertOld(k)
    assert.equal(installer().installKernelFiles(args(k.root)).ok, true)
    assert.equal(kernelStatus({ nonameDir: k.root }).state, 'ok')
  })
  check('first installation copy failure leaves no partial extension and can retry', () => {
    const k = fixture(false)
    assert.equal(installer('copy').installKernelFiles(args(k.root)).ok, false)
    assert.ok(!fs.existsSync(k.target))
    assert.equal(installer().installKernelFiles(args(k.root)).ok, true)
  })
  check('rollback rename failure is explicit and the next attempt recovers before installing', () => {
    const k = fixture()
    const result = installer('rollback').installKernelFiles(args(k.root))
    assert.equal(result.ok, false); assert.equal(result.recoveryRequired, true)
    assert.equal(kernelStatus({ nonameDir: k.root }).recoveryPending, true)
    assert.equal(installer().installKernelFiles(args(k.root)).ok, true)
    assert.equal(kernelStatus({ nonameDir: k.root }).state, 'ok')
  })
  for (const phase of ['journal', 'old', 'new', 'complete']) for (const old of [true, false]) {
    if (phase === 'old' && !old) continue
    check('process exits after ' + phase + ' (old=' + old + '), later installation recovers', () => {
    const k = fixture(old)
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--crash', k.root, phase], { encoding: 'utf8' })
    assert.equal(result.status, 77, result.stderr)
    if (phase === 'journal' && old) assertOld(k)
    if (phase === 'new' || phase === 'complete') assert.equal(installer().kernelContentHash(k.target), installer().kernelContentHash(source))
    assert.equal(installer().installKernelFiles(args(k.root)).ok, true)
    assert.equal(kernelStatus({ nonameDir: k.root }).state, 'ok')
    assert.equal(fs.readFileSync(path.join(k.root, 'extension', '其他扩展', 'extension.js'), 'utf8'), 'untouched')
    })
  }
  check('old byte content including configuration and additional files remains in backup', () => {
    const k = fixture(), r = installer().installKernelFiles(args(k.root))
    assert.equal(r.ok, true)
    assert.equal(fs.readFileSync(path.join(r.backup, 'extension.js'), 'utf8'), 'old complete kernel')
    assert.equal(fs.readFileSync(path.join(r.backup, 'user-extra'), 'utf8'), 'keep in backup')
  })
  check('same-length modification with preserved mtime cannot hide behind a status cache', () => {
    const k = fixture(); assert.equal(installer().installKernelFiles(args(k.root)).ok, true)
    assert.equal(kernelStatus({ nonameDir: k.root }).state, 'ok')
    const file = path.join(k.target, 'src', 'rtc.js'), oldStat = fs.statSync(file), data = fs.readFileSync(file)
    data[0] = data[0] === 0 ? 1 : 0; fs.writeFileSync(file, data); fs.utimesSync(file, oldStat.atime, oldStat.mtime)
    assert.equal(kernelStatus({ nonameDir: k.root }).state, 'stale')
  })
  check('live installer lock prevents another attempt from modifying the kernel', () => {
    const k = fixture(), work = path.join(k.root, 'nnk-kernel-install')
    fs.mkdirSync(work); fs.writeFileSync(path.join(work, 'install.lock'), JSON.stringify({ pid: process.pid }))
    assert.equal(installer().installKernelFiles(args(k.root)).ok, false); assertOld(k)
  })
  check('malformed recovery records remain visible and do not modify the old kernel', () => {
    const k = fixture(), work = path.join(k.root, 'nnk-kernel-install')
    fs.mkdirSync(work); fs.writeFileSync(path.join(work, 'active.json'), '{broken')
    assert.equal(installer().installKernelFiles(args(k.root)).recoveryRequired, true); assertOld(k)
    assert.equal(kernelStatus({ nonameDir: k.root }).recoveryPending, true)
  })
} finally { fs.rmSync(home, { recursive: true, force: true }) }
console.log(`全部通过:${passed} 项`)
