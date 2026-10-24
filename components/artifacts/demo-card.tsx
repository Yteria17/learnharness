"use client";

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { DownloadIcon, Maximize2Icon, Minimize2Icon } from "lucide-react";
import { Toggle } from "@/components/settings/controls";
import { InvertDiscIcon } from "@/components/artifacts/invert-disc";
import { ChatActionsContext } from "@/components/chat";
import { downloadFile, slugFilename } from "@/components/artifacts/download";
import { DispatchCard } from "@/components/artifacts/dispatch-card";
import type { ArtifactPartProps, DemoResult } from "@/src/core";

/**
 * Demo artifact card (W6): while the part is input-available, a job activity
 * card (the chat view's jobs feed — the job-card idiom); when output-available, the demo
 * runs in a SANDBOXED iframe (sandbox="allow-scripts", no allow-same-origin →
 * no access to app storage/cookies/DOM).
 *
 * The bridge script (contracts.ts "Demo iframe bridge") is auto-injected into
 * every demo by buildDemoSrcDoc — never the model's job: ResizeObserver →
 * postMessage {type:"demo-resize",height} (parent sizes the iframe) and
 * window.onerror → {type:"demo-error",message} (error chip on the card, with
 * a "Send to teacher" button that feeds the error back into the lesson — the
 * fix loop).
 *
 * Bridge message handling is a pure function (reduceDemoBridgeState) so
 * tests cover it without a DOM.
 */

// ─── bridge injection + message handling (pure, testable) ───────────────────

export const DEMO_BRIDGE_SCRIPT = `<script>(function(){
var send=function(m){try{parent.postMessage(m,"*")}catch(e){}};
var theme=function(){
var color=function(el){var c=getComputedStyle(el).backgroundColor;var n=c.match(/[\\d.]+/g);return n&&n.length>=3&&(n.length<4||Number(n[3])>0)?n.map(Number):null};
var c=(document.body&&color(document.body))||color(document.documentElement)||[255,255,255];
send({type:"demo-theme",dark:(c[0]*0.2126+c[1]*0.7152+c[2]*0.0722)<128})
};
window.addEventListener("keydown",function(e){if(e.key==="Escape"){send({type:"demo-escape"})}});
var post=function(){
theme();
var b=document.body;
if(!b){send({type:"demo-resize",height:document.documentElement.scrollHeight});return}
var h=Math.max(b.scrollHeight,b.getBoundingClientRect().height);
var cs=getComputedStyle(b);
h+=(parseFloat(cs.marginTop)||0)+(parseFloat(cs.marginBottom)||0);
send({type:"demo-resize",height:Math.ceil(h)})
};
if(typeof ResizeObserver!=="undefined"){new ResizeObserver(post).observe(document.documentElement)}
window.addEventListener("resize",post);
window.addEventListener("load",post);
window.addEventListener("error",function(e){send({type:"demo-error",message:e.message||String(e)})});
setTimeout(post,50);
setTimeout(post,400);
})();</script>`;

