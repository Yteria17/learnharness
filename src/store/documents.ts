/** Portable document identities. Original bytes never depend on another PC's paths. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PATHS } from "../../config.ts";
import { putAttachment } from "./attachments.ts";

import type { LibraryDocument } from "../core/documents.ts";
export { resolveLibraryPath } from "../lib/library-path.ts";
const directory = () => path.join(PATHS.data, "documents");
const idPattern = /^[a-f0-9]{64}$/;
export function addDocument(name: string, bytes: Uint8Array, mimeType = "application/octet-stream"): LibraryDocument {
	name = name.replace(/\\/g, "/").split("/").pop()!.replace(/[\x00-\x1f]/g, "").slice(0, 180) || "document";
	const attachmentId = putAttachment(bytes);
	const id = createHash("sha256").update(`${attachmentId}\n${name}`).digest("hex");
	// MIME is inferred consistently, independent of the uploading OS/browser.
	mimeType = /\.pdf$/i.test(name) ? "application/pdf" : /\.(txt|md|csv|json|tex|html?|ya?ml)$/i.test(name) ? "text/plain" : "application/octet-stream";
	const document: LibraryDocument = { id, name, attachmentId, mimeType, size: bytes.byteLength, reference: `library://${id}/${encodeURIComponent(name)}` };
	fs.mkdirSync(directory(), { recursive: true, mode: 0o700 });
	const file = path.join(directory(), `${id}.json`);
	if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(document, null, "\t"), { flag: "wx", mode: 0o600 });
	return document;
}
export function getDocument(id: string): LibraryDocument | null {
	if (!idPattern.test(id)) return null;
	try {
		const doc = JSON.parse(fs.readFileSync(path.join(directory(), `${id}.json`), "utf8")) as LibraryDocument;
		if (doc.id !== id || !idPattern.test(doc.attachmentId) || typeof doc.name !== "string" || typeof doc.size !== "number") throw new Error("Invalid document");
		return doc;
	} catch { return null; }
}
export function listDocuments(): LibraryDocument[] {
	if (!fs.existsSync(directory())) return [];
	return fs.readdirSync(directory()).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map((name) => getDocument(name.slice(0, -5))).filter((doc): doc is LibraryDocument => doc !== null).sort((a,b) => a.name.localeCompare(b.name));
}
