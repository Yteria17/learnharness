"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");

function validHost(host) {
	return typeof host === "string" && host.length <= 160 && /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(host);
}

function writeConfig(file, record) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600, flag: "wx" });
		fs.renameSync(temp, file);
	} finally { fs.rmSync(temp, { force: true }); }
}

/** Called only by the single-instance desktop host, before acquiring its lock.
 * A killed host cannot finish its finally block; a living owner's lock stays. */
function recoverInterruptedLock(userData, alive = (pid) => {
	try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}) {
	const file = path.join(userData, "ssh-sync.lock");
	if (!fs.existsSync(file)) return;
	const bytes = fs.readFileSync(file, "utf8");
	const owner = JSON.parse(bytes);
	if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("The synchronization lock has an invalid owner.");
	if (!alive(owner.pid) && fs.readFileSync(file, "utf8") === bytes) fs.unlinkSync(file);
}

/** Only Electron main owns this configuration. Never part of the shared data. */
function createDesktopSync({ userData, directory, ensureIdle, onChange = () => {},
	loadEngine = () => import(pathToFileURL(path.join(__dirname, "../scripts/sync/sync-data.mjs")).href),
	now = () => new Date().toISOString(), timers = { setTimeout, clearTimeout } }) {
	const file = path.join(userData, "desktop-sync.json");
	let config = { version: 1, enabled: false, host: "", lastSyncAt: null };
	if (fs.existsSync(file)) {
		config = JSON.parse(fs.readFileSync(file, "utf8"));
		if (config.version !== 1 || typeof config.enabled !== "boolean" || typeof config.host !== "string" || (config.host !== "" && !validHost(config.host)) || (config.enabled && !validHost(config.host)) || !(config.lastSyncAt === null || typeof config.lastSyncAt === "string")) throw new Error("Invalid desktop-sync.json. Restore this computer's sync configuration.");
	}
	let phase = config.enabled ? "pending" : "disabled";
	let message = null;
	let revision = 0;
	let pendingRestart = false;
	let running = null;
	let liveAccess = null;
	let timer = null;
	let timerDue = 0;
	let dirty = false;
	function schedule(delay) {
		if (!liveAccess || !config.enabled) return;
		if (running) { dirty = true; return; }
		const due = Date.now() + delay;
		if (timer && timerDue <= due) return;
		if (timer) timers.clearTimeout(timer);
		timerDue = due;
		timer = timers.setTimeout(() => { timer = null; void run("live"); }, delay);
		timer?.unref?.();
	}
	const status = () => ({ available: true, enabled: config.enabled, host: config.host, phase,
		lastSyncAt: config.lastSyncAt, message, pendingRestart, revision });
	const publish = () => { revision++; onChange(status()); };
	function configure(value) {
		if (running) throw new Error("Wait for the current synchronization to finish.");
		if (!value || typeof value.enabled !== "boolean" || typeof value.host !== "string" || (value.host !== "" && !validHost(value.host)) || (value.enabled && !validHost(value.host))) throw new Error("Enter an SSH host such as user@server or an existing SSH alias.");
		const next = { ...config, enabled: value.enabled, host: value.host };
		if (next.host !== config.host) next.lastSyncAt = null;
		writeConfig(file, next);
		pendingRestart = !liveAccess && next.enabled && (next.host !== config.host || !config.enabled);
		config = next;
		phase = config.enabled ? "pending" : "disabled";
		message = null;
		publish();
		if (!config.enabled && timer) { timers.clearTimeout(timer); timer = null; }
		else schedule(0);
		return status();
	}
	function run(mode = "closed") {
		if (running) return running;
		if (!config.enabled) return Promise.resolve(status());
		phase = "syncing"; message = null; publish();
		running = Promise.resolve().then(async () => {
			try {
				recoverInterruptedLock(userData);
				const live = mode === "live" ? liveAccess : null;
				if (!live) ensureIdle();
				const engine = await loadEngine();
				await engine.synchronize({ host: config.host, directory, ensureClosed: live ? () => {} : ensureIdle,
					...(live ? { live: true, capture: live.capture, install: live.install } : {}),
				});
				const next = { ...config, lastSyncAt: now() };
				writeConfig(file, next);
				config = next;
				phase = "synced"; pendingRestart = false;
			} catch (error) {
				message = String(error.message || error);
				phase = error.code === "deferred" || error.code === "retry" ? "waiting"
					: /conflict|no shared sync history|lost its sync history|another server/i.test(message) ? "conflict" : "offline";
			} finally {
				running = null; publish();
				const delay = dirty ? 1000 : 10000;
				dirty = false; schedule(delay);
			}
			return status();
		});
		return running;
	}
	return { status, configure, run, runLive: () => run(liveAccess ? "live" : "closed"),
		startLive: (access) => { liveAccess = access; pendingRestart = false; schedule(0); },
		requestSoon: () => schedule(1000),
		stopLive: async () => { liveAccess = null; if (timer) timers.clearTimeout(timer); timer = null; if (running) await running; },
	};
}

/** A shutdown cannot snapshot until the server really exits; repeat quits coalesce. */
function createSyncShutdown({ stopServer, sync, chooseFailure, finish }) {
	let pending = null;
	let finished = false;
	return function begin() {
		if (finished) return Promise.resolve();
		if (pending) return pending;
		pending = (async () => {
			for (;;) {
				let failure;
				try {
					await stopServer();
					const result = sync ? await sync.run() : { phase: "disabled" };
					if (result.phase === "disabled" || result.phase === "synced") break;
					failure = result.message || "Synchronization did not finish.";
				} catch (error) { failure = String(error.message || error); }
				if (await chooseFailure(failure) !== "retry") break;
			}
			finished = true;
			await finish();
		})();
		return pending;
	};
}

async function syncControl(command, sync, restart) {
	try {
		if (!sync) return { error: "Automatic synchronization is available in the packaged desktop app." };
		if (command?.op === "status") return sync.status();
		if (command?.op === "configure") return sync.configure(command.config);
		if (command?.op === "now") return await sync.runLive();
		if (command?.op === "restart") { restart(); return sync.status(); }
		return { error: "Unsupported sync operation." };
	} catch (error) { return { error: String(error.message || error) }; }
}

module.exports = { createDesktopSync, createSyncShutdown, syncControl, validHost, recoverInterruptedLock };
