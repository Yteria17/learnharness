/** Global across Next route bundles: imports cannot race a suspended mutation. */
type SyncBarrier = { mutations: number };
function state(): SyncBarrier {
	const shared = globalThis as typeof globalThis & { __lhSyncBarrier?: SyncBarrier };
	return shared.__lhSyncBarrier ??= { mutations: 0 };
}
export function syncMutationRunning(): boolean { return state().mutations > 0; }
export async function trackSyncMutation<T>(operation: () => Promise<T>): Promise<T> {
	state().mutations++;
	try { return await operation(); }
	finally { state().mutations--; }
}
