import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import testPaths from './fixtures/test-paths.cjs';

const initial = process.env.NNK_TEST_ROOT, base = testPaths.testRoot();
const fixture = fs.mkdtempSync(testPaths.tempPrefix('paths-'));
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ✓ ' + name); }
try {
  test('default/configured root is dedicated', () => assert.match(path.basename(base), /(?:noname-kit-test|nnk-test)/i));
  test('relative output stays inside boundary', () => assert.equal(testPaths.testPath('temp/example'), path.join(base, 'temp/example')));
  for (const value of ['../outside', 'temp/../../outside', path.parse(base).root, '']) test('reject unsafe relative input', () => assert.throws(() => testPaths.testPath(value)));
  test('reject base itself as disposable target', () => assert.throws(() => testPaths.assertTestPath(base)));
  test('reject similarly named sibling', () => assert.throws(() => testPaths.assertTestPath(base + '-other/file')));
  test('reject wrong fixture prefix', () => assert.throws(() => testPaths.assertTestPath(path.join(fixture, 'wrong'), {parent: fixture, prefix: 'allowed-'})));
  test('accept exact fixture prefix', () => assert.equal(testPaths.assertTestPath(path.join(fixture, 'allowed-one'), {parent: fixture, prefix: 'allowed-'}), path.join(fixture, 'allowed-one')));
  test('safe output directory exists', () => assert.ok(fs.statSync(path.dirname(testPaths.outputPath('path-result.json'))).isDirectory()));
  test('output name cannot traverse', () => assert.throws(() => testPaths.outputPath('../outside.json')));
  test('prefix cannot traverse', () => assert.throws(() => testPaths.tempPrefix('../outside-')));
  test('required fixture cannot default to user directory', () => assert.throws(() => testPaths.requiredTestPath('NNK_MISSING_TEST_FIXTURE')));
  test('Loader source must be explicit', () => { const value = process.env.NNK_SOURCE_ROOT; delete process.env.NNK_SOURCE_ROOT; try { assert.throws(() => testPaths.requiredSourceRoot()); } finally { if (value !== undefined) process.env.NNK_SOURCE_ROOT = value; } });
  test('Loader source and installed package must be distinct', () => assert.throws(() => testPaths.assertDistinctSource(testPaths.sourceRoot(), testPaths.sourceRoot())));
  const candidate = path.join(fixture, 'nnk-test-game'); fs.mkdirSync(candidate); fs.writeFileSync(path.join(candidate, 'noname.js'), 'fixture');
  test('configured game root rejected before writes', () => { process.env.NNK_TEST_ROOT = candidate; assert.throws(() => testPaths.tempDir()); assert.equal(fs.readFileSync(path.join(candidate, 'noname.js'), 'utf8'), 'fixture'); process.env.NNK_TEST_ROOT = base; });
  test('filesystem root rejected', () => { process.env.NNK_TEST_ROOT = path.parse(base).root; assert.throws(() => testPaths.testRoot()); process.env.NNK_TEST_ROOT = base; });
  test('ordinary configured directory rejected', () => { process.env.NNK_TEST_ROOT = path.join(fixture, 'ordinary-folder'); assert.throws(() => testPaths.testRoot()); process.env.NNK_TEST_ROOT = base; });
  if (process.platform === 'win32') test('network/device root rejected before filesystem access', () => { process.env.NNK_TEST_ROOT = '\\\\' + ['synthetic-server', 'share', 'nnk-test'].join('\\'); assert.throws(() => testPaths.testRoot(), /local drive/); process.env.NNK_TEST_ROOT = base; });
  const destination = path.join(fixture, 'destination'); fs.mkdirSync(destination);
  const link = path.join(fixture, 'link'); fs.symlinkSync(destination, link, process.platform === 'win32' ? 'junction' : 'dir');
  test('existing link/reparse path rejected', () => assert.throws(() => testPaths.assertTestPath(path.join(link, 'file'))));
  const broken = path.join(fixture, 'broken'); fs.symlinkSync(path.join(fixture, 'missing-target'), broken, process.platform === 'win32' ? 'junction' : 'dir');
  test('dangling link rejected', () => assert.throws(() => testPaths.assertTestPath(path.join(broken, 'file'))));
  test('official fixture selector checked', () => assert.throws(() => testPaths.officialRoot('Other')));
  test('official fixture stays in dedicated base', () => assert.equal(testPaths.officialRoot('Old'), testPaths.testPath('official-1.11.5.2/resources/app')));
  test('source URL is derived from checkout', () => assert.equal(new URL(testPaths.sourceUrl('index.js')).protocol, 'file:'));
} finally { if (initial === undefined) delete process.env.NNK_TEST_ROOT; else process.env.NNK_TEST_ROOT = initial; }
console.log('全部通过: ' + passed + ' 项');
