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
];
const tradeHeaders = ["txid", "pair", "ledgers", "margin", "vol", "cost", "price", "type"];
const ledgerRow = (
  txid: string,
  refid: string,
  time: string,
  type: string,
  asset: string,
  amount: string,
  fee: string,
  balance: string,
): string[] => [
  txid,
  refid,
  time,
  type,
  asset,
  `Spot / ${asset}`,
  amount,
  fee,
  balance,
  "0",
  asset,
];

function fixture(tradeCost = "10.004"): KrakenCsv[] {
  const ledger: KrakenCsv = {
    headers: [...ledgerHeaders],
    rows: [
      ledgerRow(
        "eur-deposit",
        "deposit",
        "2026-01-01T00:00:00Z",
        "deposit",
        "EUR",
        "100",
        "0",
        "100",
      ),
      ledgerRow("btc-trade", "buy-1", "2026-01-02T00:00:00Z", "trade", "BTC", "1", "0", "1"),
      ledgerRow("eur-trade", "buy-1", "2026-01-02T00:00:00Z", "trade", "EUR", "-10", "0", "90"),
      // Same timestamp; the chain is 90 -> 93 -> 98, regardless of row order.
      ledgerRow(
        "eur-deposit-2",
        "deposit-2",
        "2026-01-03T00:00:00Z",
        "deposit",
        "EUR",
        "3",
        "0",
        "93",
      ),
      ledgerRow(
        "eur-deposit-3",
        "deposit-3",
        "2026-01-03T00:00:00Z",
        "deposit",
        "EUR",
        "5",
        "0",
        "98",
      ),
    ],
  };
  const trades: KrakenCsv = {
    headers: [...tradeHeaders],
    rows: [["buy-1", "BTC/EUR", "btc-trade,eur-trade", "0", "1", tradeCost, "10", "buy"]],
  };
  return [ledger, trades];
}

function cryptoFixture(code: string, pair = `${code}/EUR`): KrakenCsv[] {
  const files = fixture();
  for (const row of files[0].rows) {
    if (row[4] !== "BTC") continue;
    row[4] = code;
    row[5] = `Spot / ${code}`;
    row[10] = code;
  }
  files[1].rows[0][1] = pair;
  return files;
}

