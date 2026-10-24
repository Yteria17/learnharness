import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshot, revisionOf, manifestOf, mergeSnapshots, applySnapshot, synchronize as synchronizeProfile } from './sync-data.mjs';

// Test profiles are disposable and cannot belong to a running desktop app.
const synchronize = (options) => synchronizeProfile({ ...options, ensureClosed: () => {} });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-sync-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'data');
  fs.mkdirSync(path.join(directory, 'chats'), { recursive: true });
  return { root, directory };
}
function put(directory, name, content) {
  fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
  fs.writeFileSync(path.join(directory, name), content);
}
function store() {
  const objects = new Map();
  let latest = { ok: true, version: 2, revision: null, files: {} };
  return {
    get latest() { return latest; },
    transport: async (_host, request) => {
      if (request.op === 'get') return { ...structuredClone(latest), files: Object.fromEntries(request.names.map(name => [name, latest.files[name]])) };
      if (request.op === 'objects') { for (const [name, data] of Object.entries(request.files)) objects.set(manifestOf({[name]: data})[name].hash, data); return {ok:true}; }
      if (request.op === 'head') return { ok: true, version: 2, revision: latest.revision, manifest: manifestOf(latest.files) };
      if (request.expected !== latest.revision) throw new Error('conflict');
      latest = { ok: true, version: 2, files: Object.fromEntries(Object.entries(request.manifest).map(([name, info]) => [name, objects.get(info.hash)])), revision: null };
      latest.revision = revisionOf(latest.files);
      return { ok: true, revision: latest.revision };
    },
  };
}
test('only learning data is uploaded; credentials, logs, and jobs stay local', async (t) => {
  const { directory } = fixture(t); const server = store();
  put(directory, 'chats/chat_1.json', '{"messages":[]}');
  put(directory, 'auth.json', 'secret');
  put(directory, 'chatgpt-credentials.enc.json', 'secret');
  put(directory, 'chatgpt-credentials.json', 'secret');
  put(directory, 'jobs/pending.json', '{}');
  put(directory, 'debug/events.jsonl', 'private');
  const result = await synchronize({ host: 'test', directory, transport: server.transport });
  assert.equal(result.direction, 'upload');
  assert.deepEqual(Object.keys(server.latest.files), ['chats/chat_1.json']);
});
test('another computer downloads a profile, preserves local cache, and keeps a backup', async (t) => {
  const first = fixture(t); const second = fixture(t); const server = store();
  put(first.directory, 'chats/chat_1.json', '{"messages":[1]}');
  await synchronize({ host: 'test', directory: first.directory, transport: server.transport });
  put(second.directory, 'cache/local.bin', 'local-only');
  const result = await synchronize({ host: 'test', directory: second.directory, transport: server.transport });
  assert.equal(result.direction, 'download');
  assert.equal(fs.readFileSync(path.join(second.directory, 'chats/chat_1.json'), 'utf8'), '{"messages":[1]}');
  assert.equal(fs.readFileSync(path.join(second.directory, 'cache/local.bin'), 'utf8'), 'local-only');
  assert.ok(fs.existsSync(result.backup));
});
test('independent edits conflict without changing either profile or server', async (t) => {
  const a = fixture(t); const b = fixture(t); const server = store();
  put(a.directory, 'chats/chat_1.json', 'original');
  await synchronize({ host: 'test', directory: a.directory, transport: server.transport });
  await synchronize({ host: 'test', directory: b.directory, transport: server.transport });
  put(a.directory, 'chats/chat_1.json', 'edited A');
  put(b.directory, 'chats/chat_1.json', 'edited B');
  await synchronize({ host: 'test', directory: a.directory, transport: server.transport });
  const remoteBefore = server.latest.revision;
  await assert.rejects(synchronize({ host: 'test', directory: b.directory, transport: server.transport }), /Conflict/);
  assert.equal(snapshot(b.directory).files['chats/chat_1.json'], Buffer.from('edited B').toString('base64'));
  assert.equal(server.latest.revision, remoteBefore);
});
test('remote deletion propagates with previous local contents preserved in backup', async (t) => {
  const a = fixture(t); const b = fixture(t); const server = store();
  put(a.directory, 'chats/chat_1.json', 'original');
  await synchronize({ host: 'test', directory: a.directory, transport: server.transport });
  await synchronize({ host: 'test', directory: b.directory, transport: server.transport });
  fs.unlinkSync(path.join(a.directory, 'chats/chat_1.json'));
  await synchronize({ host: 'test', directory: a.directory, transport: server.transport });
  const result = await synchronize({ host: 'test', directory: b.directory, transport: server.transport });
  assert.equal(fs.existsSync(path.join(b.directory, 'chats/chat_1.json')), false);
  assert.equal(fs.readFileSync(path.join(result.backup, 'chats/chat_1.json'), 'utf8'), 'original');
});
test('first connection refuses to replace a nonempty unrelated profile', async (t) => {
  const a = fixture(t); const b = fixture(t); const server = store();
  put(a.directory, 'chats/chat_1.json', 'A');
  put(b.directory, 'chats/chat_2.json', 'B');
  await synchronize({ host: 'test', directory: a.directory, transport: server.transport });
  await assert.rejects(synchronize({ host: 'test', directory: b.directory, transport: server.transport }), /no shared sync history/);
  assert.equal(fs.readFileSync(path.join(b.directory, 'chats/chat_2.json'), 'utf8'), 'B');
});
test('symlinks, traversal and noncanonical payloads are rejected', (t) => {
  const { directory, root } = fixture(t);
  fs.writeFileSync(path.join(root, 'secret'), 'private');
  fs.symlinkSync(path.join(root, 'secret'), path.join(directory, 'chats/chat_1.json'));
  assert.throws(() => snapshot(directory), /Symlinks/);
  assert.throws(() => revisionOf({ '../auth.json': 'YQ==' }), /Unsupported/);
  assert.throws(() => revisionOf({ 'settings.json': 'YQ' }), /base64/);
});
test('status does not upload or write a local sync state', async (t) => {
  const { directory, root } = fixture(t); const server = store();
  put(directory, 'chats/chat_1.json', 'original');
  const result = await synchronize({ host: 'test', directory, transport: server.transport, statusOnly: true });
  assert.equal(result.direction, 'upload');
  assert.equal(server.latest.revision, null);
  assert.equal(fs.existsSync(path.join(root, 'ssh-sync-state.json')), false);
});
test('the app-running guard prevents transfers and releases the local lock', async (t) => {
  const { directory, root } = fixture(t);
  let requested = false;
  await assert.rejects(synchronizeProfile({ host: 'test', directory,
    ensureClosed: () => { throw new Error('app is running'); },
    transport: async () => { requested = true; },
  }), /app is running/);
  assert.equal(requested, false);
  assert.equal(fs.existsSync(path.join(root, 'ssh-sync.lock')), false);
});

