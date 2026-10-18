import testPaths from './fixtures/test-paths.cjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import childProcess from 'node:child_process';

// Inject only a denied capability probe. Successful probes and all transaction,
// recovery and namespace operations use the shipped native implementations.
const nativeSpawnSync = childProcess.spawnSync;
let rejectPreflight = false;
const probes = [];
childProcess.spawnSync = function (command, args, options) {
  if (options?.env?.NNK_BATCH_ACL_REQUEST) {
    const request = JSON.parse(fs.readFileSync(options.env.NNK_BATCH_ACL_REQUEST));
    if (request.mode === 'preflight') {
      probes.push(request);
      if (rejectPreflight) return {status: 1, stderr: 'Publication preflight requires READ_CONTROL | WRITE_DAC: denied test fixture', stdout: ''};
    }
  }
  return nativeSpawnSync.apply(this, arguments);
};
const core = createRequire(import.meta.url)('../online-kernel/lib/batch-files.cjs');
childProcess.spawnSync = nativeSpawnSync;
const base = testPaths.assertTestPath(testPaths.tempPrefix('acl-preflight-') + randomUUID());
fs.mkdirSync(base, {recursive: true});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const root = fs.mkdtempSync(path.join(base, 'fixture-'));
  fs.mkdirSync(root + '/extension/A/nested', {recursive: true});
  fs.writeFileSync(root + '/extension/A/extension.js', 'old inert extension');
  fs.writeFileSync(root + '/extension/A/nested/extra.txt', 'preserved local file');
  return root;
}
function transaction(root) {
  const bytes = Buffer.from('new inert extension'), batch = {extensions: ['A', 'B'].map(name => ({name, files: [{path: 'extension.js', size: bytes.length, sha256: digest(bytes)}]}))};
  const tx = new core.Transaction(root, batch, {session: 'a'.repeat(32), peerSession: 'b'.repeat(32), proposal: 'c'.repeat(32), digest: core.manifestDigest(batch)});
  for (let i = 0; i < tx.files.length; i++) tx.putFile(i, bytes);
  return tx;
}
function rootRow(root) {
  const file = path.join(root, 'extension');
  return {path: file, isDirectory: true, isRoot: true, ino: String(fs.lstatSync(file, {bigint: true}).ino)};
}
function probe(root, entries, label) { return core._test.acl(root, path.join(root, label + '.json'), 'preflight', entries); }
function unchanged(root) {
  assert.equal(fs.readFileSync(root + '/extension/A/extension.js', 'utf8'), 'old inert extension');
  assert.equal(fs.readFileSync(root + '/extension/A/nested/extra.txt', 'utf8'), 'preserved local file');
  assert.equal(fs.existsSync(root + '/extension/B'), false);
  assert.equal(fs.existsSync(root + '/nnk-batches/active'), false);
  assert.equal(core.recover(root).status, 'none');
}
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ✓ ' + name); }

test('native preflight checks root/directories/files without changing permission metadata or content', () => {
  const root = fixture(), rows = [rootRow(root), ...core._test.rowsAt(root + '/extension/A', core._test.tree(root + '/extension/A'))];
  const before = core._test.acl(root, root + '/capture-before.json', 'capture', rows);
  const content = fs.readFileSync(root + '/extension/A/extension.js');
  probe(root, rows, 'native-probe');
  const after = core._test.acl(root, root + '/capture-after.json', 'capture', rows);
  assert.deepEqual(after, before);
  assert.deepEqual(fs.readFileSync(root + '/extension/A/extension.js'), content);
  for (const row of rows) assert.equal(String(fs.lstatSync(row.path, {bigint: true}).ino), row.ino);
});
test('native preflight rejects changed identities, wrong file type and invalid identity', () => {
  const root = fixture(), row = rootRow(root);
  assert.throws(() => probe(root, [{...row, ino: '0'}], 'wrong-identity'), /identity or file type changed/);
  assert.throws(() => probe(root, [{...row, isDirectory: false}], 'wrong-type'), /identity or file type changed/);
  assert.throws(() => probe(root, [{...row, ino: 'invalid'}], 'invalid-identity'), /Invalid preflight identity/);
});
test('native preflight rejects escaping paths, junction leaves and junction ancestors', () => {
  const root = fixture(), other = fixture();
  assert.throws(() => probe(root, [rootRow(other)], 'escape'), /Path escape/);
  fs.symlinkSync(other + '/extension/A', root + '/linked', 'junction');
  assert.throws(() => probe(root, [{...rootRow(root), path: root + '/linked'}], 'junction-leaf'), /Reparse/);
  const file = root + '/linked/extension.js';
  assert.throws(() => probe(root, [{path: file, isDirectory: false, ino: String(fs.lstatSync(file, {bigint: true}).ino)}], 'junction-ancestor'), /Reparse ancestor/);
});
test('prepare capability denial preserves formal namespace and permits ordinary abort', () => {
  const root = fixture(), tx = transaction(root);
  rejectPreflight = true;
  try {
    assert.throws(() => tx.prepare(), /Publication preflight requires READ_CONTROL/);
    assert.equal(core._test.stateRead(tx.folder).phase, 'receiving');
    assert.equal(fs.existsSync(tx.folder + '/workspace'), false);
    const request = probes.at(-1), paths = new Set(request.entries.map(row => row.path));
    assert.equal(paths.has(path.join(root, 'extension')), true, 'outer publication root is required');
    assert.equal(paths.has(path.join(root, 'extension/A/nested/extra.txt')), true, 'all old extra files need the same capability');
    assert.equal(paths.has(path.join(tx.folder, 'next/A/extension.js')), true);
    assert.equal(paths.has(path.join(tx.folder, 'next/B/extension.js')), true);
    assert.equal(tx.abort().status, 'rolled_back');
    unchanged(root);
  } finally { rejectPreflight = false; if (!tx.closed) tx.abort(); }
});
test('commit repeats capability probe and rejects before withdraw with clean rollback', () => {
  const root = fixture(), tx = transaction(root);
  tx.prepare();
  rejectPreflight = true;
  try {
    assert.throws(() => tx.commit(() => true), error => /Publication preflight requires READ_CONTROL/.test(error.message) && error.outcome?.status === 'rolled_back');
    assert.equal(core._test.stateRead(tx.folder).phase, 'rolled_back');
    assert.equal(fs.existsSync(tx.folder + '/workspace'), false);
    assert.equal(probes.at(-1).mode, 'preflight');
    unchanged(root);
  } finally { rejectPreflight = false; if (!tx.closed) tx.abort(); }
});
console.log(`全部通过: ${passed} 项`);
