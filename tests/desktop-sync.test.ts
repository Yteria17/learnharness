import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { createDesktopSync, createSyncShutdown, syncControl, recoverInterruptedLock } = require("../electron/sync.cjs");

function fixture(t: { after: (fn: () => void) => void }) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-desktop-sync-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return { userData: root, directory: path.join(root, "data") };
}

test("desktop sync defaults to disabled and never contacts a server without configuration", async (t) => {
	let contacted = false;
	const sync = createDesktopSync({ ...fixture(t), ensureIdle() {}, loadEngine: async () => { contacted = true; throw new Error("unexpected"); } });
	assert.equal((await sync.run()).phase, "disabled");
	assert.equal(contacted, false);
});

test("configuration stays outside learning data and command-like SSH hosts are rejected", (t) => {
	const profile = fixture(t);
	const sync = createDesktopSync({ ...profile, ensureIdle() {} });
	for (const host of ["-oProxyCommand=bad", "user@host;bad", "host\ncommand", "user@host command"]) {
		assert.throws(() => sync.configure({ enabled: true, host }), /SSH host/);
	}
	const saved = sync.configure({ enabled: true, host: "user@host" });
	assert.equal(saved.pendingRestart, true);
	assert.ok(fs.existsSync(path.join(profile.userData, "desktop-sync.json")));
	assert.equal(fs.existsSync(profile.directory), false);
});

test("running writers prevent a sync, and a subsequent idle retry succeeds", async (t) => {
	let idle = false; let transfers = 0;
	const sync = createDesktopSync({ ...fixture(t),
		ensureIdle() { if (!idle) throw new Error("writer active"); },
		loadEngine: async () => ({ synchronize: async (options: { ensureClosed: () => void }) => { options.ensureClosed(); transfers++; } }),
		now: () => "2026-10-24T16:00:00.000Z",
	});
	sync.configure({ enabled: true, host: "user@host" });
	assert.equal((await sync.run()).phase, "offline");
	assert.equal(transfers, 0);
	idle = true;
	const result = await sync.run();
	assert.equal(result.phase, "synced");
	assert.equal(result.lastSyncAt, "2026-10-24T16:00:00.000Z");
	assert.equal(transfers, 1);
});

test("a remote conflict keeps the local file and exposes an actionable state", async (t) => {
	const profile = fixture(t);
	fs.mkdirSync(profile.directory);
	const local = path.join(profile.directory, "settings.json");
	fs.writeFileSync(local, "original local bytes");
	const sync = createDesktopSync({ ...profile, ensureIdle() {}, loadEngine: async () => ({ synchronize: async () => { throw new Error("Conflict: both copies changed"); } }) });
	sync.configure({ enabled: true, host: "user@host" });
	const result = await sync.run();
	assert.equal(result.phase, "conflict");
	assert.match(result.message, /both copies/);
	assert.equal(fs.readFileSync(local, "utf8"), "original local bytes");
});

test("concurrent requests coalesce and configuration cannot change during a transfer", async (t) => {
	let resolveTransfer!: () => void;
	let started!: () => void;
	const startedPromise = new Promise<void>((resolve) => { started = resolve; });
	const transfer = new Promise<void>((resolve) => { resolveTransfer = resolve; });
	let count = 0;
	const sync = createDesktopSync({ ...fixture(t), ensureIdle() {}, loadEngine: async () => ({ synchronize: async () => { count++; started(); await transfer; } }) });
	sync.configure({ enabled: true, host: "user@host" });
	const first = sync.run(); const second = sync.run();
	assert.equal(first, second);
	await startedPromise;
	assert.throws(() => sync.configure({ enabled: false, host: "user@host" }), /Wait/);
	resolveTransfer(); await first;
	assert.equal(count, 1);
});

test("shutdown waits for server exit, coalesces repeated quits and finishes once", async () => {
	const events: string[] = [];
	let stopped!: () => void;
	const stopping = new Promise<void>((resolve) => { stopped = resolve; });
	const begin = createSyncShutdown({
		stopServer: async () => { events.push("stop"); await stopping; events.push("exited"); },
		sync: { run: async () => { events.push("sync"); return { phase: "synced" }; } },
		chooseFailure: async () => { throw new Error("unexpected"); },
		finish: () => { events.push("quit"); },
	});
	const first = begin(); assert.equal(first, begin());
	assert.deepEqual(events, ["stop"]);
	stopped(); await first; await begin();
	assert.deepEqual(events, ["stop", "exited", "sync", "quit"]);
});

test("failed server stop never snapshots a live profile", async () => {
	let transfers = 0; let finishes = 0;
	const begin = createSyncShutdown({ stopServer: async () => { throw new Error("still alive"); },
		sync: { run: async () => { transfers++; } },
		chooseFailure: async (message: string) => { assert.equal(message, "still alive"); return "quit"; },
		finish: () => { finishes++; },
	});
	await begin();
	assert.equal(transfers, 0); assert.equal(finishes, 1);
});

