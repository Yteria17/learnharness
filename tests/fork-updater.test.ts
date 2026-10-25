import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ForkUpdater } = require('../electron/fork-updater.cjs');
const { verifyManifest } = require('../electron/update-verification.cjs');
const { replaceMacBundle, windowsInstallerArgs, waitForExit, run } = require('../electron/install-update.cjs');
const keys = crypto.generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const payload = Buffer.from('signed release package');
function fixture(version = '0.3.8-fork.2') {
 const asset = (suffix: string) => ({name:`LearnHarness-${version}-${suffix}`,size:payload.length,sha256:crypto.createHash('sha256').update(payload).digest('hex')});
 return {schema:1,repository:'Yteria17/learnharness',appId:'com.learnharness.LearnHarness',version,tag:`v${version}`,files:{'darwin-arm64':asset('arm64-mac.zip'),'win32-x64':asset('x64-setup.exe')}};
}
function signed(value = fixture()) { const raw=Buffer.from(JSON.stringify(value));return {raw,signature:crypto.sign(null,raw,keys.privateKey).toString('base64')}; }
function temporary(t: {after: (fn:()=>void)=>void}) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lh-updater-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir; }
function updater(userData: string, options: Record<string,unknown> = {}) {
 const value=fixture();const {raw,signature}=signed(value);const requested:string[]=[];
 const fetch=async (url:string) => {requested.push(url);if(url.endsWith('/releases/latest'))return new Response(JSON.stringify({tag_name:value.tag}));if(url.endsWith('signed-update.json'))return new Response(raw);if(url.endsWith('.sig'))return new Response(signature);return new Response(payload);};
 return {instance:new ForkUpdater({version:'0.3.8-fork.1',userData,appPath:'/Applications/LearnHarness.app',runtime:process.execPath,platform:'darwin',arch:'arm64',publicKey,fetch,...options}),requested};
}
test('release signatures bind exact bytes and the fork identity', () => {
 const {raw,signature}=signed();assert.equal(verifyManifest(raw,signature,publicKey).version,'0.3.8-fork.2');
 assert.throws(()=>verifyManifest(Buffer.concat([raw,Buffer.from(' ')]),signature,publicKey),/signature/);
 assert.throws(()=>verifyManifest(raw,signature,crypto.generateKeyPairSync('ed25519').publicKey),/signature/);
 assert.throws(()=>verifyManifest(raw,'?',publicKey),/signature/);
});
test('signed but invalid repository, paths, versions and bounds are rejected', () => {
 const modifications = [
  (v: ReturnType<typeof fixture>) => {v.repository='amosblomqvist/learnharness';},
  (v: ReturnType<typeof fixture>) => {v.appId='other.app';},
  (v: ReturnType<typeof fixture>) => {v.tag='v9.9.9';},
  (v: ReturnType<typeof fixture>) => {v.version='../evil';},
  (v: ReturnType<typeof fixture>) => {v.files['darwin-arm64'].name='../evil.zip';},
  (v: ReturnType<typeof fixture>) => {v.files['win32-x64'].size=2**31;},
  (v: ReturnType<typeof fixture>) => {v.files['win32-x64'].sha256='x'.repeat(64);},
 ];
 for(const change of modifications){const value=fixture();change(value);const {raw,signature}=signed(value);assert.throws(()=>verifyManifest(raw,signature,publicKey));}
});
test('download is coalesced, verified, fork-only and recovered offline after restart', async t => {
 const directory=temporary(t);const {instance,requested}=updater(directory);const states:string[]=[];instance.on('status',(s:{status:string})=>states.push(s.status));
 const first=instance.checkForUpdates();assert.equal(instance.checkForUpdates(),first);await first;
 assert.deepEqual(states,['checking','downloading','downloaded']);assert.equal(instance.isReady(),true);
 assert.ok(requested.every(url=>url.startsWith('https://api.github.com/repos/Yteria17/learnharness/')||url.startsWith('https://github.com/Yteria17/learnharness/releases/download/v0.3.8-fork.2/')));
 assert.equal(requested.length,4);
 const offline=updater(directory,{fetch:()=>{throw Error('offline');}}).instance;await offline.checkForUpdates();assert.equal(offline.isReady(),true);
});
test('same or older release is never installed',async t=>{
 const {instance,requested}=updater(temporary(t),{version:'0.3.8-fork.2'});await instance.checkForUpdates();assert.equal(instance.isReady(),false);assert.equal(requested.length,1);
});
test('download corruption/oversize never produces an installable package',async t=>{
 for(const bytes of [Buffer.from('bad'),Buffer.alloc(payload.length+1)]){
  const directory=temporary(t);const original=updater(directory);const fetch=original.instance.fetcher;
  const {instance}=updater(directory,{fetch:(url:string)=>url.endsWith('.zip')?new Response(bytes):fetch(url)});
  await assert.rejects(instance.checkForUpdates(),/verification|signed size/);assert.equal(instance.isReady(),false);
  assert.equal(instance.status().status,'error');assert.ok(fs.readdirSync(path.join(directory,'updates')).every(name=>!name.endsWith('.part')));
 }
});
test('cached package tampering is caught again before starting helper',async t=>{
 const {instance}=updater(temporary(t));await instance.checkForUpdates();fs.writeFileSync(instance.ready.destination,'tampered');await assert.rejects(instance.install(),/changed/);
});
test('unsigned release or offline service leaves the app usable',async t=>{
 const directory=temporary(t);const original=updater(directory);const fetch=original.instance.fetcher;
 for(const replacement of [async()=>new Response('unavailable',{status:503}),async(url:string)=>url.endsWith('.sig')?new Response('bad'):fetch(url)]){
  const {instance}=updater(directory,{fetch:replacement});await assert.rejects(instance.checkForUpdates());assert.equal(instance.isReady(),false);
 }
});
test('unsupported platforms do not contact the release service',async t=>{
 const {instance,requested}=updater(temporary(t),{platform:'linux'});assert.equal(await instance.checkForUpdates(),null);assert.equal(requested.length,0);
});
test('Mac replacement preserves old bundle and rolls back failed rename',async t=>{
 const root=temporary(t);const target=path.join(root,'LearnHarness.app'),staged=path.join(root,'new.app'),backup=path.join(root,'.LearnHarness.previous');
 fs.mkdirSync(target);fs.writeFileSync(path.join(target,'version'),'old');fs.mkdirSync(staged);fs.writeFileSync(path.join(staged,'version'),'new');
 await assert.rejects(replaceMacBundle(target,staged,backup,{rename:async(from:string,to:string)=>{if(from===staged)throw Error('disk error');await fs.promises.rename(from,to);}}),/disk error/);
 assert.equal(fs.readFileSync(path.join(target,'version'),'utf8'),'old');
 await replaceMacBundle(target,staged,backup);assert.equal(fs.readFileSync(path.join(target,'version'),'utf8'),'new');assert.equal(fs.readFileSync(path.join(backup,'version'),'utf8'),'old');
});
test('Windows installer arguments preserve paths with spaces and optional restart',()=>{
 const appPath='C:\\Users\\Test User\\AppData\\Local\\Programs\\LearnHarness\\LearnHarness.exe';
 assert.deepEqual(windowsInstallerArgs({appPath,relaunch:true}),['--updated','/S','--force-run','/D=C:\\Users\\Test User\\AppData\\Local\\Programs\\LearnHarness']);
 assert.ok(!windowsInstallerArgs({appPath,relaunch:false}).includes('--force-run'));assert.throws(()=>windowsInstallerArgs({appPath:'C:\\other.exe'}));
});
test('helper rejects malformed parent/job before acknowledging readiness',async t=>{
 await assert.rejects(waitForExit(process.pid),/Invalid updater parent/);
 const dir=temporary(t);const job=path.join(dir,'updates/install-job.json');fs.mkdirSync(path.dirname(job));fs.writeFileSync(job,JSON.stringify({schema:1,parentPid:0,userData:dir,platform:'darwin'}));await assert.rejects(run(job),/Invalid installation job/);
});
