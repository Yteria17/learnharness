#!/usr/bin/env node
// Manual, whole-profile sync. Close LearnHarness on this computer first.
// The remote store runs only for an SSH request; no public web service.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAX_DATA = 1024 * 1024 * 1024;
const MAX_FILE = 50 * 1024 * 1024;
const GRAPH = new Set(['nodes.jsonl', 'chains.jsonl', 'sessions.jsonl', 'coverage.jsonl', 'sources.json', 'positions.json', 'render-settings.json', 'format.json']);
export function allowed(name) {
  return typeof name === 'string' && name.length <= 240 && (name === 'settings.json'
    || /^attachments\/[a-f0-9]{64}\.bin$/.test(name) || /^documents\/[a-f0-9]{64}\.json$/.test(name)
    || /^chats\/[A-Za-z0-9_-]+\.json$/.test(name)
    || (name.startsWith('graph/') && GRAPH.has(name.slice(6)))
    || /^prompts\/(?:[a-z][a-z0-9_-]*\/)?[A-Za-z0-9_-]+\.md$/.test(name));
}
export function manifestOf(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length > 20000) throw new Error('Invalid file map');
  let size = 0;
  const manifest = Object.create(null);
  for (const name of Object.keys(files).sort()) {
    const content = files[name];
    if (!allowed(name) || typeof content !== 'string') throw new Error('Unsupported sync file');
    const data = Buffer.from(content, 'base64');
    if (data.toString('base64') !== content) throw new Error('Invalid base64');
    size += data.length;
    if (data.length > MAX_FILE) throw new Error('File exceeds 50 MiB');
    if (size > MAX_DATA) throw new Error('Profile exceeds 1 GiB');
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    if (name.startsWith('attachments/') && name !== `attachments/${hash}.bin`) throw new Error('Attachment integrity check failed');
    manifest[name] = { hash, size: data.length };
  }
  return manifest;
}
export function revisionOf(files) {
  return crypto.createHash('sha256').update(JSON.stringify(manifestOf(files))).digest('hex');
}

