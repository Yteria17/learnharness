import { liveSyncApply, liveSyncSnapshot, liveSyncCommit, stageSyncFiles, discardSyncStage } from "@/src/server";

export const dynamic = "force-dynamic";

/** Desktop capability checks apply in proxy.ts. This handler must not count
 * itself as a normal mutation: it checks the other requests' barrier instead. */
export async function POST(request: Request) {
	try {
		const body = await request.json();
		if (body?.op === "snapshot") return Response.json(liveSyncSnapshot());
		if (body?.op === "stage") { stageSyncFiles(body.transaction, body.files); return Response.json({ ok: true }); }
		if (body?.op === "discard") { discardSyncStage(body.transaction); return Response.json({ ok: true }); }
		if (body?.op === "commit") return Response.json(liveSyncCommit(body.transaction, body.manifest, body.expected));
		if (body?.op !== "apply" || typeof body.expected !== "string" || !/^[a-f0-9]{64}$/.test(body.expected)) return Response.json({ error: "Invalid sync operation" }, { status: 400 });
		return Response.json(liveSyncApply(body.files, body.expected));
	} catch (error) {
		const failure = error as Error & { code?: string };
		return Response.json({ error: failure.message || "Synchronization failed", code: failure.code }, { status: failure.code === "deferred" ? 409 : 400 });
	}
}
