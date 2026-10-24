/** Content-addressed bytes shared by transcripts and the document library.
 * Runtime messages remain provider-native; only the disk adapter uses refs. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";

import { MAX_ATTACHMENT_BYTES } from "../core/documents.ts";
export function attachmentPath(id: string): string {
	if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid attachment id");
	return path.join(PATHS.data, "attachments", `${id}.bin`);
}
export function putAttachment(bytes: Uint8Array): string {
	if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("Document trop volumineux (50 Mo maximum).");
	const id = createHash("sha256").update(bytes).digest("hex");
	const file = attachmentPath(id);
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	if (fs.existsSync(file)) {
		if (createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== id) throw new Error("Attachment integrity check failed");
		return id;
	}
	const temp = `${file}.${randomUUID()}.tmp`;
	try { fs.writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 }); fs.renameSync(temp, file); }
	finally { fs.rmSync(temp, { force: true }); }
	return id;
}
export function readAttachment(id: string): Buffer {
	const bytes = fs.readFileSync(attachmentPath(id));
	if (createHash("sha256").update(bytes).digest("hex") !== id) throw new Error(`Attachment missing or corrupt: ${id}`);
	return bytes;
}

/** Only native image content blocks are rewritten. Tool arguments and text stay intact. */
export function storeImages<T>(value: T): T {
	return mapImages(value, false) as T;
}
export function hydrateImages<T>(value: T): T {
	return mapImages(value, true) as T;
}
function mapImages(value: unknown, hydrate: boolean): unknown {
	if (Array.isArray(value)) return value.map((item) => mapImages(item, hydrate));
	if (!value || typeof value !== "object") return value;
	const obj = value as Record<string, unknown>;
	if (obj.type === "image" && typeof obj.mimeType === "string") {
		if (hydrate && typeof obj.attachmentId === "string") {
			const { attachmentId, ...rest } = obj;
			return { ...rest, data: readAttachment(attachmentId).toString("base64") };
		}
		if (!hydrate && typeof obj.data === "string" && obj.data.length > 0 && Buffer.from(obj.data, "base64").toString("base64") === obj.data) {
			const { data, ...rest } = obj;
			return { ...rest, attachmentId: putAttachment(Buffer.from(data, "base64")) };
		}
	}
	return Object.fromEntries(Object.entries(obj).map(([key, item]) => [key, mapImages(item, hydrate)]));
}
