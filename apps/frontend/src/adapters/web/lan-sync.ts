import type { LanSyncStatus } from "../lan-sync-types";

const unsupported = () => new Error("Wi-Fi sync requires the native desktop or mobile app");
export const getLanSyncStatus = (): Promise<LanSyncStatus> => Promise.reject(unsupported());
export const startLanSyncHost = (_address?: string): Promise<string> =>
  Promise.reject(unsupported());
export const joinLanSync = (_invitation: string): Promise<void> => Promise.reject(unsupported());
export const tickLanSync = (): Promise<void> => Promise.reject(unsupported());
export const updateLanSyncAddress = (_address: string): Promise<void> =>
  Promise.reject(unsupported());
export const disconnectLanSync = (): Promise<void> => Promise.reject(unsupported());
