/** Kernel installation stages outside extension/; a journal lets a later install recover interrupted directory switches. */
import * as fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve, relative, isAbsolute } from 'node:path'
import batchFiles from '../online-kernel/lib/batch-files.cjs'

const WORK = 'nnk-kernel-install'
const BACKUPS = 'nnk-kernel-backups'
const FOLDER = '联机助手'
const MANIFEST = '.nnk-kernel.json'
const BRIDGE = 'nnk-bridge.json'

function realDirectory(path) {
  if (fs.lstatSync(path).isSymbolicLink() || !fs.statSync(path).isDirectory()) throw new Error('目录含链接或不是目录: ' + path)
}
function copyTree(from, to) {
  realDirectory(from)
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name), dest = join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dest)
    else if (entry.isFile()) {
      fs.copyFileSync(src, dest)
      const fd = fs.openSync(dest, 'r+')
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    }
    else throw new Error('内核目录含链接或非常规文件: ' + entry.name)
  }
}
/** Exact bytes and relative names; only generated root configuration and stamp are excluded. */
export function kernelContentHash(dir) {
  if (!fs.existsSync(dir)) return null
  const files = []
  function walk(current, prefix) {
    realDirectory(current)
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!prefix && (entry.name === MANIFEST || entry.name === BRIDGE)) continue
      const rel = prefix ? prefix + '/' + entry.name : entry.name
      if (entry.isDirectory()) walk(join(current, entry.name), rel)
      else if (entry.isFile()) files.push(rel)
      else throw new Error('内核目录含链接或非常规文件: ' + rel)
    }
  }
  walk(dir, '')
  const hash = createHash('sha256')
  for (const rel of files.sort()) hash.update(rel).update('\0').update(fs.readFileSync(join(dir, rel))).update('\0')
  return hash.digest('hex')
}
function durableWrite(path, data) {
  const fd = fs.openSync(path, 'w')
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
function writeJournal(work, value) {
  durableWrite(join(work, 'active.tmp'), JSON.stringify(value))
  fs.renameSync(join(work, 'active.tmp'), join(work, 'active.json'))
}
function paths(root, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('安装恢复记录 ID 不合法')
  return { target: join(root, 'extension', FOLDER), work: join(root, WORK), attempt: join(root, WORK, id),
    stage: join(root, WORK, id, 'new'), backup: join(root, BACKUPS, FOLDER + '-' + id) }
}
function removeAttempt(root, attempt) {
  const rel = relative(resolve(root, WORK), resolve(attempt))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('暂存清理路径越界')
  if (fs.existsSync(attempt)) { realDirectory(attempt); fs.rmSync(attempt, { recursive: true }) }
}
/** Pending installs are never presented as a verified current installation. */
export function kernelInstallPending(root) { return fs.existsSync(join(root, WORK, 'active.json')) }
function installedMatches(target, hash) {
  try {
    const stamp = JSON.parse(fs.readFileSync(join(target, MANIFEST), 'utf8'))
    const bridge = JSON.parse(fs.readFileSync(join(target, BRIDGE), 'utf8'))
    return stamp.hash === hash && typeof bridge.baseUrl === 'string' && typeof bridge.token === 'string' && kernelContentHash(target) === hash
  } catch { return false }
}
function recover(root) {
  if (!kernelInstallPending(root)) return
  const record = JSON.parse(fs.readFileSync(join(root, WORK, 'active.json'), 'utf8'))
  if (record.version !== 1 || typeof record.hadOld !== 'boolean' || !/^[a-f0-9]{64}$/.test(record.hash)) throw new Error('安装恢复记录无法识别，保留原文件')
  const p = paths(root, record.id)
  if (fs.existsSync(p.backup)) {
    realDirectory(p.backup)
    if (!installedMatches(p.target, record.hash)) {
      if (fs.existsSync(p.target)) fs.renameSync(p.target, join(p.attempt, 'failed'))
      fs.renameSync(p.backup, p.target)
    }
  } else if (record.hadOld) {
    if (!fs.existsSync(p.target)) throw new Error('旧内核与备份均缺失，无法自动恢复')
    realDirectory(p.target)
  } else if (fs.existsSync(p.target) && !installedMatches(p.target, record.hash)) {
    fs.renameSync(p.target, join(p.attempt, 'failed'))
  }
  fs.unlinkSync(join(p.work, 'active.json'))
  // Failed copies remain outside extension/ for diagnosis.
  if (!fs.existsSync(join(p.attempt, 'failed'))) removeAttempt(root, p.attempt)
}
function acquireLock(work) {
  const lock = join(work, 'install.lock')
  if (fs.existsSync(lock)) {
    const previous = JSON.parse(fs.readFileSync(lock, 'utf8'))
    if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error('安装锁无法识别，保留文件')
    try { process.kill(previous.pid, 0); throw new Error('另一个安装进程仍在运行') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
    fs.unlinkSync(lock)
  }
  const fd = fs.openSync(lock, 'wx')
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  return () => fs.unlinkSync(lock)
}
/** Prepare, verify, then rename; ordinary failures restore the old directory, crashes recover on the next install. */
export function installKernelFiles({ root, source, version, build, baseUrl, token, intervalMs }) {
  let release, batchLease, backup = null, attempt
  try {
    if (fs.existsSync(join(root, 'nnk-batches', 'active'))) throw new Error('补传批次尚未恢复，请先执行离线恢复。')
    realDirectory(root)
    if (process.platform==='win32') batchLease=batchFiles.acquireWriteLease(root)
    if (fs.existsSync(join(root, 'nnk-batches', 'active'))) throw new Error('补传批次尚未恢复，请先执行离线恢复。')
    fs.mkdirSync(join(root, 'extension'), { recursive: true }); realDirectory(join(root, 'extension'))
    const work = join(root, WORK)
    fs.mkdirSync(work, { recursive: true }); realDirectory(work)
    fs.mkdirSync(join(root, BACKUPS), { recursive: true }); realDirectory(join(root, BACKUPS))
    release = acquireLock(work)
    recover(root)
    const p = paths(root, randomUUID())
    attempt = p.attempt
    const hash = kernelContentHash(source)
    if (!hash || !fs.existsSync(join(source, 'extension.js'))) throw new Error('自带内核缺少入口')
    copyTree(source, p.stage)
    if (kernelContentHash(p.stage) !== hash) throw new Error('暂存内核 SHA-256 不匹配')
    const installedAt = Date.now()
    durableWrite(join(p.stage, BRIDGE), JSON.stringify({ baseUrl, token, intervalMs: intervalMs || 700, installedAt }, null, 2))
    durableWrite(join(p.stage, MANIFEST), JSON.stringify({ hash, version, build, installedAt }, null, 2))
    if (!installedMatches(p.stage, hash)) throw new Error('暂存内核配置或盖章校验失败')
    const hadOld = fs.existsSync(p.target)
    if (hadOld) realDirectory(p.target)
    writeJournal(work, { version: 1, id: p.attempt.split(/[\\/]/).at(-1), hadOld, hash })
    if (hadOld) { fs.renameSync(p.target, p.backup); backup = p.backup }
    fs.renameSync(p.stage, p.target)
    if (!installedMatches(p.target, hash)) throw new Error('正式内核校验失败')
    fs.unlinkSync(join(work, 'active.json'))
    removeAttempt(root, p.attempt)
    // Keep three successful backups; never follow links during retention.
    try {
      const entries = fs.readdirSync(join(root, BACKUPS), { withFileTypes: true })
        .filter(e => e.isDirectory() && /^联机助手-(?:\d+|[a-f0-9-]{36})$/.test(e.name))
        .map(e => ({ path: join(root, BACKUPS, e.name), time: fs.statSync(join(root, BACKUPS, e.name)).mtimeMs }))
        .sort((a, b) => b.time - a.time)
      for (const entry of entries.slice(3)) { realDirectory(entry.path); fs.rmSync(entry.path, { recursive: true }) }
    } catch (error) { /* Backup retention failure does not invalidate a verified installation. */ }
    return { ok: true, target: p.target, backup, hash }
  } catch (error) {
    let recoveryError
    if (release) {
      try { recover(root) } catch (failure) { recoveryError = failure.message }
    }
    return { ok: false, error: '内核安装失败: ' + error.message, ...(error.code ? { code: error.code } : {}),
      ...(backup ? { backup } : {}), ...(attempt ? { staging: attempt } : {}),
      ...(recoveryError ? { recoveryRequired: true, recoveryError } : {}) }
  } finally {
    if (release) { try { release() } catch (error) { /* Preserve a failed lock for a later diagnostic/recovery attempt. */ } }
    if (batchLease) batchLease.release()
  }
}