const encoded = (text) => Buffer.from(text).toString('base64');
test('separate sessions edited on two computers merge and converge', async (t) => {
  const a = fixture(t), b = fixture(t), server = store();
  put(a.directory, 'chats/shared.json', 'shared');
  await synchronize({ host: 'test', directory: a.directory, transport: server.transport });
  await synchronize({ host: 'test', directory: b.directory, transport: server.transport });
  put(a.directory, 'chats/a.json', 'A'); put(b.directory, 'chats/b.json', 'B');
  await synchronize({ host: 'test', directory: a.directory, transport: server.transport });
  assert.equal((await synchronize({ host: 'test', directory: b.directory, transport: server.transport })).direction, 'merge');
  await synchronize({ host: 'test', directory: a.directory, transport: server.transport });
  assert.equal(snapshot(a.directory).revision, snapshot(b.directory).revision);
  assert.deepEqual(Object.keys(server.latest.files).sort(), ['chats/a.json', 'chats/b.json', 'chats/shared.json']);
});
test('independent nested preferences merge without choosing one computer', () => {
  const file = 'settings.json';
  const base = { [file]: encoded('{"appearance":{"font":12},"models":{"strong":"a"}}') };
  const a = { [file]: encoded('{"appearance":{"font":14},"models":{"strong":"a"}}') };
  const b = { [file]: encoded('{"appearance":{"font":12},"models":{"strong":"b"}}') };
  const merged = mergeSnapshots(base,a,b);
  assert.deepEqual(JSON.parse(Buffer.from(merged.files[file], 'base64')), {appearance:{font:14},models:{strong:'b'}});
});
test('independent ledger appends converge in either direction', () => {
  const file = 'graph/nodes.jsonl';
  const text = '{"id":"root","statement":"root"}\n';
  const base = {[file]:encoded(text)}, a = {[file]:encoded(text+'{"id":"a","statement":"A"}\n')}, b = {[file]:encoded(text+'{"id":"b","statement":"B"}\n')};
  const ab = mergeSnapshots(base,a,b), ba = mergeSnapshots(base,b,a);
  assert.equal(ab.revision,ba.revision);
  assert.match(Buffer.from(ab.files[file], 'base64').toString(), /"id":"a"/);
  assert.match(Buffer.from(ab.files[file], 'base64').toString(), /"id":"b"/);
});
test('ledger rewrites and conflicting new identities are not silently combined', () => {
  const file = 'graph/nodes.jsonl', base = {[file]:encoded('{"id":"root"}\n')};
  assert.throws(() => mergeSnapshots(base, {[file]:encoded('')}, {[file]:encoded('{"id":"root"}\n{"id":"a"}\n')}), /Conflict/);
  assert.throws(() => mergeSnapshots({}, {[file]:encoded('{"id":"a","statement":"A"}\n')}, {[file]:encoded('{"id":"a","statement":"different"}\n')}), /Conflict/);
});
test('live upload acknowledges an immutable checkpoint while local edits continue', async (t) => {
  const a=fixture(t), server=store();
  put(a.directory,'chats/a.json','old');
  let firstPut=true;
  const transport=async (host,request)=>{
    if(request.op==='put'&&firstPut){firstPut=false;put(a.directory,'chats/a.json','new');}
    return server.transport(host,request);
  };
  await synchronize({host:'test',directory:a.directory,transport,live:true});
  assert.equal(server.latest.files['chats/a.json'],encoded('old'));
  await synchronize({host:'test',directory:a.directory,transport,live:true});
  assert.equal(server.latest.files['chats/a.json'],encoded('new'));
});
test('deferred peer import rebases newer local edits on an acknowledged checkpoint',async(t)=>{
  const a=fixture(t),b=fixture(t),server=store();
  put(a.directory,'chats/a.json','0');
  await synchronize({host:'test',directory:a.directory,transport:server.transport});
  await synchronize({host:'test',directory:b.directory,transport:server.transport});
  put(b.directory,'chats/b.json','peer');
  await synchronize({host:'test',directory:b.directory,transport:server.transport});
  put(a.directory,'chats/a.json','1');
  await assert.rejects(synchronize({host:'test',directory:a.directory,transport:server.transport,live:true,
    install:async()=>{throw Object.assign(new Error('busy'),{code:'deferred'});}}),/busy/);
  put(a.directory,'chats/a.json','2');
  await synchronize({host:'test',directory:a.directory,transport:server.transport,live:true,
    install:async(files,expected)=>applySnapshot(a.directory,files,expected,()=>{})});
  assert.equal(server.latest.files['chats/a.json'],encoded('2'));
  assert.equal(snapshot(a.directory).files['chats/b.json'],encoded('peer'));
});
test('live polls avoid downloading an unchanged full remote snapshot',async(t)=>{
  const a=fixture(t),server=store();
  put(a.directory,'chats/a.json','saved');
  await synchronize({host:'test',directory:a.directory,transport:server.transport});
  const calls=[];
  await synchronize({host:'test',directory:a.directory,live:true,transport:async(host,req)=>{calls.push(req.op);return server.transport(host,req);}});
  assert.deepEqual(calls,['head']);
});

