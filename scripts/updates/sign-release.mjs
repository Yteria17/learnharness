/** Sign exact artifact bytes; private key is supplied only to the release job. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {verifyManifest}=require('../../electron/update-verification.cjs');
const directory=path.resolve(process.argv[2]);
const version=JSON.parse(fs.readFileSync('package.json')).version;
const privateKey=process.env.LH_UPDATE_SIGNING_KEY;
if(!privateKey)throw new Error('Missing release signing key');
const files={};
for(const [target,suffix] of [['darwin-arm64','arm64-mac.zip'],['win32-x64','x64-setup.exe']]){
 const name=`LearnHarness-${version}-${suffix}`;
 const file=path.join(directory,name);
 const hash=crypto.createHash('sha256');let size=0;
 for await(const bytes of fs.createReadStream(file)){hash.update(bytes);size+=bytes.length;}
 files[target]={name,size,sha256:hash.digest('hex')};
}
const raw=Buffer.from(JSON.stringify({schema:1,repository:'Yteria17/learnharness',appId:'com.learnharness.LearnHarness',version,tag:`v${version}`,files},null,2)+'\n');
const signature=crypto.sign(null,raw,privateKey).toString('base64');
verifyManifest(raw,signature,fs.readFileSync('electron/update-public-key.pem'));
fs.writeFileSync(path.join(directory,'signed-update.json'),raw);
fs.writeFileSync(path.join(directory,'signed-update.json.sig'),signature+'\n');
const sums=[];
for(const name of fs.readdirSync(directory).sort()){
 const file=path.join(directory,name);if(!fs.statSync(file).isFile()||name==='SHA256SUMS.txt')continue;
 const hash=crypto.createHash('sha256');for await(const bytes of fs.createReadStream(file))hash.update(bytes);
 sums.push(`${hash.digest('hex')}  ${name}`);
}
fs.writeFileSync(path.join(directory,'SHA256SUMS.txt'),sums.join('\n')+'\n');
console.log(`Verified signed update manifest for ${version}`);
