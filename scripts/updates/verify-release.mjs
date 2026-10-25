/** Verify the platform artifacts + signed metadata after cross-job reassembly. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { verifyManifest, matches } = require('../../electron/update-verification.cjs');
const directory = path.resolve(process.argv[2]);
const manifest = verifyManifest(fs.readFileSync(path.join(directory, 'signed-update.json')), fs.readFileSync(path.join(directory, 'signed-update.json.sig'), 'utf8'), fs.readFileSync('electron/update-public-key.pem'));
const version = JSON.parse(fs.readFileSync('package.json')).version;
if (manifest.version !== version) throw new Error('Assembled release version mismatch');
for (const asset of Object.values(manifest.files)) {
 if (!await matches(path.join(directory, asset.name), asset)) throw new Error(`Signed package missing or corrupt: ${asset.name}`);
}
const expected = new Set([
 `LearnHarness-${version}-arm64-mac.zip`, `LearnHarness-${version}-arm64.dmg`,
 `LearnHarness-${version}-x64-setup.exe`, `LearnHarness-${version}-amd64.deb`,
 `LearnHarness-${version}-x86_64.AppImage`, 'signed-update.json', 'signed-update.json.sig',
]);
const seen = new Set();
for (const line of fs.readFileSync(path.join(directory, 'SHA256SUMS.txt'), 'utf8').trim().split('\n')) {
 const entry = /^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);
 if (!entry || seen.has(entry[2]) || entry[2] === '.' || entry[2] === '..') throw new Error('Invalid or duplicate checksum entry');
 const [, hash, name] = entry;
 const digest = crypto.createHash('sha256');
 for await (const chunk of fs.createReadStream(path.join(directory, name))) digest.update(chunk);
 if (digest.digest('hex') !== hash) throw new Error(`Assembled release checksum mismatch: ${name}`);
 seen.add(name);
}
for (const name of expected) if (!seen.has(name)) throw new Error(`Missing release checksum: ${name}`);
for (const name of fs.readdirSync(directory)) if (name !== 'SHA256SUMS.txt' && !seen.has(name)) throw new Error(`Unexpected release asset: ${name}`);
console.log(`Verified all ${seen.size} reconstructed release assets for ${version}`);
