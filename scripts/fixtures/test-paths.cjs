// Shared boundaries for disposable test fixtures. This module never runs probes.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {pathToFileURL} = require('node:url');

function same(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function noLinks(target, boundary) {
  let current = target;
  while (true) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw Error('Test path traverses a link');
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
    if (same(current, boundary)) break;
    const parent = path.dirname(current);
    if (parent === current) throw Error('Test path escaped its boundary');
    current = parent;
  }
}
function testRoot() {
  const root = path.resolve(process.env.NNK_TEST_ROOT || path.join(os.tmpdir(), 'noname-kit-tests'));
  if (process.platform === 'win32' && /^[\\/]{2}/.test(root)) throw Error('Test root must be a local drive path');
  if (!/^(?:noname-kit-tests?|nnk-tests?)(?:[-_].*)?$/i.test(path.basename(root))) throw Error('NNK_TEST_ROOT must name a dedicated noname-kit-test or nnk-test directory');
  if (same(root, path.parse(root).root) || same(root, os.homedir()) || same(root, path.resolve(__dirname, '../..'))) throw Error('Unsafe test root');
  for (const marker of ['noname.js', 'game/game.js', 'resources/app/noname.js', 'resources/app/src/noname.js']) {
    if (fs.existsSync(path.join(root, marker))) throw Error('Test base is a game installation');
  }
  noLinks(root, path.parse(root).root);
  return root;
}
function assertTestPath(value, {parent = testRoot(), prefix} = {}) {
  if (typeof value !== 'string' || !value) throw Error('Explicit test path required');
  const root = testRoot(), base = path.resolve(parent), target = path.resolve(value);
  const under = (a, b) => { const rel = path.relative(a, b); return !!rel && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep); };
  if (!same(base, root) && !under(root, base)) throw Error('Test parent outside dedicated root');
  if (!under(base, target)) throw Error('Test path outside dedicated root');
  if (prefix && (!same(path.dirname(target), base) || !path.basename(target).startsWith(prefix))) throw Error('Unexpected fixture prefix');
  noLinks(target, root);
  return target;
}
function testPath(relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw Error('Relative test path required');
  return assertTestPath(path.join(testRoot(), relative));
}
function directory(relative) {
  const dir = testPath(relative);
  fs.mkdirSync(dir, {recursive: true});
  return assertTestPath(dir);
}
function tempDir() { return directory('temp'); }
function logsDir() { return directory('logs'); }
function tempPrefix(prefix) {
  if (!/^[A-Za-z0-9_-]+-$/.test(prefix)) throw Error('Safe test prefix required');
  return assertTestPath(path.join(tempDir(), prefix));
}
function outputPath(name) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw Error('Safe output filename required');
  return assertTestPath(path.join(logsDir(), name));
}
function sourceRoot() {
  const root = path.resolve(process.env.NNK_SOURCE_ROOT || path.join(__dirname, '../..'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'dsh-noname-kit' || !fs.existsSync(path.join(root, 'online-kernel/extension.js'))) throw Error('Expected NONAME-KIT source or package root');
  return root;
}
function requiredSourceRoot() {
  if (!process.env.NNK_SOURCE_ROOT) throw Error('Set NNK_SOURCE_ROOT to the independent source checkout');
  return sourceRoot();
}
function sourceUrl(relative) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw Error('Relative source path required');
  return pathToFileURL(path.join(sourceRoot(), relative)).href;
}
function requiredTestPath(name) {
  const value = process.env[name];
  if (!value) throw Error('Set ' + name + ' to an isolated test path');
  return assertTestPath(value);
}
function assertDistinctSource(source, installed) {
  const installedPath = installed instanceof URL ? require('node:url').fileURLToPath(installed) : installed;
  if (same(fs.realpathSync(source), fs.realpathSync(installedPath))) throw Error('Source and installed test package must be distinct');
  return assertTestPath(installedPath);
}
function officialRoot(label) {
  if (!['Old', 'Latest'].includes(label)) throw Error('Expected Old or Latest fixture');
  const configured = process.env[label === 'Old' ? 'NNK_OFFICIAL_OLD_ROOT' : 'NNK_OFFICIAL_LATEST_ROOT'];
  return configured ? assertTestPath(configured) : testPath((label === 'Old' ? 'official-1.11.5.2' : 'official-latest') + '/resources/app');
}
module.exports = {testRoot, assertTestPath, testPath, tempDir, logsDir, tempPrefix, outputPath, sourceRoot, requiredSourceRoot, sourceUrl, requiredTestPath, assertDistinctSource, officialRoot};
