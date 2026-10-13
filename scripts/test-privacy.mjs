import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes, createHash} from 'node:crypto';
import {spawnSync, execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectBytes, runCheck, parsePushInput, readPolicy, guardFiles} from './privacy-check.mjs';
import testPaths from './fixtures/test-paths.cjs';
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  PASS ' + name); }
const bytes = text => Buffer.from(text), hash = data => createHash('sha256').update(data).digest('hex');
const approved = (file, data) => ({reviewedText: {[file]: [{sha256: hash(data), reason: 'Synthetic public documentation fixture'}]}});
const has = (file, data, category, policy = {}) => inspectBytes(file, bytes(data), policy).some(f => f.category === category);
const join = (...parts) => parts.join('');
for (const [name, source] of [
  ['protocol role fields', 'const message = {role: "assistant", content: output};'],
  ['interface user fields', 'interface Payload {\nuser: UserInfo;\nassistant: AssistantInfo;\n}'],
  ['technical comments', '// B0 safety gate: require authorization before file writes.'],
  ['credential label construction', "bytes('API_KEY=' + randomBytes(24).toString('hex'))"],
  ['generic game fixture', "const dir = 'D:/Games/noname';"],
]) test(name, () => assert.deepEqual(inspectBytes('src/example.ts', bytes(source)), []));
const formal = bytes('B0 safety: a failed batch retains its recovery entry.\n');
test('unknown formal document requires review', () => assert.ok(has('docs/safety.md', formal, 'DOCUMENT_REVIEW_REQUIRED')));
test('reviewed formal document passes', () => assert.deepEqual(inspectBytes('docs/safety.md', formal, approved('docs/safety.md', formal)), []));
test('approved document content is exact', () => assert.ok(inspectBytes('docs/safety.md', Buffer.concat([formal, bytes('x')]), approved('docs/safety.md', formal)).length));
test('approval does not authorize another path', () => assert.ok(inspectBytes('notes.md', formal, approved('docs/safety.md', formal)).length));
const home = ['C:', 'Users', 'private-person', '.workspace'].join('/');
test('literal user path is blocked', () => assert.ok(has('src/config.js', home, 'PRIVATE_LOCAL_PATH')));
test('escaped user path is blocked', () => assert.ok(has('config.json', JSON.stringify({dir: home.replaceAll('/', '\\')}), 'PRIVATE_LOCAL_PATH')));
test('placeholder user path is allowed', () => assert.deepEqual(inspectBytes('src/example.js', bytes(['C:', 'Users', '<your-user>', '.dsh'].join('/'))), []));
test('private attachment path is blocked', () => assert.ok(has('record.csv', ['.co' + 'dex', 'attach' + 'ments', 'record'].join('/'), 'PRIVATE_LOCAL_PATH')));
for (const filename of [
  join('HAND', 'OFF.md'), join('AI-', 'CHAT.md'), join('CHAT-', 'TRANSCRIPT.json'),
  join('ai-', 'records/record.json'), join('B0-', 'ACCEPTANCE.md'), join('B0-', 'SAFETY.md'),
  join('B4-', 'REVIEW-FIX.md'), join('B6-B8-', 'REVIEW-HANDOFF.md'),
  join('DEV-', 'STATUS.md'), join('IMPLEMENTATION-', 'PLAN.md'), join('PROJECT-', 'DECISIONS.md'),
  '.env.local', 'nnk-bridge.json', 'nested/noname-kit.tasks.json',
]) test('private path category: ' + filename, () => assert.ok(has(filename, 'synthetic fixture', 'PRIVATE_FILE')));
test('credential template is allowed', () => assert.deepEqual(inspectBytes('.env.example', bytes('API_KEY=your_key')), []));
const processes = [
  ['English process', ['Internal', 'AI', 'handoff', 'to', 'Codex: continue.'].join(' ')],
  ['English split lines', ['AI', 'handoff: synthetic'].join('\n')],
  ['Chinese split lines', join('Astra\n', '下一', '会话', '交接：合成样本。')],
  ['unnamed process', join('内部 ', 'AI ', '交接：合成样本。')],
  ['unnamed audit', join('阶段', '审计流水账\n', '本轮', '工具调用已完成。')],
  ['lowercase model', join('codex ', '下一', '会话', '交接：合成样本。')],
  ['unknown model handover', join('留给下一位 ', 'AI ', '继续。')],
];
for (const [name, value] of processes) test(name, () => {
  assert.ok(has('notes.md', value, 'PRIVATE_AI_PROCESS', approved('notes.md', bytes(value))));
  assert.ok(has('src/example.js', '// ' + value, 'PRIVATE_AI_PROCESS'));
});
for (const name of ['User', 'Assistant', 'user', 'assistant', '用户', '助手']) test('plain role record: ' + name, () => assert.ok(has('data.csv', name + ':synthetic', 'RAW_CONVERSATION')));
test('Chinese dialogue does not require spaces', () => assert.ok(has('data.csv', join('用户', '：合成问题\n', '助手', '：合成回答'), 'RAW_CONVERSATION')));
const conversation = bytes(JSON.stringify({messages: [{role: 'user', content: 'synthetic question'}, {role: 'assistant', content: 'synthetic answer'}]}));
const conversationPolicy = {reviewedConversations: {'fixture.json': {sha256: hash(conversation), reason: 'Reviewed synthetic protocol fixture'}}};
test('structured conversation requires separate review', () => assert.ok(has('fixture.json', conversation, 'RAW_CONVERSATION')));
test('explicit synthetic conversation review passes', () => assert.deepEqual(inspectBytes('fixture.json', conversation, conversationPolicy), []));
test('changed conversation invalidates review', () => assert.ok(inspectBytes('fixture.json', Buffer.concat([conversation, bytes('\n')]), conversationPolicy).length));
const fake = join('sk-', 'proj-', randomBytes(32).toString('base64url'));
test('credential format is blocked without disclosure', () => { const f = inspectBytes('config.json', bytes(JSON.stringify({api_key: fake}))); assert.ok(f.length); assert.equal(JSON.stringify(f).includes(fake), false); });
test('unquoted credential is blocked', () => assert.ok(has('.env.example', 'API_KEY=' + randomBytes(24).toString('hex'), 'CREDENTIAL_SCALAR')));
test('quoted credential is blocked', () => assert.ok(has('config.json', JSON.stringify({password: randomBytes(24).toString('hex')}), 'CREDENTIAL_LITERAL')));
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const binaryPolicy = {reviewedBinary: {'docs/image.png': {sha256: hash(png), reason: 'Synthetic bytes'}}};
test('unknown binary requires review', () => assert.ok(inspectBytes('docs/image.png', png).length));
test('image extension requires review without NUL bytes', () => assert.ok(inspectBytes('docs/image.jpg', bytes('synthetic image')).some(f => f.category === 'BINARY_REVIEW_REQUIRED')));
test('invalid UTF-8 requires review without NUL bytes', () => assert.ok(inspectBytes('data.dat', Buffer.from([255, 254, 240])).some(f => f.category === 'BINARY_REVIEW_REQUIRED')));
test('exact binary review passes', () => assert.deepEqual(inspectBytes('docs/image.png', png, binaryPolicy), []));
test('changed binary requires review', () => assert.ok(inspectBytes('docs/image.png', Buffer.concat([png, bytes('x')]), binaryPolicy).length));
test('approved document cannot exempt private filename', () => assert.ok(inspectBytes(join('HAND', 'OFF.md'), formal, approved(join('HAND', 'OFF.md'), formal)).some(f => f.category === 'PRIVATE_FILE')));
test('approved document cannot exempt local paths', () => assert.ok(inspectBytes('docs/safety.md', bytes(home), approved('docs/safety.md', bytes(home))).some(f => f.category === 'PRIVATE_LOCAL_PATH')));
test('approved document cannot exempt transcript', () => { const data = bytes('Assistant' + ': synthetic'); assert.ok(inspectBytes('docs/safety.md', data, approved('docs/safety.md', data)).some(f => f.category === 'RAW_CONVERSATION')); });
const fixture = fs.mkdtempSync(testPaths.tempPrefix('privacy-'));
const git = (args, input) => execFileSync('git', args, {cwd: fixture, input, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
git(['init', '-q']); git(['config', 'user.name', 'Privacy fixture']); git(['config', 'user.email', 'privacy@example.invalid']); git(['config', 'core.autocrlf', 'false']);
fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({name: 'dsh-noname-kit'}));
for (const name of guardFiles) { const target = path.join(fixture, name); fs.mkdirSync(path.dirname(target), {recursive: true}); fs.copyFileSync(new URL('../' + name, import.meta.url), target); }
fs.writeFileSync(path.join(fixture, 'source.js'), 'export const protocol = "ok";\n');
git(['add', '.']);
const cli = (file, args = [], input) => spawnSync(process.execPath, [path.join(fixture, 'scripts', file), ...args], {cwd: fixture, input, encoding: 'utf8', windowsHide: true});
test('installer requires explicit reviewed controls', () => assert.notEqual(cli('install-privacy-hooks.mjs').status, 0));
const customHook = path.join(fixture, '.git', 'hooks', 'pre-commit');
fs.writeFileSync(customHook, '#!/bin/sh\nexit 0\n');
test('installer preserves existing custom hooks', () => { assert.notEqual(cli('install-privacy-hooks.mjs', ['--reviewed']).status, 0); assert.equal(fs.readFileSync(customHook, 'utf8'), '#!/bin/sh\nexit 0\n'); });
fs.unlinkSync(customHook);
git(['config', 'core.hooksPath', '.custom-hooks']);
test('installer preserves existing hook configuration', () => { assert.notEqual(cli('install-privacy-hooks.mjs', ['--reviewed']).status, 0); assert.equal(git(['config', '--get', 'core.hooksPath']).trim(), '.custom-hooks'); });
git(['config', '--unset', 'core.hooksPath']);
test('installer accepts explicit reviewed controls', () => assert.equal(cli('install-privacy-hooks.mjs', ['--reviewed']).status, 0));
test('unchanged reviewed installation is idempotent', () => assert.equal(cli('install-privacy-hooks.mjs').status, 0));
const hook = (name, input) => {
  const args = ['hook', 'run'];
  if (input !== undefined) { const file = path.join(fixture, '.git', 'synthetic-hook-input'); fs.writeFileSync(file, input); args.push('--to-stdin=' + file); }
  return spawnSync('git', [...args, name], {cwd: fixture, encoding: 'utf8', windowsHide: true});
};
test('actual commit hook accepts clean index', () => assert.equal(hook('pre-commit').status, 0));
git(['commit', '-qm', 'Initial fixture']);
const initial = git(['rev-parse', 'HEAD']).trim(), zero = '0'.repeat(initial.length);
const input = (oid, ref = 'refs/heads/main') => `${oid} ${oid} ${ref} ${zero}\n`;
test('actual push hook accepts proposed clean commit', () => assert.equal(hook('pre-push', input(initial)).status, 0));
fs.writeFileSync(path.join(fixture, 'params.json'), JSON.stringify({api_key: fake})); git(['add', 'params.json']);
test('actual commit hook rejects credentials without disclosure', () => { const r = hook('pre-commit'); assert.notEqual(r.status, 0); assert.equal((r.stdout + r.stderr).includes(fake), false); });
git(['rm', '-f', 'params.json']);
fs.writeFileSync(path.join(fixture, 'source.js'), '// ' + processes[0][1] + '\n');
test('tracked mode checks unstaged bytes', () => assert.equal(runCheck({repo: fixture}).ok, false));
test('staged mode checks indexed bytes', () => assert.equal(runCheck({repo: fixture, mode: 'staged'}).ok, true));
git(['add', 'source.js']); fs.writeFileSync(path.join(fixture, 'source.js'), 'export const protocol = "ok";\n');
test('clean worktree cannot hide bad index', () => assert.notEqual(hook('pre-commit').status, 0));
git(['add', 'source.js']);
fs.writeFileSync(path.join(fixture, 'record.md'), processes[0][1]); git(['add', 'record.md']);
test('actual commit hook rejects process record', () => assert.notEqual(hook('pre-commit').status, 0));
const changedPolicy = readPolicy(path.join(fixture, 'scripts/privacy-policy.json'));
changedPolicy.reviewedText['record.md'] = [{sha256: hash(bytes(processes[0][1])), reason: 'Synthetic attempt'}];
fs.writeFileSync(path.join(fixture, 'scripts/privacy-policy.json'), JSON.stringify(changedPolicy)); git(['add', 'scripts/privacy-policy.json']);
test('staged policy cannot authorize pending document', () => { const r = hook('pre-commit'); assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /GUARD_UPDATE_REQUIRES_INSTALLATION/); });
git(['restore', '--source=HEAD', '--staged', '--worktree', 'scripts/privacy-policy.json']); git(['rm', '-f', 'record.md']);
fs.writeFileSync(path.join(fixture, '.gitignore'), join('HAND', 'OFF.md\n')); fs.writeFileSync(path.join(fixture, join('HAND', 'OFF.md')), 'synthetic'); git(['add', '-f', join('HAND', 'OFF.md')]);
test('force-added ignored record is blocked', () => assert.notEqual(hook('pre-commit').status, 0));
git(['rm', '-f', join('HAND', 'OFF.md')]);
fs.writeFileSync(path.join(fixture, 'scripts/privacy-check.mjs'), 'process.exit(0);\n'); git(['add', 'scripts/privacy-check.mjs']);
test('staged checker replacement cannot disable snapshot', () => assert.notEqual(hook('pre-commit').status, 0));
const weakenedTree = git(['write-tree']).trim();
const weakenedCommit = git(['commit-tree', weakenedTree, '-p', initial, '-m', 'Synthetic control fixture']).trim();
test('push cannot distribute replaced controls on a branch', () => assert.notEqual(hook('pre-push', input(weakenedCommit)).status, 0));
git(['restore', '--source=HEAD', '--staged', '--worktree', 'scripts/privacy-check.mjs']);
git(['rm', '--cached', '.github/workflows/privacy.yml']);
test('missing staged CI control is blocked', () => assert.notEqual(hook('pre-commit').status, 0));
git(['restore', '--source=HEAD', '--staged', '.github/workflows/privacy.yml']);
const tree = git(['rev-parse', 'HEAD^{tree}']).trim();
const dirtyCommit = git(['commit-tree', tree, '-p', initial, '-m', processes[0][1]]).trim();
test('unreferenced explicit commit message is scanned', () => assert.notEqual(hook('pre-push', input(dirtyCommit)).status, 0));
const blob = git(['hash-object', '-w', '--stdin'], 'synthetic').trim();
test('direct blob push is refused', () => assert.notEqual(hook('pre-push', input(blob, 'refs/tags/direct')).status, 0));
test('direct tree push is refused', () => assert.notEqual(hook('pre-push', input(tree, 'refs/tags/tree')).status, 0));
test('unsupported namespace is refused', () => assert.notEqual(hook('pre-push', input(initial, 'refs/notes/test')).status, 0));
const makeTag = (target, type, name, body) => git(['mktag'], `object ${target}\ntype ${type}\ntag ${name}\ntagger Privacy fixture <privacy@example.invalid> 1700000000 +0000\n\n${body}\n`).trim();
const badTag = makeTag(initial, 'commit', 'synthetic-bad', processes[0][1]);
test('unreferenced annotated tag body is scanned', () => assert.notEqual(hook('pre-push', input(badTag, 'refs/tags/release')).status, 0));
const nestedTag = makeTag(badTag, 'tag', 'synthetic-nested', 'Release fixture');
test('nested annotated tag body is scanned', () => assert.notEqual(hook('pre-push', input(nestedTag, 'refs/tags/nested')).status, 0));
const blobTag = makeTag(blob, 'blob', 'synthetic-blob', 'Release fixture');
test('annotated tag to blob is refused', () => assert.notEqual(hook('pre-push', input(blobTag, 'refs/tags/blob')).status, 0));
const goodTag = makeTag(initial, 'commit', 'synthetic-good', 'Release fixture');
test('normal annotated release tag is allowed', () => assert.equal(hook('pre-push', input(goodTag, 'refs/tags/good')).status, 0));
test('deletion update has no local objects to expose', () => assert.equal(hook('pre-push', input(zero)).status, 0));
test('malformed push input fails closed', () => assert.equal(hook('pre-push', 'malformed\n').status, 2));
test('push parser validates object ids', () => assert.throws(() => parsePushInput('local bad refs/heads/main bad')));
git(['update-ref', 'refs/tags/unsafe-fixture', badTag]);
test('history scan inspects referenced tag body', () => assert.equal(runCheck({repo: fixture, mode: 'history'}).ok, false));
git(['update-ref', '-d', 'refs/tags/unsafe-fixture']);
git(['update-ref', 'refs/heads/unsafe-fixture', dirtyCommit]);
test('history scan covers other local branches', () => assert.equal(runCheck({repo: fixture, mode: 'history'}).ok, false));
test('push checks proposed roots instead of unrelated branches', () => assert.equal(hook('pre-push', input(initial)).status, 0));
git(['update-ref', '-d', 'refs/heads/unsafe-fixture']);
test('all-object scan includes unreachable commit and tags', () => assert.equal(runCheck({repo: fixture, mode: 'history', allObjects: true}).ok, false));
fs.writeFileSync(path.join(fixture, '.git', 'shallow'), initial + '\n');
test('history refuses shallow evidence', () => assert.ok(runCheck({repo: fixture, mode: 'history'}).findings.some(f => f.category === 'SHALLOW_HISTORY')));
test('push refuses shallow evidence', () => assert.notEqual(hook('pre-push', input(initial)).status, 0));
console.log('All passed: ' + passed + ' checks');
