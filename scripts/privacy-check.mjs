#!/usr/bin/env node
/** Local/CI privacy gate. Reports locations and categories, never matched values. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const modelNames = ['Astra', 'Sol', 'Codex', 'GPT-6'];
const privateContext = /(?:交接|复审|审查安排|额度|下一会话|原始审计|对话记录|会话记录)/;
const privateLocation = /\b[A-Za-z]:[\\/]+(?:NONAME-KIT-TEST|deepseek-harness|codex|wms)(?:[\\/]+|\b)|\.codex[\\/]+(?:attachments|logs|sessions)\b|\.agents[\\/]+logs\b/i;
const userHome = /\b[A-Za-z]:[\\/]+Users[\\/]+(?!<|\$|%|\{)[^\\/\s'"<>]+/i;
const roleRecord = /^\s*(?:#{1,6}\s*)?(?:User|Assistant|System|Developer|用户|助手)\s*[:：](?:\s|$)/i;
const secretFormats = [
  ['PRIVATE_KEY', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/],
  ['TOKEN_FORMAT', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|npm_[A-Za-z0-9]{30,})\b/],
  ['JWT_LITERAL', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['AUTH_IN_URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/"'<>:]+:[^\s/"'<>@]+@[^\s/"'<>]+/i],
  ['BEARER_LITERAL', /\bBearer\s+[A-Za-z0-9_.-]{20,}/],
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const placeholder = value => /(?:example|placeholder|fixture|test|mock|invalid|unused|redacted|your[_ -]|change.?me)/i.test(value) || /^([a-zA-Z0-9])\1+$/.test(value);
function entropy(value) {
  const frequencies = new Map();
  for (const char of value) frequencies.set(char, (frequencies.get(char) || 0) + 1);
  return [...frequencies.values()].reduce((sum, n) => sum - n / value.length * Math.log2(n / value.length), 0);
}
function quoteContext(line, position) {
  let quote = '', opened = -1, escaped = false;
  for (let i = 0; i < position; i++) {
    const char = line[i];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (char === '\\') escaped = true;
      else if (char === quote) { quote = ''; opened = -1; }
    } else if (["'", '"', '`'].includes(char)) { quote = char; opened = i; }
  }
  return {quote, opened};
}
export function inspectBytes(file, bytes, policy = {}) {
  const findings = [];
  const add = (line, category) => findings.push({file, line, category});
  const normalized = file.replaceAll('\\', '/');
  if (/(?:^|\/)(?:ai-records|audit-records|private-records|raw-audits|logs|nnk-batches)(?:\/|$)/i.test(normalized)
    || /(?:^|\/)(?:HANDOFF|AI-CHAT|CHAT-TRANSCRIPT|SESSION-TRANSCRIPT|REVIEW-PROGRESS|FINAL-REVIEW)(?:[-_.].*)?\.(?:md|txt|json)$/i.test(normalized)
    || /^docs\/(?:B5-PAUSED|B6-B8-REVIEW-HANDOFF)\.md$/i.test(normalized)
    || /(?:^|\/)(?:nnk-bridge|noname-kit(?:\.tasks)?)\.json$/i.test(normalized)
    || /(?:^|\/)\.env(?:\..*)?$/i.test(normalized) && !/(?:^|\/)\.env\.example$/i.test(normalized)) add(0, 'PRIVATE_FILE');
  if (bytes.includes(0)) {
    const approval = policy.reviewedBinary?.[normalized];
    if (approval?.sha256 !== digest(bytes) || typeof approval?.reason !== 'string' || !approval.reason.trim()) add(0, 'BINARY_REVIEW_REQUIRED');
    return findings;
  }
  const text = bytes.toString('utf8'), lines = text.split(/\r?\n/);
  if (/\.(?:json|jsonl)$/i.test(normalized)) {
    let document;
    try { document = normalized.toLowerCase().endsWith('.jsonl') ? lines.filter(line => line.trim()).map(line => JSON.parse(line)) : JSON.parse(text); }
    catch (error) { document = null; /* Malformed/non-JSON data still receives all text checks. */ }
    const messages = Array.isArray(document) ? document : document?.messages;
    if (Array.isArray(messages) && messages.filter(message => ['user', 'assistant', 'system', 'developer'].includes(message?.role) && typeof message?.content === 'string').length >= 2) {
      const review = policy.reviewedConversations?.[normalized];
      if (review?.sha256 !== digest(bytes) || typeof review?.reason !== 'string' || !review.reason.trim()) add(0, 'RAW_CONVERSATION');
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (privateLocation.test(line) || userHome.test(line)) add(i + 1, 'PRIVATE_LOCAL_PATH');
    if (modelNames.some(name => line.includes(name)) && privateContext.test(line)) add(i + 1, 'PRIVATE_AI_PROCESS');
    if (roleRecord.test(line)) add(i + 1, 'RAW_CONVERSATION');
    for (const [category, expression] of secretFormats) {
      const match = expression.exec(line);
      if (match && !(category === 'AUTH_IN_URL' && placeholder(match[0]))) add(i + 1, category);
    }
    const assignment = /\b(?:[A-Za-z_$][\w$]*(?:token|secret|password|api[_-]?key|credential)[\w$]*|token|secret|password|api[_-]?key|credential)\b["']?\s*[:=]\s*(["'])([^\r\n"']{12,512})\1/gi;
    for (const match of line.matchAll(assignment)) {
      const context = quoteContext(line, match.index);
      const quotedKey = context.quote !== '`' && context.opened === match.index - 1 && /^[\w$-]+["']\s*:/.test(match[0]);
      if (context.quote && !quotedKey) continue;
      if (entropy(match[2]) >= 3 && !placeholder(match[2])) add(i + 1, 'CREDENTIAL_LITERAL');
    }
    const scalar = /^\s*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential)\s*[:=]\s*([A-Za-z0-9_+./=-]{12,512})\s*(?:#.*)?$/i.exec(line);
    if (scalar && entropy(scalar[1]) >= 3 && !placeholder(scalar[1])) add(i + 1, 'CREDENTIAL_SCALAR');
  }
  return findings;
}
function git(repo, args, input) {
  return execFileSync('git', args, {cwd: repo, env: {...process.env, GIT_OPTIONAL_LOCKS: '0'}, input, maxBuffer: 128 * 1024 * 1024, windowsHide: true});
}
function indexEntries(repo) {
  return git(repo, ['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean).map(row => {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(row);
    if (!match) throw Error('Invalid index record');
    return {mode: match[1], oid: match[2], stage: Number(match[3]), file: match[4]};
  });
}
function batchObjects(repo, identifiers) {
  const objects = new Map();
  for (let start = 0; start < identifiers.length; start += 16) {
    const group = identifiers.slice(start, start + 16);
    const buffer = git(repo, ['cat-file', '--batch'], group.join('\n') + '\n');
    let offset = 0;
    for (const oid of group) {
      const end = buffer.indexOf(10, offset);
      const header = buffer.subarray(offset, end).toString('ascii').split(' ');
      if (end < 0 || header[1] === 'missing') throw Error('Missing Git object');
      const size = Number(header[2]);
      objects.set(oid, buffer.subarray(end + 1, end + 1 + size));
      offset = end + 2 + size;
    }
  }
  return objects;
}
export function runCheck({repo = process.cwd(), mode = 'tracked', allObjects = false} = {}) {
  repo = git(repo, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  if (mode === 'history' && git(repo, ['rev-parse', '--is-shallow-repository']).toString('utf8').trim() === 'true') return {ok: false, mode, allObjects, filesOrBlobs: 0, commits: 0, findings: [{file: '<history>', line: 0, category: 'SHALLOW_HISTORY'}]};
  const storedPolicy = fileURLToPath(new URL('./privacy-policy.json', import.meta.url));
  let policy = fs.existsSync(storedPolicy) ? JSON.parse(fs.readFileSync(storedPolicy, 'utf8')) : {version: 1, reviewedBinary: {}};
  const entries = indexEntries(repo);
  const policyEntry = entries.find(e => e.file === 'scripts/privacy-policy.json' && e.stage === 0);
  if (policyEntry) {
    const bytes = mode === 'staged' ? git(repo, ['cat-file', 'blob', policyEntry.oid]) : fs.readFileSync(path.join(repo, policyEntry.file));
    policy = JSON.parse(bytes.toString('utf8'));
  }
  const findings = [];
  const locations = new Map();
  let commits = [], blobs = 0;
  if (mode === 'history') {
    commits = git(repo, ['rev-list', '--all']).toString('utf8').trim().split(/\r?\n/).filter(Boolean);
    for (const commit of commits) {
      const tree = git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit]).toString('utf8').split('\0').filter(Boolean);
      for (const entry of tree) {
        const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
        if (!match) continue;
        if (!locations.has(match[2])) locations.set(match[2], new Set());
        locations.get(match[2]).add(match[3]);
      }
    }
    if (allObjects) {
      const objects = git(repo, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']).toString('utf8').trim().split(/\r?\n/);
      for (const row of objects) { const [oid, type] = row.split(' '); if (type === 'blob' && !locations.has(oid)) locations.set(oid, new Set(['<unreferenced-blob>'])); }
    }
  } else if (mode === 'staged') {
    for (const entry of entries) {
      if (entry.stage) { findings.push({file: entry.file, line: 0, category: 'UNMERGED_INDEX'}); continue; }
      if (!locations.has(entry.oid)) locations.set(entry.oid, new Set());
      locations.get(entry.oid).add(entry.file);
    }
  } else {
    for (const file of [...new Set(entries.map(e => e.file))]) {
      if (!fs.existsSync(path.join(repo, file))) continue;
      findings.push(...inspectBytes(file, fs.readFileSync(path.join(repo, file)), policy));
      blobs++;
    }
  }
  if (locations.size) {
    const objects = batchObjects(repo, [...locations.keys()]);
    for (const [oid, names] of locations) for (const name of names) findings.push(...inspectBytes(name, objects.get(oid), policy));
    blobs = objects.size;
  }
  if (commits.length) {
    const messages = batchObjects(repo, commits);
    for (const [oid, bytes] of messages) {
      const text = bytes.toString('utf8'), body = text.slice(text.indexOf('\n\n') + 2);
      findings.push(...inspectBytes('commit:' + oid, Buffer.from(body), policy));
    }
  }
  const unique = [...new Map(findings.map(f => [f.file + '\0' + f.line + '\0' + f.category, f])).values()];
  return {ok: unique.length === 0, mode, allObjects, filesOrBlobs: blobs, commits: commits.length, findings: unique};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), valid = new Set(['--tracked', '--staged', '--history', '--all-objects', '--json']);
    if (args.some(arg => !valid.has(arg)) || args.filter(arg => ['--tracked', '--staged', '--history'].includes(arg)).length > 1) throw Error('Use one of --tracked, --staged or --history');
    if (args.includes('--all-objects') && !args.includes('--history')) throw Error('--all-objects requires --history');
    const mode = args.includes('--history') ? 'history' : args.includes('--staged') ? 'staged' : 'tracked';
    const result = runCheck({mode, allObjects: args.includes('--all-objects')});
    if (args.includes('--json')) console.log(JSON.stringify(result));
    else {
      for (const finding of result.findings) console.error(finding.file + ':' + finding.line + ' ' + finding.category);
      console.log('Privacy ' + mode + ': ' + (result.ok ? 'PASS' : 'FAIL') + '; ' + result.filesOrBlobs + ' files/blobs, ' + result.commits + ' commits, ' + result.findings.length + ' findings');
    }
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error('Privacy check could not complete: ' + (error?.code || error?.name || 'Error'));
    process.exitCode = 2;
  }
}
