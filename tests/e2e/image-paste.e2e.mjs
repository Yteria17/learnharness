/**
 * END-TO-END: composer image paste (spec:
 * docs/superpowers/plans/2026-10-24-chat-image-paste-spec-and-plan.md).
 *
 * Real Next server + real Chrome, no provider spend: the browser-side
 * clipboard work (paste → draft → preview → lightbox → remove) on EVERY
 * sending surface (home, /chat/new, a live session), the first-message
 * handoff that a `?prompt=` URL cannot carry, and the server's trust
 * boundary over real HTTP.
 *
 *   npm run test:e2e
 *
 * Requirements: a built app (`npm run build`) and Google Chrome (or set
 * LH_E2E_CHROME). Not part of `npm test`: it boots a server and a browser.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import puppeteer from "puppeteer-core";
import crypto from "node:crypto";
import { installLiveSnapshot } from "../../scripts/sync/sync-data.mjs";

const PORT = Number(process.env.LH_E2E_PORT ?? 3311);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.LH_E2E_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** A real (tiny) PNG: the clipboard refuses fake bytes, so the fixture must decode. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const SLOT = { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } };

let server;
let browser;
let page;
let dataDir;
const created = [];

/** A session whose three model slots are pinned: the first-run gate is a
 *  real gate, and the paste → send surfaces sit behind it. The provider key
 *  is fake, so a turn can never reach (or bill) a model. */
function writeSettings(dir) {
	fs.writeFileSync(
		path.join(dir, "settings.json"),
		JSON.stringify({ models: { strong: SLOT, cheap: SLOT, vision: SLOT } }, null, "\t"),
	);
}

async function waitForServer(timeoutMs = 120_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`${BASE}/api/chats`)).ok) return;
		} catch {
			/* not listening yet */
		}
		await new Promise((r) => setTimeout(r, 400));
	}
	throw new Error(`server did not answer on ${BASE}`);
}

/** Create a session through the API, then open it. */
async function openSession(title) {
	const res = await fetch(`${BASE}/api/chats`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title }),
	});
	const { id } = await res.json();
	created.push(id);
	await page.goto(`${BASE}/chat/${id}`, { waitUntil: "networkidle2" });
	await page.waitForSelector('[data-testid="composer"] textarea');
	return id;
}

/**
 * Dispatch a REAL paste event carrying `files` at the surface's textarea —
 * every surface's own handler must pick it up (the bug this suite exists
 * for: home and the draft had no handler at all).
 */
async function pasteFiles(target, files) {
	return page.evaluate(
		async ({ selector, specs }) => {
			const data = new DataTransfer();
			for (const spec of specs) {
				const blob = await (await fetch(`data:${spec.type};base64,${spec.data}`)).blob();
				data.items.add(new File([blob], spec.name ?? "pasted", { type: spec.type }));
			}
			const textarea = document.querySelector(selector);
			if (!textarea) return { ok: false, why: "no textarea" };
			textarea.focus();
			const notCancelled = textarea.dispatchEvent(
				new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
			);
			return { ok: true, handled: !notCancelled };
		},
		{ selector: target, specs: files.map((f) => ({ type: f.type, data: f.data, name: f.name })) },
	);
}

const thumbs = () => page.$$eval('[data-testid="composer-images"] img', (els) => els.length);

before(async () => {
	// A throwaway data dir: the e2e never touches the developer's sessions.
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-e2e-"));
	writeSettings(dataDir);
	server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
		cwd: path.resolve(import.meta.dirname, "../.."),
		env: { ...process.env, LH_DATA_DIR: dataDir, NODE_ENV: "production", OPENROUTER_API_KEY: "e2e-fake-key" },
		stdio: "ignore",
	});
	await waitForServer();
	browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
	page = await browser.newPage();
	await page.setViewport({ width: 1280, height: 900 });
});

