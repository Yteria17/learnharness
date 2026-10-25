"use strict";

// Copied outside the running bundle before quit; dependencies are Node builtins.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const { verifyManifest, matches, atomicJSON, APP_ID } = require("./update-verification.cjs");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; } }
async function waitForExit(pid, timeout = 120000) {
	if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error("Invalid updater parent");
	const deadline = Date.now() + timeout;
	while (alive(pid)) { if (Date.now() > deadline) throw new Error("LearnHarness did not close; update cancelled"); await sleep(100); }
}
function plist(app, field) {
	return execFileSync("/usr/bin/plutil", ["-extract", field, "raw", path.join(app, "Contents/Info.plist")], { encoding: "utf8" }).trim();
}
function validateMacBundle(app, version) {
	if (plist(app, "CFBundleIdentifier") !== APP_ID || plist(app, "CFBundleShortVersionString") !== version) throw new Error("Update bundle identity/version mismatch");
	execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { timeout: 60000, stdio: "pipe" });
}
async function replaceMacBundle(appPath, staged, backup, { rename = fsp.rename, remove = p => fsp.rm(p, { recursive: true, force: true }) } = {}) {
	await remove(backup);
	await rename(appPath, backup);
	try { await rename(staged, appPath); }
	catch (error) { await rename(backup, appPath); throw error; }
}
async function installMac(job) {
	const target = path.resolve(job.appPath);
	if (path.basename(target) !== "LearnHarness.app" || !fs.statSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink() || plist(target, "CFBundleIdentifier") !== APP_ID) throw new Error("Invalid installed app path");
	const stage = await fsp.mkdtemp(path.join(path.dirname(target), ".LearnHarness-update-"));
	const backup = path.join(path.dirname(target), ".LearnHarness.previous");
	try {
		execFileSync("/usr/bin/ditto", ["-xk", job.archive, stage], { timeout: 120000, stdio: "pipe" });
		const candidate = path.join(stage, "LearnHarness.app");
		validateMacBundle(candidate, job.version);
		await replaceMacBundle(target, candidate, backup);
		atomicJSON(path.join(job.userData, "updates/install-result.json"), { status: "installed", version: job.version, backup, at: new Date().toISOString() });
		if (job.relaunch) {
			try { execFileSync("/usr/bin/open", ["-n", "-a", target], { timeout: 30000, stdio: "pipe" }); }
			catch (error) { await fsp.rename(target, path.join(stage, "failed.app")); await fsp.rename(backup, target); execFileSync("/usr/bin/open", ["-n", "-a", target]); throw error; }
		}
	} finally { await fsp.rm(stage, { recursive: true, force: true }); }
}
function windowsInstallerArgs({ appPath, relaunch }) {
	if (path.win32.basename(appPath).toLowerCase() !== "learnharness.exe") throw new Error("Invalid installed Windows app path");
	// Match NSIS/electron-updater's supported silent-update arguments.
	return ["--updated", "/S", ...(relaunch ? ["--force-run"] : []), `/D=${path.win32.dirname(appPath)}`];
}
async function installWindows(job) {
	const args = windowsInstallerArgs(job);
	await new Promise((resolve, reject) => {
		const child = spawn(job.archive, args, { detached: true, stdio: "ignore", windowsHide: true });
		child.once("error", reject);
		child.once("spawn", () => { child.unref(); resolve(); });
	});
	// Exit this Electron Node helper so NSIS can replace its executable too.
}
async function run(jobFile) {
	const job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
	if (!Number.isSafeInteger(job.parentPid) || job.parentPid <= 0 || job.parentPid === process.pid || job.schema !== 1 || !path.isAbsolute(job.userData) || path.resolve(jobFile) !== path.join(job.userData, "updates/install-job.json") || !["darwin", "win32"].includes(job.platform)) throw new Error("Invalid installation job");
	const root = path.dirname(jobFile);
	if (path.resolve(job.manifestPath) !== path.join(root, "signed-update.json")) throw new Error("Invalid manifest path");
	if (job.platform === "darwin") fs.accessSync(path.dirname(job.appPath), fs.constants.W_OK);
	else windowsInstallerArgs(job);
	const manifest = verifyManifest(fs.readFileSync(job.manifestPath), fs.readFileSync(job.manifestPath + ".sig", "utf8"), fs.readFileSync(path.join(root, "update-public-key.pem")));
	const asset = manifest.files[`${job.platform}-${job.arch}`];
	if (!asset || manifest.version !== job.version || path.resolve(job.archive) !== path.join(root, asset.name) || !await matches(job.archive, asset)) throw new Error("Update package changed before install");
	process.send?.({ ready: true });
	await waitForExit(job.parentPid);
	// Recheck after waiting: a corrupted cache must not replace a working app.
	if (!await matches(job.archive, asset)) throw new Error("Update integrity check failed after quit");
	if (job.platform === "darwin") await installMac(job);
	else await installWindows(job);
}
if (require.main === module) {
	run(process.argv[2]).catch(error => {
		try { const job = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); atomicJSON(path.join(job.userData, "updates/install-result.json"), { status: "failed", version: job.version, message: error.message, at: new Date().toISOString() }); } catch { /* keep original error */ }
		try { process.send?.({ error: error.message }); } catch { /* parent already closed */ }
		process.exitCode = 1;
	});
}
module.exports = { waitForExit, replaceMacBundle, windowsInstallerArgs, validateMacBundle, run };