test("failed shutdown transfer can retry before completing the quit", async () => {
	let transfers = 0; let finishes = 0;
	const begin = createSyncShutdown({ stopServer: async () => {},
		sync: { run: async () => ++transfers === 1 ? { phase: "offline", message: "no network" } : { phase: "synced" } },
		chooseFailure: async (message: string) => { assert.equal(message, "no network"); assert.equal(finishes, 0); return "retry"; },
		finish: () => { finishes++; },
	});
	await begin(); assert.equal(transfers, 2); assert.equal(finishes, 1);
});

test("sync IPC rejects unsupported commands and validates configuration", async (t) => {
	const sync = createDesktopSync({ ...fixture(t), ensureIdle() {} });
	let restarted = false;
	assert.match((await syncControl({ op: "execute", command: "bad" }, sync, () => {})).error, /Unsupported/);
	assert.match((await syncControl({ op: "configure", config: { enabled: true, host: "host;bad" } }, sync, () => {})).error, /SSH host/);
	assert.equal((await syncControl({ op: "status" }, sync, () => {})).phase, "disabled");
	await syncControl({ op: "restart" }, sync, () => { restarted = true; });
	assert.equal(restarted, true);
});

function fakeTimers() {
	const jobs = new Map<object, { callback: () => void; delay: number }>();
	return {
		jobs,
		setTimeout: (callback: () => void, delay: number) => { const key = {}; jobs.set(key, { callback, delay }); return key; },
		clearTimeout: (key: object) => { jobs.delete(key); },
		fire: async () => {
			const first = jobs.entries().next().value;
			assert.ok(first);
			jobs.delete(first[0]); first[1].callback();
			await new Promise<void>((resolve) => setImmediate(resolve));
		},
	};
}

test("live scheduler uses server-owned access and polls again without a restart", async (t) => {
	const timers = fakeTimers(); let captures = 0; let calls = 0;
	const sync = createDesktopSync({ ...fixture(t), timers,
		ensureIdle: () => { throw new Error("server is running"); },
		loadEngine: async () => ({ synchronize: async (options: { live: boolean; capture: () => Promise<void> }) => {
			assert.equal(options.live, true); calls++; await options.capture();
		} }),
	});
	sync.configure({ enabled: true, host: "user@host" });
	sync.startLive({ capture: async () => { captures++; }, install: async () => {} });
	await timers.fire();
	assert.equal(sync.status().phase, "synced");
	assert.equal(captures, 1);
	assert.equal([...timers.jobs.values()][0]!.delay, 10000);
	await timers.fire(); assert.equal(calls, 2);
	await sync.stopLive(); assert.equal(timers.jobs.size, 0);
});
test("save notifications coalesce into a single early live sync", async (t) => {
	const timers = fakeTimers(); let calls = 0;
	const sync = createDesktopSync({ ...fixture(t), timers, ensureIdle() {}, loadEngine: async () => ({ synchronize: async () => { calls++; } }) });
	sync.configure({ enabled: true, host: "user@host" });
	sync.startLive({ capture: async () => {}, install: async () => {} });
	await timers.fire();
	sync.requestSoon(); sync.requestSoon(); sync.requestSoon();
	assert.equal(timers.jobs.size, 1);
	assert.equal([...timers.jobs.values()][0]!.delay, 1000);
	await timers.fire(); assert.equal(calls, 2);
	await sync.stopLive();
});
test("busy peer imports retry automatically and disabling sync stops future polls", async (t) => {
	const timers = fakeTimers(); let attempts = 0;
	const sync = createDesktopSync({ ...fixture(t), timers, ensureIdle() {}, loadEngine: async () => ({ synchronize: async () => {
		if (++attempts === 1) throw Object.assign(new Error("busy"), { code: "deferred" });
	} }) });
	sync.configure({ enabled: true, host: "user@host" });
	sync.startLive({ capture: async () => {}, install: async () => {} });
	await timers.fire(); assert.equal(sync.status().phase, "waiting");
	await timers.fire(); assert.equal(sync.status().phase, "synced");
	sync.configure({ enabled: false, host: "user@host" });
	sync.requestSoon(); assert.equal(timers.jobs.size, 0);
});
test("a lock left by an exited host recovers, but a living owner's lock is preserved", (t) => {
	const { userData } = fixture(t);
	const file = path.join(userData, "ssh-sync.lock");
	fs.writeFileSync(file, JSON.stringify({ pid: 123, startedAt: new Date().toISOString() }));
	recoverInterruptedLock(userData, () => true);
	assert.equal(fs.existsSync(file), true);
	recoverInterruptedLock(userData, () => false);
	assert.equal(fs.existsSync(file), false);
});