/** Inject the bridge before </body> (or at the end of a body-less document). */
export function buildDemoSrcDoc(html: string): string {
	if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${DEMO_BRIDGE_SCRIPT}</body>`);
	return `${html}${DEMO_BRIDGE_SCRIPT}`;
}

export interface DemoBridgeState {
	height: number | null;
	error: string | null;
}

export const INITIAL_DEMO_BRIDGE_STATE: DemoBridgeState = { height: null, error: null };

const MIN_HEIGHT = 80;
const MAX_HEIGHT = 2400;

/** Pure reducer over incoming postMessage data (contracts.ts DemoBridgeMessage). */
export function reduceDemoBridgeState(state: DemoBridgeState, data: unknown): DemoBridgeState {
	if (typeof data !== "object" || data === null) return state;
	const message = data as { type?: unknown; height?: unknown; message?: unknown };
	if (message.type === "demo-resize") {
		if (typeof message.height !== "number" || !Number.isFinite(message.height) || message.height <= 0) return state;
		const height = Math.min(Math.max(Math.round(message.height), MIN_HEIGHT), MAX_HEIGHT);
		return height === state.height ? state : { ...state, height };
	}
	if (message.type === "demo-error") {
		const text = typeof message.message === "string" && message.message.trim() ? message.message : "unknown error";
		return text === state.error ? state : { ...state, error: text };
	}
	return state;
}

// ─── the demo card ──────────────────────────────────────────────────────────

/** The demo tool-call box: the part's output is the dispatch ack — the box
 * is the DispatchCard (live status via the chat view's jobs feed). The demo
 * itself renders from the steer message via DemoOutputCard. */
export function DemoCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	return <DispatchCard toolCallId={part.toolCallId} kind="demo" />;
}

/** The demo artifact — exported: the steer card renders the delivered
 *  result. `messageId` + `initialInverted` carry the PERSISTED invert
 *  switch (details.ui.inverted via the artifact-ui route, owner 2026-10-07). */
export function DemoOutputCard({
	output,
	messageId,
	initialInverted,
}: {
	output: unknown;
	messageId?: string;
	initialInverted?: boolean;
}) {
	const result = output as DemoResult | undefined;
	if (!result || typeof result.html !== "string" || typeof result.title !== "string") {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				Demo completed, but the result could not be displayed.
			</div>
		);
	}
	const failed = result.html.length === 0;
	if (failed) {
		return (
			<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="demo-card-failed">
				<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Interactive demo
					<span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">failed</span>
				</div>
				<p className="mt-2 text-sm text-muted-foreground">{result.notes ?? "The demo could not be built."}</p>
			</div>
		);
	}
	return (
		<DemoFrame title={result.title} html={result.html} messageId={messageId} initialInverted={initialInverted} />
	);
}

function DemoFrame({
	title,
	html,
	messageId,
	initialInverted,
}: {
	title: string;
	html: string;
	messageId?: string;
	initialInverted?: boolean;
}) {
	const actions = useContext(ChatActionsContext);
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const cardRef = useRef<HTMLDivElement | null>(null);
	const fullscreenButtonRef = useRef<HTMLButtonElement | null>(null);
	const nativeFullscreen = useRef(false);
	const [expanded, setExpanded] = useState(false);
	const [sourceDark, setSourceDark] = useState(false);
	const [state, setState] = useState<DemoBridgeState>(INITIAL_DEMO_BRIDGE_STATE);
	// Brightness inversion (owner, 2026-10-07): the switch state PERSISTS on
	// the steer record (details.ui.inverted) — seeded here, written through
	// the silent artifact-ui route on toggle. Without a chat page (tests,
	// previews) the toggle stays local-only. The filter rides the iframe
	// element, which carries the card's white backing, so one filter flips
	// page + content together while hue-rotate(180deg) undoes invert's hue
	// flip.
	const [inversionOverride, setInverted] = useState<boolean | undefined>(initialInverted);
	// Old light demos adapt automatically; authored dark demos keep their own colors.
	const inverted = inversionOverride ?? !sourceDark;
	const toggleInverted = (next: boolean) => {
		setInverted(next);
		if (!actions?.chatId || !messageId) return;
		void fetch(`/api/chats/${actions.chatId}/artifact-ui`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { messageId, inverted: next } }),
		}).catch(() => {});
	};
	const srcDoc = useMemo(() => buildDemoSrcDoc(html), [html]);

	const expandedRef = useRef(expanded);
	expandedRef.current = expanded;
	const closeExpanded = async () => {
		if (document.fullscreenElement === cardRef.current) await document.exitFullscreen().catch(() => {});
		setExpanded(false);
		fullscreenButtonRef.current?.focus();
	};
	const toggleExpanded = () => {
		if (expanded) { void closeExpanded(); return; }
		setExpanded(true);
		// The CSS expansion is also the fallback when native fullscreen is unavailable.
		void cardRef.current?.requestFullscreen?.().catch(() => {});
	};
	useEffect(() => {
		const onFullscreen = () => {
			const ours = document.fullscreenElement === cardRef.current;
			if (nativeFullscreen.current && !ours) { setExpanded(false); fullscreenButtonRef.current?.focus(); }
			nativeFullscreen.current = ours;
		};
		document.addEventListener("fullscreenchange", onFullscreen);
		return () => document.removeEventListener("fullscreenchange", onFullscreen);
	}, []);
	useEffect(() => {
		if (!expanded) return;
		const overflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		const escape = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault(); event.stopPropagation();
			void closeExpanded();
		};
		window.addEventListener("keydown", escape, true);
		return () => { document.body.style.overflow = overflow; window.removeEventListener("keydown", escape, true); };
	}, [expanded]);

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			// Only messages from THIS demo's iframe (the sandbox gives it an
			// opaque origin; the window reference still matches).
			if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
			if (event.data?.type === "demo-theme" && typeof event.data.dark === "boolean") setSourceDark(event.data.dark);
			if (event.data?.type === "demo-escape" && expandedRef.current) void closeExpanded();
			setState((prev) => reduceDemoBridgeState(prev, event.data));
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, []);

	return (
		<div ref={cardRef} className={expanded ? "fixed inset-0 z-[80] flex h-dvh w-screen flex-col border bg-card p-4 text-card-foreground" : "rounded-xl border bg-card p-4 text-card-foreground"} data-testid="demo-card" data-demo-expanded={expanded} role={expanded ? "dialog" : undefined} aria-modal={expanded || undefined} aria-label={expanded ? title : undefined}>
			{/* Caption header (owner, 2026-10-07): kind label + title in the
			   label's size/tracking (title normal-case, foreground) — the
			   figure card's grammar plus a name. Switch + download far right. */}
			<div className="flex items-center justify-between gap-2">
				<div className="flex min-w-0 items-baseline gap-2">
					<span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
						interactive demo
					</span>
					<span className="truncate text-xs font-medium tracking-wide text-foreground">{title}</span>
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					<button ref={fullscreenButtonRef} type="button" onClick={toggleExpanded} data-testid="demo-fullscreen" aria-label={expanded ? "Exit demo fullscreen" : "Expand demo fullscreen"} title={expanded ? "Réduire (Échap)" : "Agrandir la démo"} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
						{expanded ? <Minimize2Icon className="size-3.5" /> : <Maximize2Icon className="size-3.5" />}
					</button>
					<Toggle
						checked={inverted}
						onChange={toggleInverted}
						label="Invert demo brightness"
						title="Invert colors"
						discIcon={<InvertDiscIcon className="size-3" />}
					/>
					<button
						type="button"
						aria-label="Download demo as HTML"
						title="Download as HTML"
						onClick={() => downloadFile(`${slugFilename(title)}.html`, html, "text/html")}
						data-testid="demo-download"
						className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<DownloadIcon className="size-3.5" />
					</button>
				</div>
			</div>
			{state.error && (
				<DemoErrorChip
					title={title}
					message={state.error}
					onSend={actions ? () => actions.sendText(`The demo "${title}" threw an error: ${state.error}`) : undefined}
				/>
			)}
			<iframe
				ref={iframeRef}
				title={title}
				// allow-scripts ONLY — no allow-same-origin: the demo can run code
				// but never touch the app's storage, cookies, or DOM.
				sandbox="allow-scripts"
				srcDoc={srcDoc}
				// scrolling OFF (owner, 2026-10-07): the bridge auto-sizes the
				// iframe to its content, so an internal scrollbar can only appear
				// before the first resize lands — and a scrollable iframe TRAPS
				// the wheel (session scrolling stalls over the demo). With
				// scrolling disabled the wheel chains straight to the session.
				scrolling={expanded ? "auto" : "no"}
				className={`mt-2 w-full rounded-lg border bg-white ${expanded ? "min-h-0 flex-1" : ""}`}
				// content-box: the bridge reports the CONTENT height — with the
				// preflight's border-box the 2px border would eat into it and clip
				// the bottom of the demo (smoke finding, 2026-10-07).
				style={{
					height: expanded ? "100%" : state.height ?? 360,
					boxSizing: "content-box",
					filter: inverted ? "invert(1) hue-rotate(180deg)" : undefined,
				}}
				data-testid="demo-iframe"
			/>
		</div>
	);
}

export function DemoErrorChip({
	title,
	message,
	onSend,
}: {
	title: string;
	message: string;
	onSend?: () => void;
}) {
	return (
		<div
			className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500"
			data-testid="demo-error-chip"
		>
			<span className="font-medium">This demo threw an error</span>
			<span className="min-w-0 flex-1 truncate font-mono text-xs" title={message}>
				{message}
			</span>
			{onSend && (
				<button
					type="button"
					onClick={onSend}
					className="rounded-md border border-red-500/40 px-2 py-1 text-xs font-medium hover:bg-red-500/15"
					data-testid="demo-error-send"
				>
					Send to teacher
				</button>
			)}
		</div>
	);
}
