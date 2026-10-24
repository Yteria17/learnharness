import { withSyncMutation } from "@/src/server";
import { addDocument, listDocuments } from "@/src/server";
import { MAX_ATTACHMENT_BYTES } from "@/src/core";

export const dynamic = "force-dynamic";
export async function GET() { return Response.json({ documents: listDocuments() }); }
export const POST = withSyncMutation(async (request: Request) => {
	try {
		const form = await request.formData();
		const files = form.getAll("files").filter((file): file is File => file instanceof File);
		if (!files.length || files.length > 20) throw new Error("Sélectionnez entre 1 et 20 documents.");
		if (files.reduce((total, file) => total + file.size, 0) > 64 * 1024 * 1024) throw new Error("Ajoutez ces fichiers en plusieurs envois (64 Mo maximum par envoi).");
		if (files.some((file) => file.size > MAX_ATTACHMENT_BYTES)) throw new Error("Document trop volumineux (50 Mo maximum par fichier).");
		const documents = [];
		for (const file of files) documents.push(addDocument(file.name, new Uint8Array(await file.arrayBuffer()), file.type));
		return Response.json({ documents });
	} catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
});