/** Upgrade inline screenshots once. Keep the pre-migration record locally. */
export function migrateImages(directory) {
  const chats = path.join(directory, 'chats');
  if (!fs.existsSync(chats) || fs.lstatSync(chats).isSymbolicLink()) return;
  const convert = (value) => {
    if (Array.isArray(value)) return value.map(convert);
    if (!value || typeof value !== 'object') return value;
    if (value.type === 'image' && typeof value.mimeType === 'string' && typeof value.data === 'string' && value.data && Buffer.from(value.data, 'base64').toString('base64') === value.data) {
      const bytes = Buffer.from(value.data, 'base64');
      const id = crypto.createHash('sha256').update(bytes).digest('hex');
      const target = path.join(directory, 'attachments', id + '.bin');
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      if (fs.lstatSync(path.dirname(target)).isSymbolicLink()) throw new Error('Symlinks are not supported');
      if (!fs.existsSync(target)) fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
      const { data, ...rest } = value;
      return { ...rest, attachmentId: id };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, convert(item)]));
  };
  for (const name of fs.readdirSync(chats).sort()) {
    if (!/^[A-Za-z0-9_-]+\.json$/.test(name)) continue;
    const file = path.join(chats, name);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Symlinks are not supported');
    const original = fs.readFileSync(file, 'utf8');
    let record;
    try { record = JSON.parse(original); } catch { continue; }
    if (!record || typeof record !== 'object' || (record.version ?? 1) > 2) continue;
    const migrated = convert(record);
    if (JSON.stringify(record) === JSON.stringify(migrated)) continue;
    migrated.version = 2;
    const backup = path.join(path.dirname(directory), 'attachment-migration-backups', crypto.createHash('sha256').update(original).digest('hex') + '.json');
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, { flag: 'wx', mode: 0o600 });
    atomicJSON(file, migrated);
  }
}
function assertReferences(files) {
  const check = value => {
    if (Array.isArray(value)) { value.forEach(check); return; }
    if (!value || typeof value !== 'object') return;
    if (typeof value.attachmentId === 'string' && (!/^[a-f0-9]{64}$/.test(value.attachmentId) || files[`attachments/${value.attachmentId}.bin`] === undefined)) throw new Error('Missing attachment: ' + value.attachmentId);
    Object.values(value).forEach(check);
  };
  for (const [name, value] of Object.entries(files)) {
    if (!name.startsWith('chats/') && !name.startsWith('documents/')) continue;
    let parsed; try { parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8')); } catch { continue; }
    check(parsed);
  }
}
export function snapshot(directory) {
  migrateImages(directory);
  const files = Object.create(null);
  function walk(current, prefix = '') {
    if (!fs.existsSync(current)) return;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symlinks are not supported in the sync profile');
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const name = prefix + item.name;
      const absolute = path.join(current, item.name);
      const relevant = allowed(name) || ['chats', 'graph', 'prompts', 'attachments', 'documents'].includes(name) || /^prompts\/[a-z][a-z0-9_-]*$/.test(name);
      if (!relevant) continue;
      if (item.isSymbolicLink()) throw new Error('Symlinks are not supported in the sync profile');
      if (item.isDirectory()) walk(absolute, name + '/');
      else if (item.isFile() && allowed(name)) files[name] = fs.readFileSync(absolute).toString('base64');
    }
  }
  walk(directory);
  assertReferences(files);
  return { files, revision: revisionOf(files) };
}
export function defaultDataDirectory() {
  const profile = process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support')
    : process.platform === 'win32' ? process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming')
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(profile, 'LearnHarness', 'data');
}
export function assertAppClosed() {
  // Use executable names, never command-line text (which could contain this script).
  const windows = process.platform === 'win32';
  const processes = execFileSync(windows ? 'tasklist.exe' : 'ps', windows ? ['/FO', 'CSV', '/NH'] : ['-axo', 'comm='], { encoding: 'utf8' });
  const running = processes.split(/\r?\n/).some((line) => windows
    ? /^"LearnHarness\.exe",/i.test(line)
    : /(?:^|\/)(?:LearnHarness|learnharness)(?:\.app\/Contents\/MacOS\/LearnHarness)?$/.test(line.trim()));
  if (running) throw new Error('Quit LearnHarness completely before synchronizing.');
}
export function remote(host, request) {
  if (!/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(host)) throw new Error('Invalid SSH host');
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', host, 'python3 .local/share/learnharness-sync/sync-store.py'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out = []; const err = []; let size = 0;
    const timer = setTimeout(() => child.kill(), 120000);
    child.stdout.on('data', (chunk) => { size += chunk.length; if (size > 96 * 1024 * 1024) child.kill(); else out.push(chunk); });
    child.stderr.on('data', (chunk) => { if (err.reduce((n, c) => n + c.length, 0) < 8192) err.push(chunk); });
    child.stdin.on('error', () => {});
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(Buffer.concat(out).toString());
        if (code !== 0 || result.ok !== true) throw Object.assign(new Error(result.error || 'Remote sync failed'), { code: result.error === 'conflict' ? 'retry' : undefined });
        resolve(result);
      } catch (error) { reject(Object.assign(new Error(`SSH sync failed: ${Buffer.concat(err).toString().trim() || error.message}`), { code: error.code })); }
    });
    child.stdin.end(JSON.stringify({ version: 2, ...request }));
  });
}
function atomicJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
export function applySnapshot(directory, files, expectedLocal, ensureClosed = assertAppClosed) {
  revisionOf(files);
  assertReferences(files);
  if (snapshot(directory).revision !== expectedLocal) throw new Error('Local data changed during synchronization; nothing was replaced.');
  const parent = path.dirname(directory);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(parent, '.sync-stage-'));
  const backup = path.join(parent, 'sync-backups', new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID());
  let moved = false;
  try {
    // Preserve machine-local caches and unknown files locally; never upload them.
    if (fs.existsSync(directory)) fs.cpSync(directory, stage, { recursive: true, dereference: false });
    const previous = snapshot(stage).files;
    for (const name of Object.keys(previous)) fs.unlinkSync(path.join(stage, name));
    for (const [name, value] of Object.entries(files)) {
      const target = path.join(stage, name);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, Buffer.from(value, 'base64'), { mode: 0o600 });
    }
    ensureClosed();
    if (snapshot(directory).revision !== expectedLocal) throw new Error('Local data changed; synchronization cancelled.');
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
    if (fs.existsSync(directory)) { fs.renameSync(directory, backup); moved = true; }
    try { fs.renameSync(stage, directory); }
    catch (error) { if (moved) fs.renameSync(backup, directory); throw error; }
    return moved ? backup : null;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
