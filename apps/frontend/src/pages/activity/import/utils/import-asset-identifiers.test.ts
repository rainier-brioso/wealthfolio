import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAssetProfile, updateAssetProfile } from "@/adapters";
import type { DraftActivity } from "../context";
import type { Asset } from "@/lib/types";
import { retainImportAssetIdentifiers } from "./import-asset-identifiers";

vi.mock("@/adapters", () => ({ getAssetProfile: vi.fn(), updateAssetProfile: vi.fn() }));
const draft = (overrides: Partial<DraftActivity> = {}) =>
  ({ assetId: "fund", isin: "ie000zyrh0q7", status: "valid", ...overrides }) as DraftActivity;
const asset = (metadata?: Asset["metadata"]): Asset => ({
  id: "fund",
  kind: "INVESTMENT",
  quoteMode: "MARKET",
  quoteCcy: "EUR",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  metadata,
});

describe("import asset identifiers", () => {
  beforeEach(() => vi.resetAllMocks());

  it("fills the missing ISIN once and preserves other metadata", async () => {
    vi.mocked(getAssetProfile).mockResolvedValue(
      asset({
        profile: { quoteType: "MUTUALFUND" },
        identifiers: { cusip: "existing" },
      }),
    );
    await retainImportAssetIdentifiers([draft(), draft()]);
    expect(getAssetProfile).toHaveBeenCalledTimes(1);
    expect(updateAssetProfile).toHaveBeenCalledExactlyOnceWith({
      id: "fund",
      name: undefined,
      notes: "",
      metadata: {
        profile: { quoteType: "MUTUALFUND" },
        identifiers: { cusip: "existing", isin: "IE000ZYRH0Q7" },
      },
    });
  });

  it("preserves an existing ISIN, including a conflicting user edit", async () => {
    vi.mocked(getAssetProfile).mockResolvedValue(asset({ identifiers: { isin: "IE000QAZP7L2" } }));
    await retainImportAssetIdentifiers([draft()]);
    expect(updateAssetProfile).not.toHaveBeenCalled();
  });

  it("does not touch skipped duplicates, missing identities or ambiguous assets", async () => {
    await retainImportAssetIdentifiers([
      draft({ status: "duplicate" }),
      draft({ assetId: undefined }),
      draft({ isin: undefined }),
    ]);
    await retainImportAssetIdentifiers([draft(), draft({ isin: "IE000QAZP7L2" })]);
    expect(getAssetProfile).not.toHaveBeenCalled();
  });

  it("propagates persistence failures before importing activities", async () => {
    vi.mocked(getAssetProfile).mockResolvedValue(asset());
    vi.mocked(updateAssetProfile).mockRejectedValue(new Error("write failed"));
    await expect(retainImportAssetIdentifiers([draft()])).rejects.toThrow("write failed");
  });
});
