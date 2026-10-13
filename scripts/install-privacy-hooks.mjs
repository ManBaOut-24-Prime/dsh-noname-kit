#!/usr/bin/env node
/** Install a locally reviewed, persistent checker snapshot for every worktree. */
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {guardFiles, canonicalDigest, readPolicy} from './privacy-check.mjs';
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--reviewed')) throw Error('Only --reviewed is supported');
const git = args => execFileSync('git', args, {encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']}).trim();
const repo = git(['rev-parse', '--show-toplevel']);
process.chdir(repo);
if (JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).name !== 'dsh-noname-kit') throw Error('Run from a NONAME-KIT source checkout');
let existing = '';
try { existing = git(['config', '--get', 'core.hooksPath']); } catch (error) { if (error.status !== 1) throw error; }
const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
const hooks = path.join(common, 'hooks'), snapshot = path.join(common, 'noname-kit-privacy');
if (existing && existing !== '.githooks' && path.resolve(existing) !== hooks) throw Error('Existing hook configuration retained; integrate explicitly');
for (const name of ['pre-commit', 'pre-push']) {
  const target = path.join(hooks, name);
  if (fs.existsSync(target) && !fs.readFileSync(target, 'utf8').includes('# NONAME-KIT managed privacy hook')) throw Error('Existing hook retained; integrate explicitly');
}
readPolicy(path.join(repo, 'scripts/privacy-policy.json'));
const manifest = {};
for (const name of guardFiles) {
  const target = path.join(repo, name);
  if (!fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink()) throw Error('Missing or linked privacy control');
  manifest[name] = canonicalDigest(fs.readFileSync(target));
}
const manifestFile = path.join(snapshot, 'guard-manifest.json');
const oldManifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {};
if (Object.entries(manifest).some(([name, sha256]) => oldManifest[name] !== sha256) && !args.includes('--reviewed')) {
  throw Error('Review the checker, policy approvals, hooks and CI, then install with --reviewed. Pending policy edits never authorize themselves.');
}
fs.mkdirSync(snapshot, {recursive: true}); fs.mkdirSync(hooks, {recursive: true});
for (const name of ['privacy-check.mjs', 'privacy-policy.json']) fs.copyFileSync(path.join(repo, 'scripts', name), path.join(snapshot, name));
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
for (const name of ['pre-commit', 'pre-push']) { const target = path.join(hooks, name); fs.copyFileSync(path.join(repo, '.githooks', name), target); fs.chmodSync(target, 0o755); }
git(['config', '--local', 'nonamekit.privacyNode', process.execPath]);
git(['config', '--local', 'nonamekit.privacyChecker', path.join(snapshot, 'privacy-check.mjs')]);
git(['config', '--local', 'core.hooksPath', hooks]);
console.log('Reviewed privacy snapshot installed. Reinstall with --reviewed after reviewing changes to privacy controls or document approvals.');