after(async () => {
	await browser?.close();
	server?.kill("SIGTERM");
	fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("composer image paste (e2e)", () => {
	it("home: paste drafts a preview whose remove cross sits at the top-right", async () => {
		await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
		await page.waitForSelector("textarea");
		assert.equal((await pasteFiles("textarea", [{ type: "image/png", data: PNG }])).handled, true);
		await page.waitForSelector('[data-testid="composer-images"] img');
		const box = await (await page.$('[data-testid="composer-images"] img')).boundingBox();
		const cbox = await (await page.$('[data-testid="composer-images"] [aria-label="Remove image"]')).boundingBox();
		assert.ok(box.width > 0 && box.height > 0, "the preview has real size");
		assert.ok(cbox.x > box.x + box.width / 2, "cross on the RIGHT half");
		assert.ok(cbox.y < box.y + box.height / 2, "cross on the TOP half");
	});

	it("session: click opens the picture full size, Esc closes it", async () => {
		await openSession("e2e lightbox");
		await pasteFiles('[data-testid="composer"] textarea', [{ type: "image/png", data: PNG }]);
		await page.waitForSelector('[data-testid="composer-images"] img');
		await page.click('[data-testid="composer-images"] button[aria-label="View pasted image in full"]');
		await page.waitForSelector('[data-testid="image-lightbox"] img');
		const src = await page.$eval('[data-testid="image-lightbox"] img', (el) => el.getAttribute("src"));
		assert.match(src, /^data:image\/png;base64,/, "the full view shows the pasted bytes");
		await page.keyboard.press("Escape");
		await page.waitForFunction(() => !document.querySelector('[data-testid="image-lightbox"]'));
	});

	it("session: the remove cross takes the image out of the draft", async () => {
		await openSession("e2e remove");
		await pasteFiles('[data-testid="composer"] textarea', [{ type: "image/png", data: PNG }]);
		await page.waitForSelector('[data-testid="composer-images"] img');
		// An image alone makes the draft sendable.
		assert.equal(await page.$eval('[data-testid="composer"] button[aria-label="Send"]', (el) => el.disabled), false);
		await page.click('[data-testid="composer-images"] [aria-label="Remove image"]');
		await page.waitForFunction(() => !document.querySelector('[data-testid="composer-images"]'));
		assert.equal(await page.$eval('[data-testid="composer"] button[aria-label="Send"]', (el) => el.disabled), true);
	});

	it("session: an unsupported clipboard image is refused in place", async () => {
		await openSession("e2e refused format");
		await pasteFiles('[data-testid="composer"] textarea', [{ type: "image/tiff", data: PNG }]);
		await page.waitForSelector('[data-testid="composer-images"] p');
		const text = await page.$eval('[data-testid="composer-images"] p', (el) => el.textContent ?? "");
		assert.match(text, /PNG, JPEG, WebP, or GIF/);
		assert.equal(await thumbs(), 0, "no thumbnail for a refused image");
	});

	it("session: send persists the picture and it survives a reload", async () => {
		await openSession("e2e send persists");
		await pasteFiles('[data-testid="composer"] textarea', [{ type: "image/png", data: PNG }]);
		await page.waitForSelector('[data-testid="composer-images"] img');
		await page.keyboard.press("Enter");
		await page.waitForSelector('[data-testid="user-image"]', { timeout: 20_000 });
		assert.equal(await thumbs(), 0, "the draft clears on send");
		await page.reload({ waitUntil: "networkidle2" });
		await page.waitForSelector('[data-testid="user-image"]', { timeout: 20_000 });
		await page.click('[data-testid="user-image"]');
		await page.waitForSelector('[data-testid="image-lightbox"] img', { timeout: 20_000 });
		await page.keyboard.press("Escape");
	});

	it("home: an image-only first message opens the new session with the picture in it", async () => {
		await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
		await page.waitForSelector("textarea");
		await pasteFiles("textarea", [{ type: "image/png", data: PNG }]);
		await page.waitForSelector('[data-testid="composer-images"] img');
		await page.evaluate(() =>
			[...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Start session")?.click(),
		);
		// The image cannot ride ?prompt= — the handoff must land it here.
		await page.waitForFunction(() => location.pathname.startsWith("/chat/") && !location.search, { timeout: 20_000 });
		const id = new URL(page.url()).pathname.split("/").pop();
		if (id) created.push(id);
		await page.waitForSelector('[data-testid="user-image"]', { timeout: 20_000 });
		assert.equal(await page.$$eval('[data-testid="user-message"]', (els) => els.length), 1, "one learner message");
	});

	it("draft: /chat/new sends the first image the same way", async () => {
		await page.goto(`${BASE}/chat/new`, { waitUntil: "networkidle2" });
		await page.waitForSelector('[data-testid="composer"] textarea');
		await pasteFiles('[data-testid="composer"] textarea', [{ type: "image/png", data: PNG }]);
		await page.waitForSelector('[data-testid="composer-images"] img');
		await page.click('[data-testid="composer"] button[aria-label="Send"]');
		await page.waitForFunction(() => location.pathname.startsWith("/chat/") && location.pathname !== "/chat/new", { timeout: 20_000 });
		const id = new URL(page.url()).pathname.split("/").pop();
		if (id) created.push(id);
		await page.waitForSelector('[data-testid="user-image"]', { timeout: 20_000 });
	});

	it("the French response language can be changed, saved and restored in Settings", async () => {
		await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
		await page.waitForSelector('[data-testid="settings-entry"]');
		await page.click('[data-testid="settings-entry"]');
		await page.waitForSelector('[data-testid="settings-nav-general"]');
		await page.click('[data-testid="settings-nav-general"]');
		await page.waitForSelector('[data-testid="select-language"]');
		assert.equal(await page.$eval('[data-testid="select-language"]', (el) => el.value), "fr");
		const saved = page.waitForResponse((response) => response.url() === `${BASE}/api/settings/general` && response.request().method() === "PUT");
		await page.select('[data-testid="select-language"]', "en");
		assert.equal((await saved).status(), 200);
		const settings = await (await fetch(`${BASE}/api/settings`)).json();
		assert.equal(settings.settings.general.language, "en");
		const restored = page.waitForResponse((response) => response.url() === `${BASE}/api/settings/general` && response.request().method() === "PUT");
		await page.select('[data-testid="select-language"]', "fr");
		assert.equal((await restored).status(), 200);
		await page.keyboard.press("Escape");
	});

	it("the server refuses a malformed image with a 400 over real HTTP", async () => {
		const chatId = await openSession("e2e server boundary");
		const res = await fetch(`${BASE}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chatId,
				input: { type: "text", text: "", images: [{ type: "image", mimeType: "image/tiff", data: PNG }] },
			}),
		});
		assert.equal(res.status, 400);
		const body = await res.json();
		assert.match(body.error ?? "", /PNG, JPEG, WebP, or GIF/);
	});
	it("library: upload, deduplicate, download exact bytes and retain after reload", async () => {
		await page.goto(`${BASE}/library`, { waitUntil: "networkidle2" });
		await page.waitForSelector('input[type="file"]');
		const fixture = path.resolve("tests/fixtures/sample-3page.pdf");
		await (await page.$('input[type="file"]')).uploadFile(fixture);
		await page.waitForFunction(() => document.querySelector("main")?.textContent?.includes("sample-3page.pdf"));
		const initial = await (await fetch(`${BASE}/api/documents`)).json();
		const doc = initial.documents.find(item => item.name === "sample-3page.pdf");
		assert.ok(doc?.reference.startsWith("library://"));
		const response = await fetch(`${BASE}/api/documents/${doc.id}`);
		assert.equal(response.status,200);
		assert.deepEqual(Buffer.from(await response.arrayBuffer()),fs.readFileSync(fixture));
		const blobs = fs.readdirSync(path.join(dataDir,"attachments")).length;
		const form = new FormData(); form.append("files",new Blob([fs.readFileSync(fixture)],{type:"application/pdf"}),"sample-3page.pdf");
		assert.equal((await fetch(`${BASE}/api/documents`,{method:"POST",body:form})).status,200);
		assert.equal(fs.readdirSync(path.join(dataDir,"attachments")).length,blobs);
		await page.reload({waitUntil:"networkidle2"});
		assert.ok(await page.$eval("main",el=>el.textContent.includes("sample-3page.pdf")));
	});

	it("library: live staged peer import refreshes the open page without a reload",async()=>{
		const request = async operation => {
			const response=await fetch(`${BASE}/api/sync`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(operation)});
			const body=await response.json(); if(!response.ok) throw Object.assign(new Error(body.error),{code:body.code}); return body;
		};
		const bytes=Buffer.from("notes from another computer");
		const hash=crypto.createHash("sha256").update(bytes).digest("hex");
		const name="notes-du-second-pc.txt";
		const id=crypto.createHash("sha256").update(`${hash}\n${name}`).digest("hex");
		const doc={id,name,attachmentId:hash,mimeType:"text/plain",size:bytes.length,reference:`library://${id}/${name}`};
		const originalUrl=page.url();
		for(let attempt=0;;attempt++){
			try {
				const before=await request({op:"snapshot"});
				const files={...before.files,[`attachments/${hash}.bin`]:bytes.toString("base64"),[`documents/${id}.json`]:Buffer.from(JSON.stringify(doc)).toString("base64")};
				await installLiveSnapshot(files,before.revision,before.files,request);
				break;
			}catch(error){ if(error.code!=="deferred"||attempt>30)throw error; await new Promise(resolve=>setTimeout(resolve,100)); }
		}
		await page.waitForFunction(()=>document.querySelector("main")?.textContent?.includes("notes-du-second-pc.txt"));
		assert.equal(page.url(),originalUrl);
		assert.deepEqual(Buffer.from(await (await fetch(`${BASE}/api/documents/${id}`)).arrayBuffer()),bytes);
	});

	async function fixtureSession(content, extraMessages = []) {
		const id = `e2e_controls_${crypto.randomUUID().replaceAll("-", "")}`;
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		fs.mkdirSync(path.join(dataDir, "chats"), {recursive:true});
		fs.writeFileSync(path.join(dataDir,"chats",id+".json"), JSON.stringify({id,version:2,title:"UI controls test",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),messages:[{id:"initial",role:"user",content:"Explique un exemple",timestamp:0},{id:"assistant",role:"assistant",content,api:"openai-completions",provider:"openrouter",model:SLOT.model.id,usage,stopReason:"toolUse",timestamp:1},...extraMessages]}));
		await page.goto(`${BASE}/chat/${id}`, {waitUntil:"networkidle2"});
		return id;
	}

	it("agent reasoning is visible, stays open, and can be collapsed manually",async()=>{
		await fixtureSession([{type:"thinking",thinking:"Résumé de raisonnement disponible."},{type:"text",text:"Voici la réponse."}]);
		await page.waitForSelector('[data-testid="agent-reasoning-content"]',{visible:true});
		assert.ok(await page.$eval('[data-testid="agent-reasoning-content"]',el=>el.textContent.includes("Résumé de raisonnement disponible.")));
		await page.click('[data-testid="agent-reasoning"] button');
		await page.waitForSelector('[data-testid="agent-reasoning-content"]',{hidden:true});
		await page.click('[data-testid="agent-reasoning"] button');
		await page.waitForSelector('[data-testid="agent-reasoning-content"]',{visible:true});
		await new Promise(resolve=>setTimeout(resolve,1200));
		assert.ok(await page.$eval('[data-testid="agent-reasoning-content"]',el=>el.getBoundingClientRect().height>0));
	});

	for(const focus of ["choice","confidence","thinking","body","free","other"]){
		it(`quiz: Enter submits once with focus on ${focus}`,async()=>{
			const args=focus==="free"?{question:"Donne un exemple"} : focus==="other"?{question:"Quel sujet ?",options:[{label:"Algèbre"},{label:"Géométrie"}]}:{type:"check",nodeId:"addition",question:"Combien font 2 + 2 ?",options:[{label:"4"},{label:"5"}],explanation:"Deux plus deux font quatre.",correctAnswer:"4"};
			await fixtureSession([{type:"toolCall",id:"quiz_keyboard",name:["free","other"].includes(focus)?"ask_user_question":"quiz",arguments:args}]);
			if(focus==="free") {await page.waitForSelector('[data-testid="answer-field"] textarea',{visible:true});await page.type('[data-testid="answer-field"] textarea',"Une réponse libre");}
			else if(focus==="other") {await page.waitForSelector('[data-testid="other-option"]',{visible:true});await page.click('[data-testid="other-option"]');await page.type('[data-testid="other-option"] input',"Analyse");}
			else {await page.waitForSelector('[data-testid="question-dock"] [data-kbdrow="0"]',{visible:true});await page.click('[data-testid="question-dock"] [data-kbdrow="0"]');}
			if(focus==="confidence") await page.focus('[data-testid="confidence-slider"]');
			if(focus==="thinking") await page.focus('[data-testid="thinking-field"] textarea');
			if(focus==="body") await page.evaluate(()=>document.activeElement.blur());
			const requests=[];
			const intercept=async req=>{
				if(req.url()===`${BASE}/api/chat`&&req.method()==="POST"){requests.push(JSON.parse(req.postData()));await req.respond({status:503,contentType:"application/json",body:JSON.stringify({error:"Test: no model request"})});}
				else await req.continue();
			};
			await page.setRequestInterception(true);page.on("request",intercept);
			try{
				if(focus==="thinking"||focus==="free") {await page.keyboard.down("Shift");await page.keyboard.press("Enter");await page.keyboard.up("Shift");assert.equal(requests.length,0);}
				await page.keyboard.press("Enter");
				await page.waitForFunction(()=>document.querySelector('[data-testid="question-dock"]')===null || document.body.textContent.includes("Test: no model request"),{timeout:10000});
				assert.equal(requests.length,1,"one physical Enter creates one submission");
				assert.equal(requests[0].input.type,"answer");
			}finally{page.off("request",intercept);await page.setRequestInterception(false);}
		});
	}

	for(const nativeDark of [false,true]){
		it(`demo: ${nativeDark?"native dark":"legacy light"} opens dark and expands without resetting controls`,async()=>{
			const html=`<!doctype html><html><head><style>body{background:${nativeDark?"#111318":"#ffffff"};color:${nativeDark?"#eee":"#111"};margin:16px}input{width:200px}</style></head><body><label>Valeur <input id="value" type="range" value="25"></label><output id="result">25</output><script>document.querySelector('input').oninput=e=>document.querySelector('output').textContent=e.target.value;<`+`/script></body></html>`;
			await fixtureSession([{type:"text",text:"Une démo interactive."}],[{id:"steer_demo_ui",role:"custom",customType:"subagent-steer",display:true,content:"Demo ready",details:{jobId:"demo_ui",kind:"demo",toolCallId:"demo_call",result:{title:"Contrôles persistants",html,tested:true}},timestamp:2}]);
			await page.waitForSelector('[data-testid="demo-iframe"]');
			await page.waitForFunction((dark)=>getComputedStyle(document.querySelector('[data-testid="demo-iframe"]')).filter.includes("invert")!==dark,{},nativeDark);
			const iframe=await page.$('[data-testid="demo-iframe"]');const frame=await iframe.contentFrame();
			await frame.waitForSelector('#value');
			await frame.$eval('#value',el=>{el.value="73";el.dispatchEvent(new Event("input",{bubbles:true}));});
			await page.click('[data-testid="demo-fullscreen"]');
			await page.waitForSelector('[data-demo-expanded="true"]');
			assert.equal(await frame.$eval('#result',el=>el.textContent),"73");
			const box=await (await page.$('[data-testid="demo-card"]')).boundingBox();assert.ok(box.width>1100&&box.height>750);
			await page.click('[data-testid="demo-fullscreen"]');
			await page.waitForSelector('[data-demo-expanded="false"]');
			assert.equal(await frame.$eval('#result',el=>el.textContent),"73");
			await page.click('[data-testid="demo-fullscreen"]');
			await page.waitForSelector('[data-demo-expanded="true"]');
			await frame.focus('#value');await page.keyboard.press("Escape");
			await page.waitForSelector('[data-demo-expanded="false"]');
			assert.equal(await frame.$eval('#result',el=>el.textContent),"73");
		});
	}

});
