export interface DesktopSyncStatus {
	available: boolean;
	enabled: boolean;
	host: string;
	phase: "disabled" | "pending" | "syncing" | "synced" | "offline" | "conflict" | "waiting";
	lastSyncAt: string | null;
	message: string | null;
	pendingRestart: boolean;
	revision: number;
}

export interface DesktopSyncBridge {
	status: () => Promise<DesktopSyncStatus | { error: string }>;
	configure: (config: { enabled: boolean; host: string }) => Promise<DesktopSyncStatus | { error: string }>;
	now: () => Promise<DesktopSyncStatus | { error: string }>;
	restart: () => Promise<DesktopSyncStatus | { error: string }>;
	onChange: (callback: () => void) => () => void;
}