test('incremental SSH requests upload and download only changed bytes, including deletions', async (t) => {
  const a=fixture(t),b=fixture(t),server=store();
  const blob=Buffer.alloc(1024*1024,7);
  const hash=(await import('node:crypto')).createHash('sha256').update(blob).digest('hex');
  put(a.directory,`attachments/${hash}.bin`,blob);
  put(a.directory,'chats/a.json','original');
  await synchronize({host:'test',directory:a.directory,transport:server.transport});
  await synchronize({host:'test',directory:b.directory,transport:server.transport});
  const sent=[];
  const transport=async(host,req)=>{sent.push(structuredClone(req));return server.transport(host,req);};
  put(a.directory,'chats/a.json','updated');
  await synchronize({host:'test',directory:a.directory,transport});
  assert.deepEqual(sent.filter(req=>req.op==='objects').flatMap(req=>Object.keys(req.files)),['chats/a.json']);
  assert.ok(JSON.stringify(sent).length<2000,'unchanged 1 MiB attachment is absent from every upload');
  sent.length=0;
  await synchronize({host:'test',directory:b.directory,transport});
  assert.deepEqual(sent.filter(req=>req.op==='get').flatMap(req=>req.names),['chats/a.json']);
  fs.unlinkSync(path.join(a.directory,'chats/a.json'));
  await synchronize({host:'test',directory:a.directory,transport});
  await synchronize({host:'test',directory:b.directory,transport});
  assert.equal(fs.existsSync(path.join(b.directory,'chats/a.json')),false);
  assert.deepEqual(fs.readFileSync(path.join(b.directory,`attachments/${hash}.bin`)),blob);
});

