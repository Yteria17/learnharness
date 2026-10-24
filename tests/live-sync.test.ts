import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { syncMutationRunning, trackSyncMutation } from "../src/core/sync-barrier.ts";
import { liveSyncApply, liveSyncSnapshot, withSyncMutation } from "../src/server/live-sync.ts";
import { beginTurn, endTurn } from "../src/server/turn-liveness.ts";

test("a request suspended before its write prevents importing peer data", async () => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	const running = trackSyncMutation(async () => pending);
	assert.equal(syncMutationRunning(), true);
	const before = liveSyncSnapshot();
	assert.throws(() => liveSyncApply(before.files, before.revision), /current operation/);
	release(); await running;
	assert.equal(syncMutationRunning(), false);
});
test("a model turn prevents profile replacement until the turn settles", () => {
	const before = liveSyncSnapshot();
	assert.equal(beginTurn("live-sync-test"), true);
	try { assert.throws(() => liveSyncApply(before.files, before.revision), /current operation/); }
	finally { endTurn("live-sync-test"); }
});
test("failed mutation handlers release their barrier", async () => {
	const handler = withSyncMutation(async () => { throw new Error("failed"); });
	await assert.rejects(handler(), /failed/);
	assert.equal(syncMutationRunning(), false);
});
test("every mutating API route participates in the live-sync barrier", () => {
	function walk(dir: string): string[] { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]); }
	for (const file of walk(path.resolve("app/api")).filter((name) => name.endsWith("route.ts") && !name.split(path.sep).join("/").endsWith("/api/sync/route.ts"))) {
		const source = fs.readFileSync(file, "utf8");
		assert.doesNotMatch(source, /export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b/, file);
		for (const match of source.matchAll(/export\s+const\s+(POST|PUT|PATCH|DELETE)\s*=\s*([^\n]+)/g)) assert.ok(match[2]!.startsWith("withSyncMutation("), file);
	}
});
