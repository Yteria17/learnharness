/** Snapshot and replacement run synchronously in the process owning all writers. */
import { PATHS } from "../../config.ts";
import fs from "node:fs";
import path from "node:path";
import { snapshot, applySnapshot, revisionOf, manifestOf, allowed } from "../../scripts/sync/sync-data.mjs";

export const syncStore = {
	snapshot: () => snapshot(PATHS.data),
	apply: (files: Record<string, string>, expected: string, ensureIdle: () => void) => applySnapshot(PATHS.data, files, expected, ensureIdle),
};

/** Import large profiles in bounded local HTTP requests, then publish atomically. */
export function stageSyncFiles(transaction: string, files: Record<string, string>) {
	const folder = stagingDirectory(transaction);
	revisionOf(files);
	fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
	for (const [name, value] of Object.entries(files)) {
		const file = path.join(folder, name);
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fs.writeFileSync(file, Buffer.from(value, "base64"), { mode: 0o600 });
	}
}
export function discardSyncStage(transaction: string) { fs.rmSync(stagingDirectory(transaction), { recursive: true, force: true }); }
export function stagedSyncFiles(transaction: string, manifest: Record<string, {hash: string; size: number}>, expected: string) {
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Invalid import manifest");
	const current = snapshot(PATHS.data);
	if (current.revision !== expected) throw Object.assign(new Error("Local data changed during synchronization."), { code: "deferred" });
	const folder = stagingDirectory(transaction);
	const files: Record<string, string> = {};
	for (const name of Object.keys(manifest)) {
		if (!allowed(name)) throw new Error("Unsupported sync file");
		const staged = path.join(folder, name);
		const value = fs.existsSync(staged) ? fs.readFileSync(staged).toString("base64") : current.files[name];
		if (value === undefined) throw new Error("Missing import file");
		files[name] = value;
	}
	const actual = manifestOf(files);
	if (Object.keys(actual).length !== Object.keys(manifest).length || Object.keys(actual).some(name => actual[name]!.hash !== manifest[name]?.hash || actual[name]!.size !== manifest[name]?.size)) throw new Error("Import integrity check failed");
	return files;
}
function stagingDirectory(transaction: string) {
	if (!/^[a-f0-9-]{36}$/.test(transaction)) throw new Error("Invalid import transaction");
	return path.join(path.dirname(PATHS.data), ".sync-incoming", transaction);
}
