import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {inspectBytes, runCheck, readPolicy, guardFiles} from './privacy-check.mjs';
import testPaths from './fixtures/test-paths.cjs';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  PASS ' + name); };
const join = (...parts) => parts.join('');
const bytes = value => Buffer.from(value);
const hash = value => createHash('sha256').update(value).digest('hex');
// Synthetic phrases are assembled so this test never embeds a private record.
const records = [
  join('用户', '追问测试', '审计是否完成。', '上一', '轮只看了入口。', '本', '轮补查余项。'),
  join('用户', '回忆合成反馈后，查了测试条目与', '交接', '文档，', '记录的合成', '报障尚未复现。'),
  join('用户', '拍板，', '勿再', '实现；', '本轮', '曾做出合成方案，被', '用户否决。'),
  join('查阅', '交接', '文档后，仍未找到合成反馈的具体情形。'),
  join('本轮', '已实现的合成方案被', '用户否决，现已全部拆除，后续勿再', '实现。'),
  join('用户', '\n询问合成', '\n复审结果。前几', '轮未完成，', '\n本', '轮复核。'),
  join('用户', '追问合成审计是否完成。此前', '交接', '文档记为', '未细看。'),
  join('前几', '轮交接', '文档记录', '尚未审查。'),
];
const normal = [
  'fix: audit confirms transaction rollback retains the recovery entry',
  '修复：审计发现状态文件解析失败后可能被覆盖，改为原子写入。',
  '设计边界：服务不要求用户自备公网服务器；优先本地直连。',
  '用户反馈邀请码被折行后无法解析；允许前缀和空白并补充测试。',
  '移除 TURN 配置及界面，维持无需自备服务器的产品设计。',
  '技术审计覆盖路径归一化、鉴权、恢复规则，新增回归全部通过。',
  '文档交接说明由产品安装步骤组成，不包含会话记录。',
  '用户拒绝写入时保留恢复入口，不执行文件写入。',
  '配置界面使用交接文档作为示例名称；该字段仅存储产品标题。',
  '修复查看交接文档列表的记录计数错误。',
  '新增查阅交接文档功能，列表显示记录数并支持导出。',
  '用户反馈交接文档记录字段为空；修复查看列表时的默认值。',
];
for (const [i, value] of normal.entries()) test('technical explanation ' + i, () => assert.deepEqual(inspectBytes('commit:synthetic', bytes(value)), []));
for (const [i, value] of records.entries()) {
  for (const name of ['commit:synthetic', 'src/synthetic.js']) test('synthetic process ' + i + ' in ' + name, () => assert.ok(inspectBytes(name, bytes(value)).some(f => f.category === 'PRIVATE_AI_PROCESS')));
  test('exact document review does not waive process ' + i, () => {
    const data = bytes(value), policy = {reviewedText: {'README.md': [{sha256: hash(data), reason: 'Synthetic exact document'}]}};
    assert.ok(inspectBytes('README.md', data, policy).some(f => f.category === 'PRIVATE_AI_PROCESS'));
  });
}
test('separate paragraph form', () => assert.ok(inspectBytes('commit:synthetic', bytes(records[0].replace('。', '。\n\n'))).some(f => f.category === 'PRIVATE_AI_PROCESS')));
test('source reads are not a new exception', () => assert.ok(inspectBytes('src/example.js', bytes(records[1])).length));
for (const [label, content, category] of [
  ['private location', ['C:', 'Users', 'synthetic-person', 'notes'].join('/'), 'PRIVATE_LOCAL_PATH'],
  ['credential', join('gh', 'p_', 'Q7w4R8e1T9y2U6i3O5p0A7s4D8f1G9h2J6k3'), 'TOKEN_FORMAT'],
]) test('exact reviewed source cannot waive ' + label, () => {
  const data = bytes('// ' + content), name = 'scripts/privacy-check.mjs';
  const policy = {reviewedSource: {[name]: [{sha256: hash(data), reason: 'Synthetic exact rule source'}]}};
  assert.ok(inspectBytes(name, data, policy).some(f => f.category === category));
});

