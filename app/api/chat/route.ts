import { withSyncMutation } from "@/src/server";
import { handleChatRequest } from "@/src/server";

export const POST = withSyncMutation(async function POST(req: Request) {
	return handleChatRequest(req);
});
