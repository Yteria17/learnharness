import { getDocument } from "@/src/server";
import { readAttachment } from "@/src/server";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
	const doc = getDocument((await context.params).id);
	if (!doc) return Response.json({ error: "Document introuvable" }, { status: 404 });
	try {
		return new Response(new Uint8Array(readAttachment(doc.attachmentId)), { headers: {
			"Content-Type": doc.mimeType,
			"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(doc.name).replace(/'/g, "%27")}`,
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "private, no-store",
		} });
	} catch { return Response.json({ error: "Fichier absent ou endommagé. Vérifiez la synchronisation." }, { status: 409 }); }
}
