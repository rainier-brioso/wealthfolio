import { getAssetProfile, updateAssetProfile } from "@/adapters";
import type { DraftActivity } from "../context";

/** Fill missing identifiers only when the user commits the import, never during preview. */
export async function retainImportAssetIdentifiers(drafts: DraftActivity[]): Promise<void> {
  const isinsByAsset = new Map<string, Set<string>>();
  for (const draft of drafts) {
    const isin = draft.isin?.trim().toUpperCase();
    if (!draft.assetId || !isin || (draft.status === "duplicate" && !draft.forceImport)) continue;
    const isins = isinsByAsset.get(draft.assetId) ?? new Set<string>();
    isins.add(isin);
    isinsByAsset.set(draft.assetId, isins);
  }

  for (const [id, isins] of isinsByAsset) {
    // Ambiguous source identity must not be written onto a shared asset.
    if (isins.size !== 1) continue;
    const asset = await getAssetProfile(id);
    const metadata = asset.metadata ?? {};
    const identifiers = metadata.identifiers;
    if (identifiers != null && (typeof identifiers !== "object" || Array.isArray(identifiers))) {
      continue;
    }
    const existing = (identifiers ?? {}) as Record<string, unknown>;
    if (existing.isin != null && (typeof existing.isin !== "string" || existing.isin.trim()))
      continue;
    await updateAssetProfile({
      id,
      name: asset.name,
      notes: asset.notes ?? "",
      metadata: { ...metadata, identifiers: { ...existing, isin: [...isins][0] } },
    });
  }
}
