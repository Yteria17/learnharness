"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useServerEvent, useServerResync } from "@/components/server-events";
import type { LibraryDocument } from "@/src/core";

export default function LibraryPage() {
	const [documents, setDocuments] = useState<LibraryDocument[]>([]);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState("");
	const input = useRef<HTMLInputElement>(null);
	const refresh = useCallback(async () => {
		try { const response = await fetch("/api/documents"); if (!response.ok) throw new Error("Impossible de charger la bibliothèque."); setDocuments((await response.json()).documents); }
		catch (failure) { setError((failure as Error).message); }
	}, []);
	useEffect(() => { void refresh(); }, [refresh]);
	useServerEvent("profile-synced", refresh);
	useServerResync(refresh);
	async function upload(files: FileList | null) {
		if (!files?.length || busy) return;
		setBusy(true); setError("");
		try {
			for (const file of Array.from(files)) {
				const form = new FormData(); form.append("files", file);
				const response = await fetch("/api/documents", { method: "POST", body: form });
				const body = await response.json(); if (!response.ok) throw new Error(`${file.name} : ${body.error}`);
			}
			await refresh();
		} catch (failure) { setError((failure as Error).message); }
		finally { await refresh(); setBusy(false); if (input.current) input.current.value = ""; }
	}
	return <main className="mx-auto w-full max-w-4xl overflow-y-auto p-8 pt-16">
		<h1 className="mb-3 text-2xl">Bibliothèque</h1>
		<p className="mb-5 text-sm text-muted-foreground">Ajoutez vos PDF et vos notes pour les retrouver sur chaque ordinateur. Copiez la référence d’un document dans une conversation pour demander à l’agent de le lire.</p>
		<input ref={input} type="file" multiple className="hidden" aria-label="Choisir des documents" onChange={(event) => void upload(event.target.files)} />
		<Button disabled={busy} onClick={() => input.current?.click()}>{busy ? "Ajout en cours…" : "Ajouter des documents"}</Button>
		<p className="my-3 text-xs text-muted-foreground">50 Mo par fichier · Synchronisation automatique lorsque celle-ci est activée dans les réglages.</p>
		{error && <p role="alert" className="my-3 text-sm text-red-400">{error}</p>}
		{documents.length === 0 && <p className="mt-8 text-sm text-muted-foreground">Aucun document pour le moment.</p>}
		<ul className="mt-6 space-y-3">{documents.map((doc) => <li key={doc.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
			<div className="min-w-0"><p className="break-all text-sm">{doc.name}</p><p className="text-xs text-muted-foreground">{(doc.size / 1024 / 1024).toFixed(2)} Mo</p></div>
			<div className="flex gap-3"><a href={`/api/documents/${doc.id}`} className="text-sm underline">Télécharger</a>
			<button className="text-sm underline" onClick={async () => { try { await navigator.clipboard.writeText(doc.reference); setCopied(doc.id); } catch { setError("Copie impossible : réessayez depuis l’application."); } }}>{copied === doc.id ? "Référence copiée" : "Copier la référence"}</button></div>
		</li>)}</ul>
	</main>;
}