const missing = Symbol('missing');
const equalJSON = (a, b) => a === b || (a !== missing && b !== missing && canonicalJSON(a) === canonicalJSON(b));
function canonicalJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJSON(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const object = (v) => v !== missing && v !== null && typeof v === 'object' && !Array.isArray(v);
function mergeJSON(base, local, remote) {
  if (equalJSON(local, remote)) return local;
  if (equalJSON(local, base)) return remote;
  if (equalJSON(remote, base)) return local;
  if (object(local) && object(remote) && (base === missing || object(base))) {
    const out = Object.create(null);
    for (const key of new Set([...Object.keys(base === missing ? {} : base), ...Object.keys(local), ...Object.keys(remote)])) {
      const get = (v) => v !== missing && Object.hasOwn(v, key) ? v[key] : missing;
      const value = mergeJSON(get(base), get(local), get(remote));
      if (value !== missing) out[key] = value;
    }
    return out;
  }
  throw new Error('overlapping edits');
}
function mergeLedger(base, local, remote) {
  const decode = (v) => v === undefined ? '' : Buffer.from(v, 'base64').toString('utf8');
  const b = decode(base), l = decode(local), r = decode(remote);
  if ((b && !b.endsWith('\n')) || !l.startsWith(b) || !r.startsWith(b)) throw new Error('ledger rewritten');
  const parse = (text) => text.split('\n').filter(Boolean).map((line) => ({ line, value: JSON.parse(line) }));
  const original = parse(b);
  const knownIds = new Set(original.map((x) => x.value.id).filter(Boolean));
  const left = parse(l.slice(b.length)), right = parse(r.slice(b.length));
  const firstIds = (rows) => {
    const ids = new Map();
    for (const row of rows) if (row.value.id && !knownIds.has(row.value.id) && !ids.has(row.value.id)) ids.set(row.value.id, row.line);
    return ids;
  };
  const leftIds = firstIds(left), rightIds = firstIds(right);
  for (const [id, line] of leftIds) if (rightIds.has(id) && rightIds.get(id) !== line) throw new Error('conflicting new ledger identity');
  const seen = new Set(original.map((x) => x.line));
  const additions = [];
  // Preserve each writer's append order; order the two branches deterministically.
  const branches = [left, right].sort((a, z) => {
    const x = canonicalJSON(a.map((v) => v.line)), y = canonicalJSON(z.map((v) => v.line));
    return x < y ? -1 : x > y ? 1 : 0;
  });
  for (const branch of branches) for (const { line } of branch) if (!seen.has(line)) { seen.add(line); additions.push(line); }
  return Buffer.from(b + (additions.length ? additions.join('\n') + '\n' : '')).toString('base64');
}
export function mergeSnapshots(base, local, remote) {
  revisionOf(base); revisionOf(local); revisionOf(remote);
  const files = Object.create(null);
  for (const name of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
    const b = base[name], l = local[name], r = remote[name];
    let value;
    if (l === r) value = l;
    else if (l === b) value = r;
    else if (r === b) value = l;
    else {
      try {
        if (name.startsWith('graph/') && name.endsWith('.jsonl') && l !== undefined && r !== undefined) value = mergeLedger(b, l, r);
        else if ((name === 'settings.json' || /^graph\/.*\.json$/.test(name)) && l !== undefined && r !== undefined) {
          const parse = (v) => v === undefined ? missing : JSON.parse(Buffer.from(v, 'base64').toString('utf8'));
          value = Buffer.from(JSON.stringify(mergeJSON(parse(b), parse(l), parse(r)), null, '\t')).toString('base64');
        } else throw new Error('overlapping edits');
      } catch { throw Object.assign(new Error(`Conflict in ${name}: both computers changed the same data. Neither local copy was replaced.`), { code: 'conflict' }); }
    }
    if (value !== undefined) files[name] = value;
  }
  return { files, revision: revisionOf(files) };
}

function batches(names, manifest) {
  const result = []; let batch = [], size = 0;
  for (const name of names) {
    if (batch.length && size + manifest[name].size > 32 * 1024 * 1024) { result.push(batch); batch = []; size = 0; }
    batch.push(name); size += manifest[name].size;
  }
  if (batch.length) result.push(batch);
  return result;
}

/** Transfer only changed files over the local desktop API too (96 MiB proxy cap). */
export async function installLiveSnapshot(files, expected, previous, request) {
  const transaction = crypto.randomUUID();
  const manifest = manifestOf(files);
  const changed = Object.keys(files).filter(name => files[name] !== previous[name]);
  try {
    for (const names of batches(changed, manifest)) {
      await request({ op: 'stage', transaction, files: Object.fromEntries(names.map(name => [name, files[name]])) });
    }
    return await request({ op: 'commit', transaction, manifest, expected });
  } finally { await request({ op: 'discard', transaction }).catch(() => {}); }
}

async function synchronizeUnlocked({ host, directory, statusOnly = false, transport = remote, ensureClosed = assertAppClosed,
  capture = async () => snapshot(directory), install = async (files, expected) => applySnapshot(directory, files, expected, ensureClosed), live = false }) {
  if (!statusOnly) ensureClosed();
  const local = await capture();
  if (revisionOf(local.files) !== local.revision) throw new Error('Local snapshot failed validation');
  const stateFile = path.join(path.dirname(directory), 'ssh-sync-state.json');
  let state = null;
  if (fs.existsSync(stateFile)) {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (![1, 2].includes(state.version) || state.host !== host || !/^[a-f0-9]{64}$/.test(state.revision)) throw new Error('Sync state belongs to another server or is invalid.');
  }
  const head = await transport(host, { op: 'head' });
  if (head.version !== 2 || !head.manifest || typeof head.manifest !== 'object') throw new Error('Update the SSH sync server to use this version of LearnHarness.');
  const latestFiles = Object.create(null);
  const needed = [];
  for (const [name, info] of Object.entries(head.manifest)) {
    if (!allowed(name) || !info || !/^[a-f0-9]{64}$/.test(info.hash) || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_FILE) throw new Error('Invalid remote manifest');
    const cached = [local.files[name], state?.files?.[name]].find(value => value !== undefined && crypto.createHash('sha256').update(Buffer.from(value, 'base64')).digest('hex') === info.hash);
    if (cached !== undefined) latestFiles[name] = cached;
    else needed.push(name);
  }
  for (const names of batches(needed, head.manifest)) {
    const result = await transport(host, { op: 'get', revision: head.revision, names });
    if (result.revision !== head.revision || !result.files || Object.keys(result.files).length !== names.length) throw Object.assign(new Error('Remote files changed during synchronization; retry.'), { code: 'retry' });
    for (const name of names) {
      const value = result.files[name];
      if (typeof value !== 'string' || Buffer.from(value, 'base64').toString('base64') !== value) throw new Error('Invalid remote content');
      const bytes = Buffer.from(value, 'base64');
      if (bytes.length !== head.manifest[name].size || crypto.createHash('sha256').update(bytes).digest('hex') !== head.manifest[name].hash) throw new Error('Remote content failed integrity check');
      latestFiles[name] = value;
    }
  }
  const latest = { version: 2, revision: head.revision, files: latestFiles };
  if ((latest.revision !== null && revisionOf(latest.files) !== latest.revision)
    || (latest.revision === null && Object.keys(latest.files).length !== 0)) throw new Error('Remote snapshot failed validation');
  let merged;
  if (latest.revision === local.revision) merged = local;
  else if (latest.revision === null) {
    if (state) throw new Error('The server lost its sync history. Restore it before continuing.');
    merged = local;
  } else if (!state) {
    if (Object.keys(local.files).length === 0) merged = { files: latest.files, revision: latest.revision };
    else throw new Error('Both this computer and the server contain data, with no shared sync history. Neither copy was overwritten.');
  } else {
    const base = state.files ?? (latest.revision === state.revision ? latest.files : local.revision === state.revision ? local.files : null);
    if (!base) throw new Error('Conflict: the previous sync has no common file history. Neither copy was overwritten.');
    merged = mergeSnapshots(base, local.files, latest.files);
  }
  assertReferences(merged.files);
  const upload = merged.revision !== latest.revision;
  const download = merged.revision !== local.revision;
  const direction = upload && download ? 'merge' : upload ? 'upload' : download ? 'download' : 'unchanged';
  if (statusOnly) return { direction, localFiles: Object.keys(local.files).length, remoteFiles: Object.keys(latest.files).length };
  const revision = merged.revision;
  let backup = null;
  if (upload) {
    if (!live && (await capture()).revision !== local.revision) throw new Error('Local data changed; upload cancelled.');
    const manifest = manifestOf(merged.files);
    const changed = Object.keys(manifest).filter(name => manifest[name].hash !== head.manifest[name]?.hash);
    for (const names of batches(changed, manifest)) {
      await transport(host, { op: 'objects', files: Object.fromEntries(names.map(name => [name, merged.files[name]])) });
    }
    const saved = await transport(host, { op: 'put', expected: latest.revision, manifest });
    if (saved.revision !== revision) throw new Error('Remote upload was not confirmed.');
    // Acknowledge this immutable local checkpoint even if a busy writer defers
    // importing the peer's changes. New local edits will rebase on this checkpoint.
    atomicJSON(stateFile, { version: 2, host, revision, files: local.files });
  }
  if (download) backup = await install(merged.files, local.revision);
  atomicJSON(stateFile, { version: 2, host, revision, files: merged.files });
  return { direction, revision, backup };
}

export async function synchronize(options) {
  if (options.statusOnly) return synchronizeUnlocked(options);
  const parent = path.dirname(options.directory);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const lock = path.join(parent, 'ssh-sync.lock');
  let descriptor;
  try { descriptor = fs.openSync(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another synchronization is running, or a previous run was interrupted. Check it has stopped before removing ssh-sync.lock.');
    throw error;
  }
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await synchronizeUnlocked(options);
  } finally { fs.closeSync(descriptor); fs.unlinkSync(lock); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] !== 'sync' && args[0] !== 'status') throw new Error('Usage: node sync-data.mjs sync|status --host USER@HOST [--data DIRECTORY]');
    const options = {};
    for (let i = 1; i < args.length; i += 2) {
      if (!['--host', '--data'].includes(args[i]) || !args[i + 1]) throw new Error('Invalid option');
      options[args[i]] = args[i + 1];
    }
    const directory = path.resolve(options['--data'] || defaultDataDirectory());
    const configFile = path.join(path.dirname(directory), 'desktop-sync.json');
    const savedHost = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')).host : null;
    const host = options['--host'] || savedHost;
    if (!host) throw new Error('Configure Settings → Sync first, or pass --host USER@HOST.');
    const result = await synchronize({ host, directory, statusOnly: args[0] === 'status' });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
