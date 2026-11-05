export interface LanSyncStatus {
  role: "host" | "client" | null;
  listening: boolean;
  address: string | null;
  paired: boolean;
  ready: boolean;
  lastSyncAt: string | null;
  error: string | null;
}
