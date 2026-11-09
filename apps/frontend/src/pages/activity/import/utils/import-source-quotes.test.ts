import { beforeEach, expect, it, vi } from "vitest";
import { saveImportSourceQuotes } from "./import-source-quotes";
import type { DraftActivity } from "../context/import-context";
const adapters = vi.hoisted(() => ({
  getAssetProfile: vi.fn(),
  getQuoteHistory: vi.fn(),
  updateQuote: vi.fn(),
}));
vi.mock("@/adapters", () => adapters);
const quote = { symbol: "SANPP212001", date: "2026-03-31", price: "1.69667", currency: "EUR" };
const drafts = [
  { sourceQuoteSymbol: quote.symbol, assetId: "asset", comment: "User changed this" },
] as DraftActivity[];
beforeEach(() => {
  vi.clearAllMocks();
  adapters.getAssetProfile.mockResolvedValue({
    quoteMode: "MANUAL",
    quoteCcy: "EUR",
    instrumentSymbol: quote.symbol,
  });
  adapters.getQuoteHistory.mockResolvedValue([]);
  adapters.updateQuote.mockResolvedValue(undefined);
});
it("saves closing quotes using the existing local writer, independent of edited comments", async () => {
  await saveImportSourceQuotes([quote], drafts);
  expect(adapters.updateQuote).toHaveBeenCalledWith(
    "asset",
    expect.objectContaining({
      close: 1.69667,
      timestamp: "2026-03-31T00:00:00Z",
      currency: "EUR",
      dataSource: "MANUAL",
    }),
  );
});
it("preserves an existing manually edited closing quote", async () => {
  adapters.getQuoteHistory.mockResolvedValue([
    { timestamp: "2026-03-31T00:00:00Z", close: 2, currency: "EUR", dataSource: "MANUAL" },
  ]);
  await expect(saveImportSourceQuotes([quote], drafts)).rejects.toThrow("quote-existing-conflict");
  expect(adapters.updateQuote).not.toHaveBeenCalled();
});
it("reports the exact asset conflict during the preflight check", async () => {
  await expect(saveImportSourceQuotes([quote], [])).rejects.toThrow("quote-asset-missing");
  await expect(
    saveImportSourceQuotes([quote], [drafts[0], { ...drafts[0], assetId: "other" }]),
  ).rejects.toThrow("quote-multiple-assets");

  adapters.getAssetProfile.mockResolvedValueOnce({
    quoteMode: "MARKET",
    quoteCcy: "EUR",
    instrumentSymbol: quote.symbol,
  });
  await expect(saveImportSourceQuotes([quote], drafts)).rejects.toThrow("quote-asset-not-manual");

  adapters.getAssetProfile.mockResolvedValueOnce({
    quoteMode: "MANUAL",
    quoteCcy: "USD",
    instrumentSymbol: quote.symbol,
  });
  await expect(saveImportSourceQuotes([quote], drafts)).rejects.toThrow("quote-currency-mismatch");

  adapters.getAssetProfile.mockResolvedValueOnce({
    quoteMode: "MANUAL",
    quoteCcy: "EUR",
    instrumentSymbol: "OTHER",
  });
  await expect(saveImportSourceQuotes([quote], drafts)).rejects.toThrow("quote-symbol-mismatch");
});
it("checks conflicts before import and restores the closing value after an activity fallback price", async () => {
  await saveImportSourceQuotes([quote], drafts, { validateOnly: true });
  expect(adapters.updateQuote).not.toHaveBeenCalled();
  const datedDrafts = [{ ...drafts[0], activityDate: quote.date, unitPrice: "1.7" }];
  adapters.getQuoteHistory.mockResolvedValue([
    { timestamp: quote.date + "T12:00:00Z", close: 1.7, currency: "EUR", dataSource: "MANUAL" },
  ]);
  await saveImportSourceQuotes([quote], datedDrafts, { allowActivityPrices: true });
  expect(adapters.updateQuote).toHaveBeenCalledWith(
    "asset",
    expect.objectContaining({ close: 1.69667 }),
  );
});
it("does not write an equal quote twice or acquire new calls for other sources", async () => {
  adapters.getQuoteHistory.mockResolvedValue([
    { timestamp: "2026-03-31T00:00:00Z", close: 1.69667, currency: "EUR", dataSource: "MANUAL" },
  ]);
  await saveImportSourceQuotes([quote], drafts);
  expect(adapters.updateQuote).not.toHaveBeenCalled();
  vi.clearAllMocks();
  await saveImportSourceQuotes([], []);
  expect(adapters.getAssetProfile).not.toHaveBeenCalled();
});
