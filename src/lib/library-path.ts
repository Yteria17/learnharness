import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PATHS } from "../../config.ts";

/** Resolve portable learner-file references for the existing read-only tools. */
export function resolveLibraryPath(reference: string): string {
	if (!reference.startsWith("library://")) return reference;
	const match = /^library:\/\/([a-f0-9]{64})\/[^/]+$/.exec(reference);
	if (!match || !fs.existsSync(path.join(PATHS.data, "documents", match[1] + ".json"))) {
		throw new Error("Document introuvable dans la bibliothèque.");
	}
	const document = JSON.parse(fs.readFileSync(path.join(PATHS.data, "documents", match[1] + ".json"), "utf8"));
	if (document.id !== match[1] || typeof document.attachmentId !== "string" || !/^[a-f0-9]{64}$/.test(document.attachmentId)) {
		throw new Error("Document invalide.");
	}
	const file = path.join(PATHS.data, "attachments", document.attachmentId + ".bin");
	if (createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== document.attachmentId) {
		throw new Error("Document endommagé.");
	}
	return file;
}
