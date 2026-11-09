import { getAssetProfile, getQuoteHistory, updateQuote } from "@/adapters";
import type { DraftActivity, SourceImportQuote } from "../context/import-context";

/** Awaited local price writes, using the same API and events as the price editor. */
export async function saveImportSourceQuotes(
  quotes: SourceImportQuote[],
  drafts: DraftActivity[],
  options: { validateOnly?: boolean; allowActivityPrices?: boolean } = {},
): Promise<void> {
  for (const quote of quotes) {
    const ids = new Set(
      drafts
        .filter((draft) => draft.sourceQuoteSymbol === quote.symbol)
        .map((draft) => draft.assetId)
        .filter((id): id is string => !!id),
    );
    if (ids.size === 0) throw new Error("quote-asset-missing");
    if (ids.size > 1) throw new Error("quote-multiple-assets");
    const assetId = [...ids][0];
    const asset = await getAssetProfile(assetId);
    if (asset.quoteMode !== "MANUAL") throw new Error("quote-asset-not-manual");
    if (asset.quoteCcy.toUpperCase() !== quote.currency.toUpperCase())
      throw new Error("quote-currency-mismatch");
    const assetSymbol = asset.instrumentSymbol || asset.displayCode;
    if (assetSymbol?.trim().toUpperCase() !== quote.symbol.trim().toUpperCase())
      throw new Error("quote-symbol-mismatch");
    const existing = (await getQuoteHistory(assetId)).filter(
      (item) => item.timestamp.slice(0, 10) === quote.date && item.dataSource === "MANUAL",
    );
    if (existing.length) {
      if (
        existing.some(
          (item) =>
            item.currency !== quote.currency ||
            (Number(item.close) !== Number(quote.price) &&
              !(
                options.allowActivityPrices &&
                drafts.some(
                  (draft) =>
                    draft.assetId === assetId &&
                    draft.activityDate.slice(0, 10) === quote.date &&
                    Number(draft.unitPrice) === Number(item.close),
                )
              )),
        )
      )
        throw new Error("quote-existing-conflict");
      if (existing.every((item) => Number(item.close) === Number(quote.price))) continue;
    }
    const close = Number(quote.price);
    if (!Number.isFinite(close) || close <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(quote.date))
      throw new Error("invalid-quote");
    if (options.validateOnly) continue;
    await updateQuote(assetId, {
      id: "",
      assetId,
      timestamp: `${quote.date}T00:00:00Z`,
      dataSource: "MANUAL",
      currency: quote.currency,
      createdAt: new Date().toISOString(),
      open: close,
      high: close,
      low: close,
      close,
      adjclose: close,
      volume: 0,
      notes: "Santander pension statement closing value",
    });
  }
}
