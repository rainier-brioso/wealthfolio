import type { LanSyncStatus } from "../lan-sync-types";
import { invoke } from "./core";

export const getLanSyncStatus = () => invoke<LanSyncStatus>("lan_sync_status");
export const startLanSyncHost = (address?: string) => invoke<string>("lan_sync_host", { address });
export const joinLanSync = (invitation: string) => invoke<void>("lan_sync_join", { invitation });
export const tickLanSync = () => invoke<void>("lan_sync_tick");
export const updateLanSyncAddress = (address: string) =>
  invoke<void>("lan_sync_update_address", { address });
export const disconnectLanSync = () => invoke<void>("lan_sync_disconnect");