describe("Kraken import", () => {
  it.each([
    ["ETH", "ETH/EUR", "ETH"],
    ["SOL", "SOL/EUR", "SOL"],
    ["ADA", "ADAEUR", "ADA"],
    ["1INCH", "1INCH/EUR", "1INCH"],
    ["XETH", "XETHZEUR", "ETH"],
    ["XXDG", "XDGEUR", "DOGE"],
    ["XRP", "XXRPZEUR", "XRP"],
    ["ZRX", "ZRX/EUR", "ZRX"],
  ])("uses the CSV asset %s and pair %s rather than assuming BTC", (code, pair, canonical) => {
    const result = prepareKrakenImport(cryptoFixture(code, pair), "exchange", "wallet");
    expect(result.drafts.find((draft) => draft.activityType === "BUY")).toMatchObject({
      symbol: `${canonical}-EUR`,
      instrumentType: "CRYPTO",
      quoteCcy: "EUR",
      quantity: "1",
      amount: "10",
    });
    expect(result.balances).toContainEqual({ asset: canonical, opening: "0", closing: "1" });
  });

  it.each(["SOL/EUR", "ETH//EUR"])("rejects an inconsistent or malformed trade pair %s", (pair) => {
    expect(() => prepareKrakenImport(cryptoFixture("ETH", pair), "exchange", "wallet")).toThrow(
      "trade-ledger-mismatch",
    );
  });

  it("identifies ETH from the ledger without a trades export", () => {
    const [ledger] = cryptoFixture("ETH");
    const result = prepareKrakenImport([ledger], "exchange", "wallet");
    expect(result.drafts.find((draft) => draft.activityType === "BUY")).toMatchObject({
      symbol: "ETH-EUR",
      quantity: "1",
      unitPrice: "10",
      amount: "10",
    });
  });

  it("uses explicit crypto classification before fiat ticker heuristics", () => {
    const files = cryptoFixture("BOB");
    files[0].headers.push("aclass", "subclass");
    for (const row of files[0].rows) row.push("currency", row[4] === "BOB" ? "crypto" : "fiat");
    const result = prepareKrakenImport(files, "exchange", "wallet");
    expect(result.drafts.find((draft) => draft.activityType === "BUY")).toMatchObject({
      symbol: "BOB-EUR",
      instrumentType: "CRYPTO",
    });
  });

  it("normalizes EUR.HOLD fees through the same path as the ledger asset", () => {
    const ledger: KrakenCsv = {
      headers: [...ledgerHeaders, "aclass", "subclass"],
      rows: [
        [
          ...ledgerRow(
            "deposit",
            "deposit",
            "2026-01-01T00:00:00Z",
            "deposit",
            "EUR.HOLD",
            "100",
            "1",
            "99",
          ),
          "currency",
          "hold",
        ],
        [
          ...ledgerRow("eth", "buy", "2026-01-02T00:00:00Z", "receive", "ETH", "1", "0", "1"),
          "currency",
          "crypto",
        ],
        [
          ...ledgerRow(
            "cash",
            "buy",
            "2026-01-02T00:00:00Z",
            "spend",
            "EUR.HOLD",
            "-10",
            "0",
            "89",
          ),
          "currency",
          "hold",
        ],
      ],
    };
    const result = prepareKrakenImport([ledger], "exchange", "wallet");
    expect(result.balances).toContainEqual({ asset: "EUR", opening: "0", closing: "89" });
    expect(result.drafts.find((draft) => draft.activityType === "FEE")).toMatchObject({
      currency: "EUR",
      amount: "1",
    });
    expect(result.drafts.find((draft) => draft.activityType === "BUY")).toMatchObject({
      symbol: "ETH-EUR",
      quantity: "1",
      amount: "10",
    });
  });

  it.each(["USD", "ZUSD", "GBP"])(
    "maps fiat trade %s as cash FX rather than a crypto asset",
    (code) => {
      const result = prepareKrakenImport(cryptoFixture(code), "exchange", "wallet");
      expect(result.drafts.some((draft) => draft.instrumentType === "CRYPTO")).toBe(false);
      expect(result.drafts.filter((draft) => draft.subtype === "FX_CONVERSION")).toHaveLength(2);
    },
  );

  it("rejects a crypto variant that the source mapping does not identify", () => {
    expect(() => prepareKrakenImport(cryptoFixture("ETH.S"), "exchange", "wallet")).toThrow(
      "unsupported-asset-variant",
    );
  });

  it("rejects tokenized equities even when their code looks like a crypto ticker", () => {
    const files = cryptoFixture("AAPLX");
    files[0].headers.push("aclass", "subclass");
    for (const row of files[0].rows)
      row.push(
        row[4] === "AAPLX" ? "tokenized_asset" : "currency",
        row[4] === "AAPLX" ? "tokenized_asset" : "fiat",
      );
    expect(() => prepareKrakenImport(files, "exchange", "wallet")).toThrow(
      "unsupported-asset-class",
    );
  });

  it("accepts trade costs that differ from ledger only below the EUR cent precision", () => {
    const result = prepareKrakenImport(fixture("10.004"), "exchange", "wallet");
    expect(result.purchases).toBe(1);
    expect(result.drafts.find((draft) => draft.activityType === "BUY")?.amount).toBe("10");
  });

  it("rejects a trade cost that materially disagrees with the cash ledger", () => {
    expect(() => prepareKrakenImport(fixture("10.02"), "exchange", "wallet")).toThrow(
      "trade-ledger-mismatch",
    );
  });

  it("validates equal-time ledger rows by their balance chain, independent of CSV order", () => {
    const files = fixture();
    const reversedLedger = { ...files[0], rows: [...files[0].rows].reverse() };
    const result = prepareKrakenImport([reversedLedger, files[1]], "exchange", "wallet");
    expect(result.balances).toContainEqual({ asset: "EUR", opening: "0", closing: "98" });
  });

  it.each(["BTC", "ETH", "SOL"])(
    "keeps wallet receipts separate from the %s network fee",
    (code) => {
      const files = cryptoFixture(code);
      const withdrawal = ledgerRow(
        "btc-withdrawal",
        "withdrawal",
        "2026-01-04T00:00:00Z",
        "withdrawal",
        code,
        "-0.4",
        "0.001",
        "0.599",
      );
      withdrawal[9] = "0.02";
      files[0].rows.push(withdrawal);
      const result = prepareKrakenImport(files, "exchange", "wallet");
      const transfers = result.drafts.filter((draft) => draft.activityType.startsWith("TRANSFER_"));
      expect(transfers).toHaveLength(2);
      expect(transfers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            accountId: "exchange",
            activityType: "TRANSFER_OUT",
            quantity: "0.4",
            isExternal: false,
          }),
          expect.objectContaining({
            accountId: "wallet",
            activityType: "TRANSFER_IN",
            quantity: "0.4",
            isExternal: false,
          }),
        ]),
      );
      const fee = result.drafts.find((draft) => draft.subtype === "FEE_IN_KIND");
      expect(fee).toMatchObject({
        accountId: "exchange",
        activityType: "FEE",
        symbol: `${code}-EUR`,
        currency: "USD",
        quantity: "0.001",
        amount: "0.02",
        activityDate: transfers[0].activityDate,
        sourceOperationGroup: transfers[0].sourceOperationGroup,
      });
      expect(transfers[1].sourceOperationGroup).toBe(transfers[0].sourceOperationGroup);
      expect(result.balances).toContainEqual({ asset: code, opening: "0", closing: "0.599" });
      expect(result.balances).toContainEqual({ asset: "EUR", opening: "0", closing: "98" });
    },
  );

  it("reconciles a mixed BTC and ETH ledger without combining their units or fees", () => {
    const ledger: KrakenCsv = {
      headers: ledgerHeaders,
      rows: [
        ledgerRow(
          "deposit",
          "deposit",
          "2026-01-01T00:00:00Z",
          "deposit",
          "EUR",
          "100",
          "0",
          "100",
        ),
        ledgerRow("btc", "buy-btc", "2026-01-02T00:00:00Z", "trade", "BTC", "1", "0", "1"),
        ledgerRow("cash-btc", "buy-btc", "2026-01-02T00:00:00Z", "trade", "EUR", "-10", "0", "90"),
        ledgerRow("eth", "buy-eth", "2026-01-03T00:00:00Z", "trade", "ETH", "2", "0", "2"),
        ledgerRow("cash-eth", "buy-eth", "2026-01-03T00:00:00Z", "trade", "EUR", "-20", "0", "70"),
        ledgerRow(
          "withdraw-btc",
          "withdraw-btc",
          "2026-01-04T00:00:00Z",
          "withdrawal",
          "BTC",
          "-0.4",
          "0.001",
          "0.599",
        ),
        ledgerRow(
          "withdraw-eth",
          "withdraw-eth",
          "2026-01-04T00:00:00Z",
          "withdrawal",
          "ETH",
          "-0.5",
          "0.002",
          "1.498",
        ),
      ],
    };
    ledger.rows[5][9] = "1";
    ledger.rows[6][9] = "2";
    const trades: KrakenCsv = {
      headers: tradeHeaders,
      rows: [
        ["buy-btc", "BTC/EUR", "btc,cash-btc", "0", "1", "10", "10", "buy"],
        ["buy-eth", "ETH/EUR", "eth,cash-eth", "0", "2", "20", "10", "buy"],
      ],
    };
    for (const rows of [ledger.rows, [...ledger.rows].reverse()]) {
      const result = prepareKrakenImport([{ ...ledger, rows }, trades], "exchange", "wallet");
      expect(result.balances).toEqual(
        expect.arrayContaining([
          { asset: "BTC", opening: "0", closing: "0.599" },
          { asset: "ETH", opening: "0", closing: "1.498" },
          { asset: "EUR", opening: "0", closing: "70" },
        ]),
      );
      expect(result.drafts.filter((draft) => draft.activityType === "TRANSFER_IN")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ symbol: "BTC-EUR", quantity: "0.4", accountId: "wallet" }),
          expect.objectContaining({ symbol: "ETH-EUR", quantity: "0.5", accountId: "wallet" }),
        ]),
      );
      expect(result.drafts.filter((draft) => draft.subtype === "FEE_IN_KIND")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ symbol: "BTC-EUR", quantity: "0.001" }),
          expect.objectContaining({ symbol: "ETH-EUR", quantity: "0.002" }),
        ]),
      );
    }
  });

  it("still rejects a broken balance chain when equal-time rows are reversed", () => {
    const files = fixture();
    files[0].rows[4][8] = "99";
    files[0].rows.reverse();
    expect(() => prepareKrakenImport(files, "exchange", "wallet")).toThrow(
      "ledger-balance-mismatch",
    );
  });
});
