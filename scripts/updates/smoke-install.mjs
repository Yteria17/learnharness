/** Exercise download -> signed verification -> detached installer on disposable apps.
 * Uses the production packages/key, but never contacts the user's data/profile. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {ForkUpdater}=require('../../electron/fork-updater.cjs');
const {verifyManifest}=require('../../electron/update-verification.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const directory=path.resolve(process.argv[2]);
const manifest=verifyManifest(fs.readFileSync(path.join(directory,'signed-update.json')),fs.readFileSync(path.join(directory,'signed-update.json.sig'),'utf8'),fs.readFileSync('electron/update-public-key.pem'));
const asset=manifest.files[`${process.platform}-${process.arch}`];
if(!asset)throw Error('Unsupported smoke-test platform');
if(process.argv[3]==='--worker'){
 const root=process.argv[4],appPath=process.argv[5];
 const runtime=process.platform==='darwin'?path.join(appPath,'Contents/MacOS/LearnHarness'):appPath;
 const updater=new ForkUpdater({version:'0.0.0',userData:path.join(root,'profile'),appPath,runtime,fetch:async(url)=>{
  if(url.endsWith('/releases/latest'))return new Response(JSON.stringify({tag_name:manifest.tag}));
  const name=decodeURIComponent(new URL(url).pathname.split('/').pop());
  if(!['signed-update.json','signed-update.json.sig',asset.name].includes(name))throw Error('Unexpected request');
  return new Response(Readable.toWeb(fs.createReadStream(path.join(directory,name))));
 }});
 await updater.checkForUpdates();
 if(!updater.isReady())throw Error('Signed release was not staged');
 await updater.install({relaunch:false});
 console.log('Detached updater acknowledged readiness');
 process.exit(0);
}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'LearnHarness update smoke '));
let success=false;
try{
 const install=path.join(root,'Programs');fs.mkdirSync(install);
 const appPath=process.platform==='darwin'?path.join(install,'LearnHarness.app'):path.join(install,'LearnHarness.exe');
 if(process.platform==='darwin')execFileSync('/usr/bin/ditto',['-xk',path.join(directory,asset.name),install]);
 else {
  await new Promise((resolve,reject)=>{const child=spawn(path.join(directory,asset.name),['--updated','/S',`/D=${install}`],{stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`Initial NSIS install failed: ${code}`)));});
  // Electron's Node runtime still runs without the application archive.
  // Its restoration proves NSIS actually reinstalled the target directory.
  fs.renameSync(path.join(install,'resources/app.asar'),path.join(root,'before-update.asar'));
 }
 fs.mkdirSync(path.join(root,'profile/data'),{recursive:true});
 fs.writeFileSync(path.join(root,'profile/data/sentinel.txt'),'user lessons preserved');
 await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[process.argv[1],directory,'--worker',root,appPath],{stdio:'inherit'});
  child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`Updater worker failed: ${code}`)));
 });
 const deadline=Date.now()+180000;
 while(true){
  const result=path.join(root,'profile/updates/install-result.json');
  if(fs.existsSync(result)){
   const value=JSON.parse(fs.readFileSync(result));
   if(value.status==='failed')throw Error(value.message);
   if(value.status==='installed')break;
  }
  if(process.platform==='win32'&&fs.existsSync(path.join(install,'resources/app.asar')))break;
  if(Date.now()>deadline)throw Error('Installer did not complete');
  await sleep(500);
 }
 if(fs.readFileSync(path.join(root,'profile/data/sentinel.txt'),'utf8')!=='user lessons preserved')throw Error('Profile modified during update');
 if(process.platform==='darwin'){
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',appPath]);
  if(!fs.existsSync(path.join(install,'.LearnHarness.previous')))throw Error('Previous Mac app was not retained');
 }
 console.log(`PASS: real ${process.platform} installer, signed download, detached helper and profile preservation (${manifest.version})`);success=true;
}finally{
 if(success){await sleep(3000);fs.rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:500});}
 else console.error('Installer diagnostics retained at',root);
}
