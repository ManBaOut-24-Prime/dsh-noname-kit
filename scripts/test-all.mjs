#!/usr/bin/env node
/** 标准回归入口:自动发现 test-*.mjs,串行执行并传播失败退出码。 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('./', import.meta.url))
const suites = readdirSync(dir).filter((name) => /^test-.*\.mjs$/.test(name) && name !== 'test-all.mjs').sort()
let failed = 0
let assertions = 0
let counted = 0
for (const suite of suites) {
  console.log('\n[套件] ' + suite)
  const result = spawnSync(process.execPath, [dir + suite], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  // Counts are suite-reported checks, not inferred from the number of log lines.
  const count = /(?:全部通过:\s*|B0:\s*)(\d+)\s*项/.exec(result.stdout || '')
  if (count && result.status === 0) { assertions += Number(count[1]); counted++ }
  if (result.error || result.status !== 0) {
    failed++
    console.error(suite + ': ' + (result.error?.message || '退出 ' + result.status))
  }
}
console.log(`\n${suites.length} 个套件, ${failed} 个失败`)
console.log(`已统计 ${counted}/${suites.length} 套件: ${assertions} 项通过`)
if (failed) process.exitCode = 1
