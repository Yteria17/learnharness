"use strict";

// Updates trust this fork's Ed25519 release key, never an upstream feed.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { spawn } = require("node:child_process");
const semver = require("semver");

const { verifyManifest, matches, atomicJSON, REPOSITORY } = require("./update-verification.cjs");

class ForkUpdater extends EventEmitter {
	constructor({ version, userData, appPath, runtime, platform = process.platform, arch = process.arch, fetch: fetcher = globalThis.fetch, publicKey = fs.readFileSync(path.join(__dirname, "update-public-key.pem")), log = () => {} }) {
		super();
		Object.assign(this, { version, userData, appPath, runtime, platform, arch, fetcher, publicKey, log });
		this.directory = path.join(userData, "updates");
		this.ready = null; this.running = null; this.state = { status: "idle", version: null };
		this.autoInstallOnAppQuit = true;
	}
	status() { return this.state; }
	isReady() { return !!this.ready; }
	publish(value) { this.state = value; this.emit("status", value); }
	async response(url, max = 32768) {
		const response = await this.fetcher(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": `LearnHarness/${this.version}` }, signal: AbortSignal.timeout(30000) });
		if (!response.ok) throw new Error(`Update service returned HTTP ${response.status}`);
		const chunks = []; let size = 0;
		for await (const chunk of response.body) { size += chunk.length; if (size > max) throw new Error("Update metadata too large"); chunks.push(Buffer.from(chunk)); }
		return Buffer.concat(chunks);
	}
	checkForUpdates() {
		if (this.running) return this.running;
		this.running = this.check().finally(() => { this.running = null; });
		return this.running;
	}
	async restoreCachedUpdate() {
		try {
			const manifestPath = path.join(this.directory, "signed-update.json");
			const manifest = verifyManifest(fs.readFileSync(manifestPath), fs.readFileSync(manifestPath + ".sig", "utf8"), this.publicKey);
			const asset = manifest.files[`${this.platform}-${this.arch}`];
			const destination = path.join(this.directory, asset.name);
			if (!semver.gt(manifest.version, this.version) || !await matches(destination, asset)) return;
			this.ready = { manifest, asset, destination, manifestPath };
			this.publish({ status: "downloaded", version: manifest.version });
		} catch { /* No valid cached update; check the release service. */ }
	}
	async check() {
		if (!["darwin-arm64", "win32-x64"].includes(`${this.platform}-${this.arch}`)) return null;
		if (!this.ready) await this.restoreCachedUpdate();
		
		this.publish({ status: "checking", version: null });
		try {
			const release = JSON.parse((await this.response(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, 256 * 1024)).toString());
			if (release.draft || release.prerelease || typeof release.tag_name !== "string" || !/^v[0-9A-Za-z.-]+$/.test(release.tag_name)) throw new Error("Invalid fork release");
			const version = release.tag_name.slice(1);
			if (!semver.valid(version)) throw new Error("Invalid fork version");
			if (this.ready && !semver.gt(version, this.ready.manifest.version)) { this.publish({ status: "downloaded", version: this.ready.manifest.version }); return { updateInfo: { version: this.ready.manifest.version } }; }
			if (!semver.gt(version, this.version)) { this.publish({ status: "idle", version: this.version }); return null; }
			const base = `https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/`;
			const [raw, signature] = await Promise.all([this.response(base + "signed-update.json"), this.response(base + "signed-update.json.sig", 256)]);
			const manifest = verifyManifest(raw, signature.toString(), this.publicKey);
			if (manifest.version !== version || manifest.tag !== release.tag_name) throw new Error("Release and signed version disagree");
			const asset = manifest.files[`${this.platform}-${this.arch}`];
			fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
			const destination = path.join(this.directory, asset.name);
			this.publish({ status: "downloading", version });
			if (!await matches(destination, asset)) {
				const temp = destination + "." + crypto.randomUUID() + ".part";
				try {
					const response = await this.fetcher(base + encodeURIComponent(asset.name), { signal: AbortSignal.timeout(15 * 60 * 1000) });
					if (!response.ok || !response.body) throw new Error(`Update download returned HTTP ${response.status}`);
					let size = 0;
					await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; callback(size > asset.size ? new Error("Update package exceeds signed size") : null, chunk); } }), fs.createWriteStream(temp, { flags: "wx", mode: 0o600 }));
					if (!await matches(temp, asset)) throw new Error("Downloaded update failed SHA-256 verification");
					await fsp.rename(temp, destination);
				} finally { await fsp.rm(temp, { force: true }); }
			}
			const manifestPath = path.join(this.directory, "signed-update.json");
			fs.writeFileSync(manifestPath, raw, { mode: 0o600 });
			fs.writeFileSync(manifestPath + ".sig", signature, { mode: 0o600 });
			this.ready = { manifest, asset, destination, manifestPath };
			this.publish({ status: "downloaded", version });
			return { updateInfo: { version } };
		} catch (error) {
			if (this.ready) { this.log(`Update check failed; keeping verified cached update: ${error.message}`); this.publish({ status: "downloaded", version: this.ready.manifest.version }); return { updateInfo: { version: this.ready.manifest.version } }; }
			this.publish({ status: "error", version: null, message: error.message }); throw error;
		}
	}
	async install({ relaunch = false } = {}) {
		if (!this.ready) throw new Error("No verified update is ready");
		if (!await matches(this.ready.destination, this.ready.asset)) throw new Error("Update changed before installation");
		const helper = path.join(this.directory, "install-update.cjs");
		fs.copyFileSync(path.join(__dirname, "install-update.cjs"), helper);
		fs.copyFileSync(path.join(__dirname, "update-verification.cjs"), path.join(this.directory, "update-verification.cjs"));
		fs.writeFileSync(path.join(this.directory, "update-public-key.pem"), this.publicKey, { mode: 0o600 });
		const job = path.join(this.directory, "install-job.json");
		atomicJSON(job, { schema: 1, parentPid: process.pid, platform: this.platform, arch: this.arch, version: this.ready.manifest.version, appPath: this.appPath, archive: this.ready.destination, manifestPath: this.ready.manifestPath, relaunch, userData: this.userData });
		await new Promise((resolve, reject) => {
			const child = spawn(this.runtime, [helper, job], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
			const timer = setTimeout(() => { child.kill(); reject(new Error("Update helper did not start")); }, 15000);
			child.once("error", error => { clearTimeout(timer); reject(error); });
			child.once("message", message => { clearTimeout(timer); if (message?.ready) { child.disconnect(); child.unref(); resolve(); } else reject(new Error(message?.error || "Update helper failed")); });
			child.once("exit", code => { clearTimeout(timer); reject(new Error(`Update helper exited before readiness (${code})`)); });
		});
	}
}
module.exports = { ForkUpdater };