test('the real Python store exchanges portable documents and images with the JS engine',async(t)=>{
  const {spawnSync}=await import('node:child_process');
  const a=fixture(t),b=fixture(t),root=fixture(t).root;
  const source=path.join(path.dirname(new URL(import.meta.url).pathname),'sync-store.py');
  const bridge='import importlib.util,json,sys; from pathlib import Path; s=importlib.util.spec_from_file_location("store",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.handle(Path(sys.argv[2]),json.load(sys.stdin))))';
  const calls=[];
  const transport=async(_host,req)=>{
    calls.push(req);
    const child=spawnSync('python3',['-c',bridge,source,path.join(root,'remote')],{input:JSON.stringify({version:2,...req}),encoding:'utf8',maxBuffer:96*1024*1024});
    assert.equal(child.status,0,child.stderr);
    const result=JSON.parse(child.stdout); if(!result.ok) throw Object.assign(new Error(result.error),{code:result.error==='conflict'?'retry':undefined});
    return result;
  };
  const bytes=Buffer.from('%PDF-exact bytes\u0000\u00ff');
  const hash=(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  put(a.directory,`attachments/${hash}.bin`,bytes);
  put(a.directory,`documents/${hash}.json`,JSON.stringify({attachmentId:hash,name:'cours.pdf'}));
  await synchronize({host:'test',directory:a.directory,transport});
  await synchronize({host:'test',directory:b.directory,transport});
  assert.equal(snapshot(a.directory).revision,snapshot(b.directory).revision);
  assert.deepEqual(fs.readFileSync(path.join(b.directory,`attachments/${hash}.bin`)),bytes);
  calls.length=0;
  put(a.directory,'chats/new.json','new');
  await synchronize({host:'test',directory:a.directory,transport});
  assert.deepEqual(calls.filter(r=>r.op==='objects').flatMap(r=>Object.keys(r.files)),['chats/new.json']);
  await synchronize({host:'test',directory:b.directory,transport});
  assert.equal(snapshot(a.directory).revision,snapshot(b.directory).revision);
});