const fixture = fs.mkdtempSync(testPaths.tempPrefix('privacy-process-'));
const git = (args, input) => execFileSync('git', args, {cwd: fixture, input, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
const command = (file, args, input) => spawnSync(file, args, {cwd: fixture, input, encoding: 'utf8', windowsHide: true});
git(['init', '-q']);
git(['config', 'user.name', 'Privacy process fixture']);
git(['config', 'user.email', 'privacy-process@example.invalid']);
git(['config', 'core.autocrlf', 'false']);
for (const name of guardFiles) {
  const target = path.join(fixture, name);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.copyFileSync(new URL('../' + name, import.meta.url), target);
}
fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({name: 'dsh-noname-kit'}));
fs.writeFileSync(path.join(fixture, 'source.js'), 'export const release = 1;\n');
git(['add', '.']);
const install = args => command(process.execPath, ['scripts/install-privacy-hooks.mjs', ...args]);
const custom = path.join(fixture, '.git', 'hooks', 'commit-msg');
fs.writeFileSync(custom, '#!/bin/sh\nexit 0\n');
test('custom message hook is retained', () => { assert.notEqual(install(['--reviewed']).status, 0); assert.equal(fs.readFileSync(custom, 'utf8'), '#!/bin/sh\nexit 0\n'); });
fs.unlinkSync(custom);
test('reviewed installation adds message hook', () => { assert.equal(install(['--reviewed']).status, 0); assert.ok(fs.existsSync(custom)); });
const manifest = JSON.parse(fs.readFileSync(path.join(fixture, '.git', 'noname-kit-privacy', 'guard-manifest.json'), 'utf8'));
test('message hook and regression are protected controls', () => { assert.ok(manifest['.githooks/commit-msg']); assert.ok(manifest['scripts/test-privacy-process.mjs']); });
const messageFile = path.join(fixture, '.git', 'synthetic-message');
const hook = (name, file) => command('git', ['hook', 'run', name, ...(file ? ['--', file] : [])]);
const pending = value => { fs.writeFileSync(messageFile, value); return hook('commit-msg', messageFile); };
const output = result => result.stdout + result.stderr;
for (const [i, value] of normal.entries()) test('pending technical message ' + i, () => assert.equal(pending(value).status, 0));
test('clean index still passes pre-commit', () => assert.equal(hook('pre-commit').status, 0));
git(['commit', '-qm', normal[0]]);
const initial = git(['rev-parse', 'HEAD']).trim();
const tree = git(['rev-parse', 'HEAD^{tree}']).trim();
const zero = '0'.repeat(initial.length);
const push = oid => {
  const inputFile = path.join(fixture, '.git', 'synthetic-push-input');
  fs.writeFileSync(inputFile, `${oid} ${oid} refs/heads/main ${zero}\n`);
  return command('git', ['hook', 'run', '--to-stdin=' + inputFile, 'pre-push']);
};
test('clean proposed history passes', () => assert.equal(push(initial).status, 0));
for (const [i, value] of records.entries()) {
  test('pending process message rejected ' + i, () => { const result = pending(value); assert.notEqual(result.status, 0); assert.match(output(result), /PRIVATE_AI_PROCESS/); assert.equal(output(result).includes(value), false); });
  test('git commit invokes pending message protection ' + i, () => { fs.writeFileSync(messageFile, value); const result = command('git', ['commit', '--allow-empty', '-F', messageFile]); assert.notEqual(result.status, 0); assert.equal(git(['rev-parse', 'HEAD']).trim(), initial); });
  const bad = git(['commit-tree', tree, '-p', initial, '-m', value]).trim();
  test('proposed commit process rejected ' + i, () => { const result = push(bad); assert.notEqual(result.status, 0); assert.match(output(result), /PRIVATE_AI_PROCESS/); });
  git(['update-ref', 'refs/heads/synthetic-process', bad]);
  test('CI history scans same process rule ' + i, () => assert.ok(runCheck({repo: fixture, mode: 'history'}).findings.some(f => f.category === 'PRIVATE_AI_PROCESS')));
  git(['update-ref', '-d', 'refs/heads/synthetic-process']);
}
const snapshot = path.join(fixture, '.git', 'noname-kit-privacy', 'privacy-check.mjs');
test('message mode requires explicit bytes', () => assert.throws(() => runCheck({repo: fixture, mode: 'message'})));
test('missing message argument fails closed', () => assert.equal(command(process.execPath, [snapshot, '--commit-msg']).status, 2));
test('missing message file fails closed', () => assert.equal(command(process.execPath, [snapshot, '--commit-msg', messageFile + '.absent']).status, 2));
test('mixed scan modes fail closed', () => assert.equal(command(process.execPath, [snapshot, '--commit-msg', messageFile, '--history']).status, 2));
for (const name of ['.githooks/commit-msg', 'scripts/test-privacy-process.mjs']) {
  git(['rm', '--cached', name]);
  test('missing indexed control fails pending message ' + name, () => { const result = pending(normal[0]); assert.notEqual(result.status, 0); assert.match(output(result), /GUARD_UPDATE_REQUIRES_INSTALLATION/); });
  git(['restore', '--source=HEAD', '--staged', name]);
}
fs.writeFileSync(path.join(fixture, 'source.js'), '// ' + records[0] + '\n');
git(['add', 'source.js']);
fs.writeFileSync(path.join(fixture, 'source.js'), 'export const release = 1;\n');
test('pre-commit still scans staged contents', () => { const result = hook('pre-commit'); assert.notEqual(result.status, 0); assert.match(output(result), /PRIVATE_AI_PROCESS/); });
git(['add', 'source.js']);
const policy = readPolicy(path.join(fixture, 'scripts/privacy-policy.json'));
policy.reviewedText['README.md'].push({sha256: hash(bytes(records[0])), reason: 'Synthetic pending self-approval'});
fs.writeFileSync(path.join(fixture, 'scripts/privacy-policy.json'), JSON.stringify(policy));
git(['add', 'scripts/privacy-policy.json']);
test('pending policy cannot authorize its message', () => { const result = pending(records[0]); assert.notEqual(result.status, 0); assert.match(output(result), /GUARD_UPDATE_REQUIRES_INSTALLATION/); assert.match(output(result), /PRIVATE_AI_PROCESS/); });
fs.writeFileSync(path.join(fixture, 'scripts/privacy-check.mjs'), 'process.exit(0);\n');
git(['add', 'scripts/privacy-check.mjs']);
test('pending replacement cannot disable installed message scanner', () => { const result = pending(records[1]); assert.notEqual(result.status, 0); assert.match(output(result), /GUARD_UPDATE_REQUIRES_INSTALLATION/); assert.match(output(result), /PRIVATE_AI_PROCESS/); });
console.log('All passed: ' + passed + ' process and pending-message checks');
