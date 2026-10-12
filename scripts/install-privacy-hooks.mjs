#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const git = args => execFileSync('git', args, {encoding: 'utf8', windowsHide: true}).trim();
const repo = git(['rev-parse', '--show-toplevel']);
process.chdir(repo);
if (JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).name !== 'dsh-noname-kit') throw Error('Run this installer from a NONAME-KIT source checkout');
let existing = '';
try { existing = git(['config', '--get', 'core.hooksPath']); } catch (error) { if (error.status !== 1) throw error; }
const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
const hooks = path.join(common, 'hooks'), snapshot = path.join(common, 'noname-kit-privacy');
if (existing && existing !== '.githooks' && path.resolve(existing) !== hooks) throw Error('Existing hook configuration retained; integrate the privacy checks into your hooks explicitly');
for (const name of ['pre-commit', 'pre-push']) {
  if (!fs.existsSync(path.join(repo, '.githooks', name))) throw Error('Missing shipped privacy hook');
  const target = path.join(hooks, name);
  if (fs.existsSync(target) && !fs.readFileSync(target, 'utf8').includes('# NONAME-KIT managed privacy hook')) throw Error('Existing hook retained; integrate explicitly');
}
fs.mkdirSync(snapshot, {recursive: true});fs.mkdirSync(hooks, {recursive: true});
fs.copyFileSync(fileURLToPath(new URL('./privacy-check.mjs', import.meta.url)), path.join(snapshot, 'privacy-check.mjs'));
fs.copyFileSync(fileURLToPath(new URL('./privacy-policy.json', import.meta.url)), path.join(snapshot, 'privacy-policy.json'));
for (const name of ['pre-commit', 'pre-push']) { const target = path.join(hooks, name); fs.copyFileSync(path.join(repo, '.githooks', name), target); fs.chmodSync(target, 0o755); }
git(['config', '--local', 'nonamekit.privacyNode', process.execPath]);
git(['config', '--local', 'nonamekit.privacyChecker', path.join(snapshot, 'privacy-check.mjs')]);
git(['config', '--local', 'core.hooksPath', hooks]);
console.log('Privacy commit and push checks installed for this checkout.');
