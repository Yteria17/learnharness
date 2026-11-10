import { subscriptionControlsResponse, withSyncMutation } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = subscriptionControlsResponse;
export const POST = withSyncMutation(subscriptionControlsResponse);
