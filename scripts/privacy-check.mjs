#!/usr/bin/env node
/** Local/CI privacy gate. Reports locations and categories, never matched values. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const processPatterns = [
  /\b(?:internal\s+)?(?:AI|LLM|agent|Codex|Astra|Sol|GPT-\d+)\s+(?:session\s+)?(?:handoff|transcript|work\s*log)\b/i,
  /\b(?:next|prior|previous)\s+(?:AI\s+)?session\b[\s\S]{0,100}\b(?:handoff|checkpoint|continue|resume)\b/i,
  /(?:内部\s*(?:AI|智能体)?\s*交接|下一(?:个|位)?\s*(?:AI|智能体|会话)|上一(?:会话)|本轮(?:工具调用)|阶段(?:审计流水账)|会话(?:交接|接续)|(?:AI|智能体)\s*对话记录)/i,
  /\b(?:Codex|Astra|Sol|GPT-\d+)\b\s*(?:\r?\n\s*)?(?:交接|复审|审查安排|额度|下一(?:会话)|原始审计|对话记录|会话记录)/i,
];
// Bounded combinations target internal review dialogue and handoff narration,
// not technical audit findings or objective product design constraints.
processPatterns.push(
  /用户\s*(?:追问|询问)[\s\S]{0,100}(?:审计|复审)[\s\S]{0,120}(?:上一轮|前几轮)[\s\S]{0,120}(?:本轮|交接文档)|(?:前几轮|此前)[\s\S]{0,40}交接文档[\s\S]{0,100}(?:未细看|尚未审查|未完成审查)/,
  /用户\s*(?:回忆|追问)[\s\S]{0,120}(?:查了|查阅|查看|翻阅|翻看)[\s\S]{0,100}交接文档|(?:查了|查阅|翻阅|翻看)[\s\S]{0,100}交接文档[\s\S]{0,160}(?:未找到|未查明|没有\s*留下)[\s\S]{0,80}(?:具体情形|具体问题|复现线索|此前反馈|报障细节)/,
  /用户\s*(?:拍板|否决)[\s\S]{0,100}(?:勿再实现|本轮曾)|本轮\s*(?:曾|已)(?:做出|实现)[\s\S]{0,120}被用户(?:明确)?否决/,
);
const privateLocation = /\b[A-Za-z]:[\\/]+(?:NONAME-KIT-TEST|deepseek-harness|codex|wms)(?:[\\/]+|\b)|\.codex[\\/]+(?:attachments|logs|sessions)\b|\.agents[\\/]+logs\b/i;
const userHome = /\b[A-Za-z]:[\\/]+Users[\\/]+(?!<|\$|%|\{)[^\\/\s'"<>]+/i;
const roleRecord = /^\s*(?:#{1,6}\s*)?(?:User|Assistant|System|Developer|用户|助手)\s*[:：]/i;
const secretFormats = [
  ['PRIVATE_KEY', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/],
  ['TOKEN_FORMAT', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|npm_[A-Za-z0-9]{30,})\b/],
  ['JWT_LITERAL', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['AUTH_IN_URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/"'<>:]+:[^\s/"'<>@]+@[^\s/"'<>]+/i],
  ['BEARER_LITERAL', /\bBearer\s+[A-Za-z0-9_.-]{20,}/],
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const guardFiles = ['scripts/privacy-check.mjs', 'scripts/privacy-policy.json', 'scripts/install-privacy-hooks.mjs', '.githooks/pre-commit', '.githooks/pre-push', '.githooks/commit-msg', '.github/workflows/privacy.yml', 'scripts/test-privacy-process.mjs'];
export const canonicalDigest = bytes => digest(Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n')));
const documentPath = file => /\.(?:md|markdown|mdx|txt|rst|adoc|org)$/i.test(file);
function approved(table, file, bytes) {
  const value = table?.[file], entries = Array.isArray(value) ? value : [value];
  return entries.some(entry => entry?.sha256 === digest(bytes) && typeof entry.reason === 'string' && entry.reason.trim());
}
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
    || /(?:^|\/)(?:B\d+(?:-B\d+)?-(?:ACCEPTANCE|SAFETY|REVIEW-FIX|REVIEW-HANDOFF|PAUSED)|DEV-STATUS|IMPLEMENTATION-PLAN|PROJECT-DECISIONS)\.(?:md|txt|json)$/i.test(normalized)
    || /(?:^|\/)(?:nnk-bridge|noname-kit(?:\.tasks)?)\.json$/i.test(normalized)
    || /(?:^|\/)\.env(?:\..*)?$/i.test(normalized) && !/(?:^|\/)\.env\.example$/i.test(normalized)) add(0, 'PRIVATE_FILE');
  let binary = bytes.includes(0) || /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|pdf|zip|gz|tar|7z|woff2?|ttf|exe|dll|bin|mp4|webm|mp3|wav)$/i.test(normalized);
  if (!binary) { try { new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch (error) { if (!(error instanceof TypeError)) throw error; binary = true; } }
  if (binary) {
    if (!approved(policy.reviewedBinary, normalized, bytes)) add(0, 'BINARY_REVIEW_REQUIRED');
    return findings;
  }
  const text = bytes.toString('utf8'), lines = text.split(/\r?\n/);
  if (documentPath(normalized) && !approved(policy.reviewedText, normalized, bytes)) add(0, 'DOCUMENT_REVIEW_REQUIRED');
  // Role-shaped source fields are not transcripts; explicit process prose in
  // comments and string literals still receives the same semantic checks.
  const source = /\.(?:[cm]?js|[cm]?ts|tsx|jsx|json|ya?ml|sh|ps1|css|html)$/i.test(normalized) || normalized.startsWith('.githooks/');
  if (processPatterns.some(pattern => pattern.test(text))) add(0, 'PRIVATE_AI_PROCESS');
  if (/\.(?:json|jsonl)$/i.test(normalized)) {
    let document;
    try { document = normalized.toLowerCase().endsWith('.jsonl') ? lines.filter(line => line.trim()).map(line => JSON.parse(line)) : JSON.parse(text); }
    catch (error) { document = null; /* Malformed/non-JSON data still receives all text checks. */ }
    const messages = Array.isArray(document) ? document : document?.messages;
    if (Array.isArray(messages) && messages.filter(message => ['user', 'assistant', 'system', 'developer'].includes(message?.role) && typeof message?.content === 'string').length >= 2) {
      if (!approved(policy.reviewedConversations, normalized, bytes)) add(0, 'RAW_CONVERSATION');
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (privateLocation.test(line) || userHome.test(line)) add(i + 1, 'PRIVATE_LOCAL_PATH');
    if ((!source || /^\s*(?:\/\/|\/\*|\* |# )/.test(line)) && roleRecord.test(line.replace(/^\s*(?:\/\/|\/\*|\* |# )\s*/, ''))) add(i + 1, 'RAW_CONVERSATION');
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
  const reviewedSource = /^scripts\/(?:privacy-check|test-privacy)\.mjs$/.test(normalized) && approved(policy.reviewedSource, normalized, bytes);
  return reviewedSource ? findings.filter(finding => finding.category !== 'PRIVATE_AI_PROCESS') : findings;
}
function git(repo, args, input) {
  return execFileSync('git', args, {cwd: repo, env: {...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1'}, input, maxBuffer: 128 * 1024 * 1024, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
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
      const end = buffer.indexOf(10, offset), header = buffer.subarray(offset, end).toString('ascii').split(' ');
      if (end < 0 || header[1] === 'missing' || !/^\d+$/.test(header[2])) throw Error('Missing Git object');
      const size = Number(header[2]);
      if (end + 1 + size >= buffer.length) throw Error('Incomplete Git object');
      objects.set(oid, {type: header[1], bytes: buffer.subarray(end + 1, end + 1 + size)});
      offset = end + 2 + size;
    }
  }
  return objects;
}
export function readPolicy(file = fileURLToPath(new URL('./privacy-policy.json', import.meta.url))) {
  const policy = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (policy.version !== 2 || !policy.reviewedText || !policy.reviewedBinary) throw Error('Unsupported privacy policy');
  for (const table of [policy.reviewedText, policy.reviewedBinary, policy.reviewedSource || {}, policy.reviewedConversations || {}]) for (const [name, value] of Object.entries(table)) {
    if (name.includes('\\') || path.isAbsolute(name) || name.split('/').includes('..')) throw Error('Invalid review path');
    const values = Array.isArray(value) ? value : [value];
    if (!values.length || values.some(item => !/^[a-f0-9]{64}$/.test(item?.sha256 || '') || typeof item.reason !== 'string' || !item.reason.trim())) throw Error('Invalid review entry');
  }
  return policy;
}
export function parsePushInput(input) {
  const updates = [];
  for (const line of input.split(/\r?\n/).filter(Boolean)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(fields[1]) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(fields[3])) throw Error('Invalid pre-push input');
    updates.push({localRef: fields[0], oid: fields[1], remoteRef: fields[2], oldOid: fields[3]});
  }
  return updates;
}
export function runCheck({repo = process.cwd(), mode = 'tracked', allObjects = false, pushInput = '', messageBytes = null, policy = readPolicy()} = {}) {
  if (!['tracked', 'staged', 'history', 'push', 'message'].includes(mode)) throw Error('Invalid scan mode');
  if (mode === 'message' && !Buffer.isBuffer(messageBytes)) throw Error('Pending commit message required');
  const isBare = git(repo, ['rev-parse', '--is-bare-repository']).toString('utf8').trim() === 'true';
  if (!isBare) repo = git(repo, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  if (isBare && !['history', 'push'].includes(mode)) throw Error('Working tree required');
  const findings = [], locations = new Map(), commits = new Set(), tags = new Set();
  const manifestFile = fileURLToPath(new URL('./guard-manifest.json', import.meta.url));
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  const add = (file, category) => findings.push({file, line: 0, category});
  const result = () => {
    const unique = [...new Map(findings.map(f => [f.file + '\0' + f.line + '\0' + f.category, f])).values()];
    return {ok: unique.length === 0, mode, allObjects, filesOrBlobs: locations.size, commits: commits.size, tags: tags.size, findings: unique};
  };
  const remember = (oid, file) => { if (!locations.has(oid)) locations.set(oid, new Set()); locations.get(oid).add(file); };
  const history = mode === 'history' || mode === 'push';
  if (history) {
    if (git(repo, ['rev-parse', '--is-shallow-repository']).toString('utf8').trim() === 'true') { add('<history>', 'SHALLOW_HISTORY'); return result(); }
    const grafts = git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'info/grafts']).toString('utf8').trim();
    if (fs.existsSync(grafts) && fs.readFileSync(grafts, 'utf8').trim()) { add('<history>', 'GRAFTED_HISTORY'); return result(); }
    const roots = new Set(), branchRoots = new Set();
    if (mode === 'push') {
      for (const update of parsePushInput(pushInput)) {
        if (/^0+$/.test(update.oid)) continue;
        if (!/^refs\/(?:heads|tags)\/.+/.test(update.remoteRef)) { add(update.remoteRef, 'UNSUPPORTED_PUSH_REF'); continue; }
        roots.add(update.oid);
        if (update.remoteRef.startsWith('refs/heads/')) branchRoots.add(update.oid);
      }
    } else {
      for (const oid of git(repo, ['for-each-ref', '--format=%(objectname)']).toString('utf8').trim().split(/\r?\n/).filter(Boolean)) roots.add(oid);
      try { roots.add(git(repo, ['rev-parse', '--verify', 'HEAD']).toString('utf8').trim()); } catch (error) { if (error.status !== 128) throw error; }
    }
    const tips = new Set();
    function peel(oid) {
      const object = batchObjects(repo, [oid]).get(oid);
      if (object.type === 'commit') { tips.add(oid); return; }
      if (object.type !== 'tag') { add('object:' + oid, 'UNSUPPORTED_REF_OBJECT'); return; }
      if (tags.has(oid)) return;
      tags.add(oid);
      const text = object.bytes.toString('utf8'), separator = text.indexOf('\n\n');
      findings.push(...inspectBytes('tag:' + oid, Buffer.from(separator < 0 ? text : text.slice(separator + 2)), policy));
      const target = /^object ([a-f0-9]{40}|[a-f0-9]{64})\n/.exec(text);
      if (!target) throw Error('Invalid tag target');
      peel(target[1]);
    }
    for (const oid of roots) peel(oid);
    if (manifest) for (const oid of branchRoots) {
      const entries = new Map(git(repo, ['ls-tree', '-r', '-z', '--full-tree', oid]).toString('utf8').split('\0').filter(Boolean).map(row => {
        const match = /^\d+ blob ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
        return match ? [match[2], match[1]] : ['', ''];
      }));
      for (const name of guardFiles) {
        const object = entries.get(name);
        if (!object || canonicalDigest(batchObjects(repo, [object]).get(object).bytes) !== manifest[name]) add(name, 'GUARD_UPDATE_REQUIRES_INSTALLATION');
      }
    }
    if (tips.size) for (const oid of git(repo, ['rev-list', '--stdin'], [...tips].join('\n') + '\n').toString('utf8').trim().split(/\r?\n/).filter(Boolean)) commits.add(oid);
    if (allObjects) {
      for (const row of git(repo, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']).toString('utf8').trim().split(/\r?\n/).filter(Boolean)) {
        const [oid, type] = row.split(' ');
        if (type === 'commit') commits.add(oid);
        if (type === 'tag') peel(oid);
        if (type === 'blob') remember(oid, '<unreferenced-blob>');
      }
    }
    for (const commit of commits) {
      for (const entry of git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit]).toString('utf8').split('\0').filter(Boolean)) {
        const match = /^(\d+) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
        if (!match) throw Error('Invalid tree entry');
        if (match[2] === 'commit') add(match[4], 'GITLINK_REVIEW_REQUIRED');
        else { remember(match[3], match[4]); locations.get(match[3]).delete('<unreferenced-blob>'); }
      }
    }
    for (const [oid, object] of batchObjects(repo, [...commits])) {
      const text = object.bytes.toString('utf8');
      findings.push(...inspectBytes('commit:' + oid, Buffer.from(text.slice(text.indexOf('\n\n') + 2)), policy));
    }
  } else {
    const entries = indexEntries(repo);
    // Installed hooks trust only their reviewed metadata snapshot, never a
    // policy or replacement checker supplied in the pending index.
    if (manifest) {
      for (const name of guardFiles) {
        const entry = entries.find(item => item.file === name && !item.stage);
        if (!entry || canonicalDigest(batchObjects(repo, [entry.oid]).get(entry.oid).bytes) !== manifest[name]) add(name, 'GUARD_UPDATE_REQUIRES_INSTALLATION');
      }
    }
    if (mode === 'message') {
      findings.push(...inspectBytes('<pending-commit-message>', messageBytes, policy));
      return result();
    }
    for (const entry of entries) {
      if (entry.stage) { add(entry.file, 'UNMERGED_INDEX'); continue; }
      if (entry.mode === '160000') { add(entry.file, 'GITLINK_REVIEW_REQUIRED'); continue; }
      if (mode === 'staged') remember(entry.oid, entry.file);
      else {
        const target = path.join(repo, entry.file);
        if (!fs.existsSync(target)) { add(entry.file, 'MISSING_TRACKED_FILE'); continue; }
        const data = fs.lstatSync(target).isSymbolicLink() ? Buffer.from(fs.readlinkSync(target)) : fs.readFileSync(target);
        findings.push(...inspectBytes(entry.file, data, policy)); remember(digest(data), entry.file);
      }
    }
  }
  if (mode !== 'tracked') for (const [oid, object] of batchObjects(repo, [...locations.keys()])) {
    if (object.type !== 'blob') throw Error('Expected blob');
    for (const name of locations.get(oid)) findings.push(...inspectBytes(name, object.bytes, policy));
  }
  return result();
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), modes = ['--tracked', '--staged', '--history', '--pre-push'];
    let messageFile = null;
    const messageIndex = args.indexOf('--commit-msg');
    if (messageIndex >= 0) {
      messageFile = args[messageIndex + 1];
      if (!messageFile || messageFile.startsWith('--')) throw Error('Pending commit message file required');
      args.splice(messageIndex, 2);
    }
    if (args.some(arg => ![...modes, '--all-objects', '--json'].includes(arg)) || args.filter(arg => modes.includes(arg)).length + (messageFile !== null ? 1 : 0) > 1) throw Error('Choose one scan mode');
    if (args.includes('--all-objects') && !args.includes('--history')) throw Error('--all-objects requires --history');
    const mode = messageFile !== null ? 'message' : args.includes('--pre-push') ? 'push' : args.includes('--history') ? 'history' : args.includes('--staged') ? 'staged' : 'tracked';
    const result = runCheck({mode, allObjects: args.includes('--all-objects'), pushInput: mode === 'push' ? fs.readFileSync(0, 'utf8') : '', messageBytes: mode === 'message' ? fs.readFileSync(messageFile) : null});
    if (args.includes('--json')) console.log(JSON.stringify(result));
    else {
      for (const finding of result.findings) console.error(finding.file + ':' + finding.line + ' ' + finding.category);
      console.log('Privacy ' + mode + ': ' + (result.ok ? 'PASS' : 'FAIL') + '; ' + result.filesOrBlobs + ' files/blobs, ' + result.commits + ' commits, ' + result.tags + ' tags, ' + result.findings.length + ' findings');
    }
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error('Privacy check could not complete: ' + (error?.code || error?.name || 'Error'));
    process.exitCode = 2;
  }
}
