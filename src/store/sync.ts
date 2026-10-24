/** Snapshot and replacement run synchronously in the process owning all writers. */
import { PATHS } from "../../config.ts";
import { snapshot, applySnapshot } from "../../scripts/sync/sync-data.mjs";

export const syncStore = {
	snapshot: () => snapshot(PATHS.data),
	apply: (files: Record<string, string>, expected: string, ensureIdle: () => void) => applySnapshot(PATHS.data, files, expected, ensureIdle),
};
