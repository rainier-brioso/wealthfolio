import { describe, expect, it } from "vitest";
import { prepareKrakenImport, type KrakenCsv } from "./kraken";

const ledgerHeaders = [
  "txid",
  "refid",
  "time",
  "type",
  "asset",
  "wallet",
  "amount",
  "fee",
  "balance",
  "feeusd",
  "feecurrency",
  "aclass",
  "subclass",
];
const tradeHeaders = ["txid", "pair", "ledgers", "margin", "vol", "cost", "price", "type"];
const ledgerRow = (
  txid: string,
  refid: string,
  type: string,
  code: string,
  amount: string,
  fee: string,
  balance: string,
  feeusd = "0",
): string[] => [
  txid,
  refid,
  "2026-01-01T00:00:00Z",
  type,
  code,
  `Spot / ${code}`,
  amount,
  fee,
  balance,
  feeusd,
  code,
  "currency",
  ["EUR", "USD", "GBP", "JPY", "KWD"].includes(code) ? "fiat" : "crypto",
];
const ledger = (...rows: string[][]): KrakenCsv => ({ headers: ledgerHeaders, rows });
const trades = (...rows: string[][]): KrakenCsv => ({ headers: tradeHeaders, rows });

describe("Kraken currencies and trade direction", () => {
  it("imports USD buys without a wallet and retains the cash ledger amount and USD valuation", () => {
    const result = prepareKrakenImport(
      [
        ledger(
          ledgerRow("cash-in", "deposit", "deposit", "USD", "500", "0", "500"),
          ledgerRow("coin", "buy", "trade", "BTC", "1", "0.001", "0.999", "0.1"),
          ledgerRow("cash", "buy", "trade", "USD", "-100", "1", "399"),
        ),
        trades(["buy", "XXBTZUSD", "coin,cash", "0", "1", "100", "99.95", "buy"]),
      ],
      "kraken",
      "",
      "USD",
    );

    expect(result.drafts.find((draft) => draft.activityType === "BUY")).toMatchObject({
      symbol: "BTC-USD",
      quoteCcy: "USD",
      currency: "USD",
      quantity: "1",
      unitPrice: "99.95",
      amount: "101",
      fee: "1",
    });
    expect(result.drafts.find((draft) => draft.subtype === "FEE_IN_KIND")).toMatchObject({
      symbol: "BTC-USD",
      quantity: "0.001",
      amount: "0.1",
      currency: "USD",
    });
    expect(result.balances).toContainEqual({ asset: "USD", opening: "0", closing: "399" });
  });

  it("uses one profile quote identity across EUR and USD buys while preserving each cash currency", () => {
    const result = prepareKrakenImport(
      [
        ledger(
          ledgerRow("eur-in", "eur-deposit", "deposit", "EUR", "50", "0", "50"),
          ledgerRow("usd-in", "usd-deposit", "deposit", "USD", "50", "0", "50"),
          ledgerRow("btc-eur", "buy-eur", "trade", "BTC", "1", "0", "1"),
          ledgerRow("eur-cash", "buy-eur", "trade", "EUR", "-10", "0", "40"),
          ledgerRow("btc-usd", "buy-usd", "trade", "BTC", "1", "0", "2"),
          ledgerRow("usd-cash", "buy-usd", "trade", "USD", "-20", "0", "30"),
        ),
        trades(
          ["buy-eur", "BTC/EUR", "btc-eur,eur-cash", "0", "1", "10", "10", "buy"],
          ["buy-usd", "BTC/USD", "btc-usd,usd-cash", "0", "1", "20", "20", "buy"],
        ),
      ],
      "kraken",
      "",
      "USD",
    );

    expect(result.drafts.filter((draft) => draft.activityType === "BUY")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: "BTC-USD", currency: "EUR", amount: "10" }),
        expect.objectContaining({ symbol: "BTC-USD", currency: "USD", amount: "20" }),
      ]),
    );
  });

  it("imports sells from the ledger signs and subtracts cash fees from proceeds", () => {
    const result = prepareKrakenImport(
      [
        ledger(
          ledgerRow("coin", "sell", "trade", "ETH", "-2", "0", "8"),
          ledgerRow("cash", "sell", "trade", "USD", "200", "2", "198"),
        ),
        trades(["sell", "ETHUSD", "coin,cash", "0", "2", "200", "100", "sell"]),
      ],
      "kraken",
      "",
      "USD",
    );

    expect(result.drafts.find((draft) => draft.activityType === "SELL")).toMatchObject({
      symbol: "ETH-USD",
      currency: "USD",
      quantity: "2",
      amount: "198",
      fee: "2",
      unitPrice: "100",
    });
    expect(result.balances).toContainEqual({ asset: "USD", opening: "0", closing: "198" });
  });

  it("preserves a negative sell settlement when cash fees exceed gross proceeds", () => {
    const result = prepareKrakenImport(
      [
        ledger(
          ledgerRow("coin", "sell", "trade", "ETH", "-1", "0", "0"),
          ledgerRow("cash", "sell", "trade", "USD", "10", "12", "-2"),
        ),
        trades(["sell", "ETH/USD", "coin,cash", "0", "1", "10", "10", "sell"]),
      ],
      "kraken",
      "",
      "USD",
    );
    expect(result.drafts.find((draft) => draft.activityType === "SELL")).toMatchObject({
      amount: "-2",
      fee: "12",
      currency: "USD",
    });
    expect(result.balances).toContainEqual({ asset: "USD", opening: "0", closing: "-2" });
  });

  it("uses Wealthfolio's fiat precision for cross-checks without rounding source values", () => {
    const files = [
      ledger(
        ledgerRow("coin", "buy", "trade", "BTC", "1", "0", "1"),
        ledgerRow("cash", "buy", "trade", "JPY", "-100", "0", "-100"),
      ),
      trades(["buy", "BTC/JPY", "coin,cash", "0", "1", "100.4", "100.4", "buy"]),
    ];
    const result = prepareKrakenImport(files, "kraken", "", "JPY");
    expect(result.drafts.find((draft) => draft.activityType === "BUY")).toMatchObject({
      amount: "100",
      unitPrice: "100.4",
      currency: "JPY",
      symbol: "BTC-JPY",
    });
    files[1].rows[0][5] = "100.6";
    expect(() => prepareKrakenImport(files, "kraken", "", "JPY")).toThrow("trade-ledger-mismatch");
  });

  it("preserves explicit fiat conversions as internal transfer legs and separate fee rows", () => {
    const result = prepareKrakenImport(
      [
        ledger(
          ledgerRow("eur", "fx", "spend", "EUR", "-100", "1", "-101"),
          ledgerRow("usd", "fx", "receive", "USD", "108", "0", "108"),
        ),
      ],
      "kraken",
      "",
      "USD",
    );
    const legs = result.drafts.filter((draft) => draft.activityType.startsWith("TRANSFER_"));

    expect(legs).toHaveLength(2);
    expect(legs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activityType: "TRANSFER_OUT",
          amount: "100",
          currency: "EUR",
          subtype: "FX_CONVERSION",
          isExternal: false,
        }),
        expect.objectContaining({
          activityType: "TRANSFER_IN",
          amount: "108",
          currency: "USD",
          subtype: "FX_CONVERSION",
          isExternal: false,
        }),
      ]),
    );
    expect(legs[0].sourceOperationGroup).toBe(legs[1].sourceOperationGroup);
    expect(result.drafts.find((draft) => draft.activityType === "FEE")).toMatchObject({
      currency: "EUR",
      amount: "1",
    });
    expect(result.balances).toEqual(
      expect.arrayContaining([
        { asset: "EUR", opening: "0", closing: "-101" },
        { asset: "USD", opening: "0", closing: "108" },
      ]),
    );
  });

  it("normalizes known fiat .HOLD balances and fees without forcing EUR", () => {
    const deposit = ledgerRow("hold", "deposit", "deposit", "USD.HOLD", "100", "0.5", "99.5");
    deposit[10] = "USD.HOLD";
    deposit[12] = "hold";
    const result = prepareKrakenImport([ledger(deposit)], "kraken", "", "USD");

    expect(result.balances).toEqual([{ asset: "USD", opening: "0", closing: "99.5" }]);
    expect(result.drafts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ activityType: "DEPOSIT", currency: "USD", amount: "100" }),
        expect.objectContaining({ activityType: "FEE", currency: "USD", amount: "0.5" }),
      ]),
    );
  });

  it.each(["buy", "sell"])("validates exported FX trades in the %s direction", (side) => {
    const files = [
      ledger(
        ledgerRow("eur", "fx", "trade", "EUR", "-100", "0", "-100"),
        ledgerRow("usd", "fx", "trade", "USD", "108", "0", "108"),
      ),
      trades(
        side === "buy"
          ? ["fx", "USD/EUR", "usd,eur", "0", "108", "100", "0.9259259", "buy"]
          : ["fx", "EUR/USD", "eur,usd", "0", "100", "108", "1.08", "sell"],
      ),
    ];
    const result = prepareKrakenImport(files, "kraken", "", "EUR");
    expect(result.drafts.filter((draft) => draft.subtype === "FX_CONVERSION")).toHaveLength(2);
    expect(result.drafts.every((draft) => draft.fxRate === undefined)).toBe(true);
    files[1].rows[0][1] = "GBP/EUR";
    expect(() => prepareKrakenImport(files, "kraken", "", "EUR")).toThrow("trade-ledger-mismatch");
  });

  it("does not demand a trades CSV row for an instant purchase", () => {
    const result = prepareKrakenImport(
      [
        ledger(
          ledgerRow("coin", "instant", "receive", "ETH", "1", "0", "1"),
          ledgerRow("cash", "instant", "spend", "USD", "-100", "0", "-100"),
        ),
        trades(),
      ],
      "kraken",
      "",
      "USD",
    );
    expect(result.drafts.find((draft) => draft.activityType === "BUY")).toMatchObject({
      currency: "USD",
      quantity: "1",
      unitPrice: "100",
    });
  });

  it("rejects spend/receive rows whose signs contradict the operation labels", () => {
    expect(() =>
      prepareKrakenImport(
        [
          ledger(
            ledgerRow("eur", "fx", "spend", "EUR", "100", "0", "100"),
            ledgerRow("usd", "fx", "receive", "USD", "-108", "0", "-108"),
          ),
        ],
        "kraken",
        "",
        "EUR",
      ),
    ).toThrow("unsupported-operation");
  });

  it("keeps fiat withdrawals independent and requires a wallet only for crypto withdrawals", () => {
    const fiatResult = prepareKrakenImport(
      [ledger(ledgerRow("withdraw", "withdraw", "withdrawal", "USD", "-25", "0", "-25"))],
      "kraken",
      "",
      "USD",
    );
    expect(fiatResult.drafts[0]).toMatchObject({
      activityType: "WITHDRAWAL",
      amount: "25",
      currency: "USD",
    });
    expect(() =>
      prepareKrakenImport(
        [ledger(ledgerRow("coin", "withdraw", "withdrawal", "BTC", "-1", "0", "-1"))],
        "kraken",
        "",
        "USD",
      ),
    ).toThrow("wallet-required");
  });

  it("rejects crypto-to-crypto swaps instead of labeling them as fiat conversions", () => {
    expect(() =>
      prepareKrakenImport(
        [
          ledger(
            ledgerRow("btc", "swap", "spend", "BTC", "-1", "0", "-1"),
            ledgerRow("eth", "swap", "receive", "ETH", "2", "0", "2"),
          ),
        ],
        "kraken",
        "",
        "USD",
      ),
    ).toThrow("unsupported-crypto-pair");
  });
});
