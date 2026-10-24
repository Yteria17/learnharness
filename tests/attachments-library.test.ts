import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-attachments-"));
process.env.LH_DATA_DIR = path.join(root, "data");
const { addDocument, getDocument, resolveLibraryPath, listDocuments } = await import("../src/store/documents.ts");
const { putAttachment, readAttachment, storeImages, hydrateImages } = await import("../src/store/attachments.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { snapshot, applySnapshot } = await import("../scripts/sync/sync-data.mjs");
const data = process.env.LH_DATA_DIR;
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("images are deduplicated on disk and hydrated into native messages on read", () => {
	const image = { type: "image" as const, mimeType: "image/png", data: Buffer.from("image bytes").toString("base64") };
	const a = chatStore.createChat("A"), b = chatStore.createChat("B");
	const messages = [{ id: "message-image", role: "user" as const, content: [image], timestamp: 0 }];
	chatStore.saveMessages(a.id, messages); chatStore.saveMessages(b.id, messages);
	const stored = fs.readFileSync(path.join(data, "chats", a.id + ".json"), "utf8");
	assert.ok(!stored.includes(image.data)); assert.ok(stored.includes("attachmentId"));
	assert.equal(fs.readdirSync(path.join(data, "attachments")).length, 1);
	assert.deepEqual(chatStore.getChat(a.id)?.messages, messages);
	assert.deepEqual(hydrateImages(storeImages(messages)), messages);
});
test("legacy images migrate once with an exact original backup and survive a peer import", () => {
	const original = JSON.stringify({id:"legacy",title:"legacy",version:1,messages:[{role:"user",content:[{type:"image",mimeType:"image/png",data:Buffer.from("legacy image").toString("base64")}]}]});
	fs.writeFileSync(path.join(data,"chats/legacy.json"), original);
	const first = snapshot(data), second = snapshot(data);
	assert.equal(first.revision, second.revision);
	const backups = fs.readdirSync(path.join(root,"attachment-migration-backups"));
	assert.equal(backups.length, 1); assert.equal(fs.readFileSync(path.join(root,"attachment-migration-backups",backups[0]!),"utf8"),original);
	const peer = path.join(root,"peer/data");
	applySnapshot(peer,first.files,snapshot(peer).revision,()=>{});
	assert.equal(snapshot(peer).revision,first.revision);
	const record=JSON.parse(fs.readFileSync(path.join(peer,"chats/legacy.json"),"utf8"));
	assert.equal(record.version,2);
	assert.equal(fs.readFileSync(path.join(peer,"attachments",record.messages[0].content[0].attachmentId+".bin"),"utf8"),"legacy image");
});
test("documents preserve exact PDF/text bytes and portable references, with no duplicate content", () => {
	const bytes = Buffer.from("%PDF-test\u0000\u00ff");
	const doc = addDocument("C:\\cours\\Algèbre.pdf",bytes);
	assert.equal(doc.name,"Algèbre.pdf"); assert.equal(doc.mimeType,"application/pdf");
	assert.deepEqual(fs.readFileSync(resolveLibraryPath(doc.reference)),bytes);
	assert.equal(getDocument(doc.id)?.reference,doc.reference);
	assert.deepEqual(addDocument(doc.name,bytes),doc);
	const alias=addDocument("autre nom.pdf",bytes);
	assert.equal(alias.attachmentId,doc.attachmentId);
	assert.equal(listDocuments().length,2);
	assert.deepEqual(readAttachment(putAttachment(bytes)),bytes);
	assert.throws(()=>resolveLibraryPath("library://../../auth.json"),/introuvable/);
	assert.throws(()=>readAttachment("../auth.json"),/Invalid/);
});
test("corrupt content is refused instead of silently being sent to a provider", () => {
	const id=putAttachment(Buffer.from("corruption-test"));
	fs.writeFileSync(path.join(data,"attachments",id+".bin"),"damaged");
	assert.throws(()=>readAttachment(id),/corrupt/);
	assert.throws(()=>snapshot(data),/integrity/);
	fs.rmSync(path.join(data,"attachments",id+".bin"));
});

test("staged live imports publish atomically and stale imports preserve new edits", async () => {
	const { stageSyncFiles, stagedSyncFiles, discardSyncStage } = await import("../src/store/sync.ts");
	const { manifestOf } = await import("../scripts/sync/sync-data.mjs");
	const { randomUUID } = await import("node:crypto");
	const before = snapshot(data);
	const files = { ...before.files, "chats/incoming.json": Buffer.from('{"id":"incoming","messages":[]}').toString("base64") };
	const txn = randomUUID();
	stageSyncFiles(txn, { "chats/incoming.json": files["chats/incoming.json"] });
	assert.equal(fs.existsSync(path.join(data,"chats/incoming.json")),false);
	assert.deepEqual({...stagedSyncFiles(txn,manifestOf(files),before.revision)},files);
	fs.writeFileSync(path.join(data,"chats/concurrent.json"),'{"id":"concurrent","messages":[]}');
	assert.throws(()=>stagedSyncFiles(txn,manifestOf(files),before.revision),/Local data changed/);
	assert.equal(fs.existsSync(path.join(data,"chats/concurrent.json")),true);
	discardSyncStage(txn);
	assert.throws(()=>stageSyncFiles("../../escape",{}),/Invalid/);
});
