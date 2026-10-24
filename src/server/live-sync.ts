import { emit, subscribe } from "../core/events.ts";
import { syncMutationRunning, trackSyncMutation } from "../core/sync-barrier.ts";
import { anyTurnRunning } from "./turn-liveness.ts";
import { anyCompactionRunning } from "./compaction.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { stores } from "./stores.ts";
import { backgroundWritesPending } from "./jobs.ts";

function notifyDesktop() {
	if (process.env.LH_DESKTOP_SERVER === "1" && process.connected && process.send) {
		try { process.send({ channel: "lh:sync", op: "dirty" }, () => {}); } catch { /* host closed */ }
	}
}

// Notify on committed turns and background changes; settings/other mutations
// are covered by the request wrapper below, including suspended handlers.
const shared = globalThis as typeof globalThis & { __lhSyncNotifications?: boolean };
if (process.env.LH_DESKTOP_SERVER === "1" && !shared.__lhSyncNotifications) {
	shared.__lhSyncNotifications = true;
	subscribe((event) => { if (event.type !== "profile-synced") notifyDesktop(); });
}

export function withSyncMutation<A extends unknown[], R>(handler: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
	return (...args) => trackSyncMutation(async () => {
		try { return await handler(...args); }
		finally { notifyDesktop(); }
	});
}

export function liveSyncBusy(): boolean {
	if (syncMutationRunning() || anyTurnRunning() || anyCompactionRunning() || backgroundWritesPending() || extractionStatuses().length > 0) return true;
	return stores.chatStore.listChats().some((chat) => stores.jobStore.listJobs(chat.id).some((job) => job.status === "running"));
}

export function liveSyncSnapshot() {
	// Do not publish a turn's write-ahead record as an abandoned partial
	// conversation on another computer. Completed checkpoints travel instead.
	if (anyTurnRunning() || anyCompactionRunning() || backgroundWritesPending()) throw Object.assign(new Error("Synchronization is waiting for the current response to finish."), { code: "deferred" });
	return stores.syncStore.snapshot();
}

export function liveSyncApply(files: Record<string, string>, expected: string) {
	const ensureIdle = () => {
		if (liveSyncBusy()) throw Object.assign(new Error("Incoming changes are waiting for the current operation to finish."), { code: "deferred" });
		if (stores.syncStore.snapshot().revision !== expected) throw Object.assign(new Error("Local changes arrived during synchronization. Retrying with the latest data."), { code: "deferred" });
	};
	ensureIdle();
	// No await below: the idle check, revision check and replacement are one
	// synchronous event-loop transaction. New requests only see the result.
	const backup = stores.syncStore.apply(files, expected, ensureIdle);
	emit("profile-synced", {});
	emit("chats-changed", {});
	emit("activity-changed", {});
	return { backup };
}
