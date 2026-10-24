"use client";

import { useEffect, useRef, useState } from "react";
import type { DesktopSyncStatus } from "@/src/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toggle } from "./controls.tsx";

export function useDesktopSync() {
	const [status, setStatus] = useState<DesktopSyncStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		const bridge = window.lh?.sync;
		if (!bridge) return;
		let active = true;
		const refresh = async () => {
			try {
				const next = await bridge.status();
				if (!active) return;
				if ("error" in next) { setError(next.error); return; }
				setStatus((previous) => !previous || next.revision >= previous.revision ? next : previous);
				setError(null);
			} catch { if (active) setError("Could not read synchronization status."); }
		};
		const off = bridge.onChange(() => { void refresh(); });
		void refresh();
		return () => { active = false; off(); };
	}, []);
	return { status, error };
}

export function syncStatusLabel(status: DesktopSyncStatus): string {
	if (!status.enabled) return "Sync disabled";
	if (status.phase === "syncing") return "Synchronizing…";
	if (status.phase === "conflict") return "Sync conflict — local copy preserved";
	if (status.phase === "offline") return "Sync pending — using local data";
	if (status.phase === "waiting") return "Sync waiting for the current operation to finish";
	if (status.phase === "pending") return "Sync scheduled";
	return status.lastSyncAt ? `Last sync: ${new Date(status.lastSyncAt).toLocaleString()}` : "Automatic live sync";
}

export function SyncIndicator({ onOpen }: { onOpen: () => void }) {
	const { status } = useDesktopSync();
	if (!status?.enabled) return null;
	const problem = status.phase === "offline" || status.phase === "conflict";
	return <button type="button" onClick={onOpen} data-testid="sync-indicator"
		className={`mb-1 w-full rounded-md px-2 py-1.5 text-left text-[11px] ${problem ? "text-amber-500" : "text-muted-foreground"}`}
		title="Changes sync automatically while the app is open, after saves and at least every 10 seconds.">
		{syncStatusLabel(status)}
	</button>;
}

export function SyncSection() {
	const { status, error: readError } = useDesktopSync();
	const [enabled, setEnabled] = useState(false);
	const [host, setHost] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const mounted = useRef(true);
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	useEffect(() => {
		if (status) { setEnabled(status.enabled); setHost(status.host); }
	}, [status?.enabled, status?.host]);
	const changed = !!status && (enabled !== status.enabled || host.trim() !== status.host);
	async function act(kind: "save" | "now") {
		const bridge = window.lh?.sync;
		if (!bridge || busy) return;
		setBusy(true); setError(null); setSaved(false);
		try {
			const result = kind === "save" ? await bridge.configure({ enabled, host: host.trim() }) : await bridge.now();
			if (!mounted.current) return;
			if ("error" in result) setError(result.error);
			else if (kind === "save") setSaved(true);
		} catch { if (mounted.current) setError("Could not update synchronization. Please retry."); }
		finally { if (mounted.current) setBusy(false); }
	}
	if (!status) return <p className="text-xs text-muted-foreground">{readError || "Automatic synchronization is available in the desktop app."}</p>;
	return <div className="space-y-4 text-xs" data-testid="sync-section">
		<p className="leading-relaxed text-muted-foreground">Changes sync automatically while the app stays open: shortly after saves and every 10 seconds. Data received from another computer appears in place. Incoming changes wait for active replies or background operations to finish.</p>
		<label className="flex items-center gap-3">
			<Toggle checked={enabled} label="automatic synchronization" disabled={busy} onChange={(next) => { setEnabled(next); setSaved(false); }} />
			Automatic synchronization
		</label>
		<label className="block space-y-2">
			<span>SSH server</span>
			<Input aria-label="SSH server" value={host} disabled={busy} placeholder="user@server or SSH alias" onChange={(event) => { setHost(event.target.value); setSaved(false); }} />
		</label>
		<p className="leading-relaxed text-muted-foreground">This computer must already have SSH key access and trust the server host key. Its SSH configuration, keys and ChatGPT sign-in stay local.</p>
		<div className="flex flex-wrap gap-2">
			<Button size="sm" variant="outline" disabled={busy || status.phase === "syncing" || !changed} onClick={() => void act("save")}>Save</Button>
			<Button size="sm" variant="outline" disabled={busy || status.phase === "syncing" || changed || !status.enabled} onClick={() => void act("now")}>Sync now</Button>
		</div>
		{saved && <p role="status">Saved on this computer.{enabled ? " Live synchronization is enabled." : " Automatic synchronization is disabled."}</p>}
		<p role="status" data-testid="sync-status">{syncStatusLabel(status)}</p>
		{(error || readError || status.message) && <p role="alert" className="whitespace-pre-wrap break-words text-amber-500">{error || readError || status.message}</p>}
		<p className="leading-relaxed text-muted-foreground">You can work offline; transfers retry automatically. Changes to separate sessions are merged. Concurrent edits to the same session are preserved and reported as a conflict. Conversations, exercises, graph and nonsecret preferences are shared. Saved screenshots travel with their conversations. The shared profile is limited to 64 MiB. Original documents stored elsewhere are not transferred.</p>
	</div>;
}
