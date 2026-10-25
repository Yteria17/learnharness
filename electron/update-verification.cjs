"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const REPOSITORY = "Yteria17/learnharness";
const APP_ID = "com.learnharness.LearnHarness";
const MAX_PACKAGE = 1024 * 1024 * 1024;
function verifyManifest(raw, signature, publicKey) {
	if (raw.length > 32 * 1024) throw new Error("Update manifest too large");
	const sig = Buffer.from(signature.trim(), "base64");
	if (sig.length !== 64 || sig.toString("base64") !== signature.trim() || !crypto.verify(null, raw, publicKey, sig)) throw new Error("Update signature verification failed");
	const value = JSON.parse(raw.toString("utf8"));
	if (value.schema !== 1 || value.repository !== REPOSITORY || value.appId !== APP_ID || !/^\d+\.\d+\.\d+(?:-fork\.\d+)?$/.test(value.version) || value.tag !== `v${value.version}` || !/^v[0-9A-Za-z.-]+$/.test(value.tag)) throw new Error("Invalid update manifest");
	for (const [target, suffix] of [["darwin-arm64", "arm64-mac.zip"], ["win32-x64", "x64-setup.exe"]]) {
		const file = value.files?.[target];
		if (!file || file.name !== `LearnHarness-${value.version}-${suffix}` || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_PACKAGE) throw new Error("Invalid update package");
	}
	return value;
}
async function digestFile(file) {
	const hash = crypto.createHash("sha256");
	let size = 0;
	for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); size += chunk.length; }
	return { sha256: hash.digest("hex"), size };
}
async function matches(file, asset) {
	try { const actual = await digestFile(file); return actual.size === asset.size && actual.sha256 === asset.sha256; } catch { return false; }
}
function atomicJSON(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = file + "." + crypto.randomUUID() + ".tmp";
	try { fs.writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 }); fs.renameSync(temp, file); }
	finally { fs.rmSync(temp, { force: true }); }
}

module.exports = { verifyManifest, digestFile, matches, atomicJSON, REPOSITORY, APP_ID };
