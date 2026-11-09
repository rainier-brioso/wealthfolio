import { worldCurrencies } from "@wealthfolio/ui/lib/currencies";
import { currencyFractionDigits } from "@/lib/currency-decimals";
import type { DraftActivity } from "../../context/import-context";

export interface KrakenCsv {
  headers: string[];
  rows: string[][];
}
interface LedgerRow extends Record<string, string> {
  txid: string;
  refid: string;
  time: string;
  type: string;
  asset: string;
  wallet: string;
  amount: string;
  fee: string;
  balance: string;
  feeusd: string;
  feecurrency: string;
}
interface AssetInfo {
  code: string;
  kind: "crypto" | "fiat";
}
// Legacy Kraken codes: https://support.kraken.com/articles/360001206766-bitcoin-currency-code-xbt-vs-btc
const ALIASES: Record<string, string> = {
  XETC: "ETC",
  XETH: "ETH",
  XLTC: "LTC",
  XMLN: "MLN",
  XREP: "REP",
  XXBT: "BTC",
  XBT: "BTC",
  XXDG: "DOGE",
  XDG: "DOGE",
  XXLM: "XLM",
  XXMR: "XMR",
  XXRP: "XRP",
  XZEC: "ZEC",
  ZAUD: "AUD",
  ZCAD: "CAD",
  ZEUR: "EUR",
  ZGBP: "GBP",
  ZJPY: "JPY",
  ZUSD: "USD",
};
const FIAT_CODES = new Set(worldCurrencies.map(({ value }) => value.toUpperCase()));
const normalizeCode = (value: string) => {
  const code = value.trim().toUpperCase();
  if (ALIASES[code]) return ALIASES[code];
  const legacyFiatCode = code.slice(1);
  return /^[XZ]/.test(code) && FIAT_CODES.has(legacyFiatCode) ? legacyFiatCode : code;
};
const SCALE = 10n ** 18n;
const abs = (value: bigint) => (value < 0n ? -value : value);
function number(value: string): bigint {
  if (!/^-?\d+(?:\.\d{1,18})?$/.test(value)) throw new Error("invalid-number");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const result = BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, "0"));
  return negative ? -result : result;
}
function decimal(value: bigint): string {
  const digits = abs(value).toString().padStart(19, "0");
  return `${value < 0n ? "-" : ""}${digits.slice(0, -18)}.${digits.slice(-18)}`
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}
function roundToMinorUnits(value: bigint, fractionDigits = 2): bigint {
  const factor = 10n ** BigInt(18 - fractionDigits);
  const magnitude = abs(value);
  const rounded = ((magnitude + factor / 2n) / factor) * factor;
  return value < 0n ? -rounded : rounded;
}
function asset(value: string, aclass = "", subclass = ""): AssetInfo {
  const raw = value.trim().toUpperCase();
  const hold = raw.endsWith(".HOLD");
  const code = normalizeCode(hold ? raw.slice(0, -5) : raw);
  const normalizedClass = aclass.trim().toLowerCase();
  const normalizedSubclass = subclass.trim().toLowerCase();
  if (raw.includes(".") && (!hold || !FIAT_CODES.has(code)))
    throw new Error("unsupported-asset-variant");
  if (normalizedClass && normalizedClass !== "currency") throw new Error("unsupported-asset-class");
  if (hold && normalizedSubclass && normalizedSubclass !== "hold")
    throw new Error("unsupported-asset-subclass");
  if (!hold && normalizedSubclass && !["crypto", "fiat"].includes(normalizedSubclass))
    throw new Error("unsupported-asset-subclass");
  if (normalizedSubclass === "hold" && !hold) throw new Error("unsupported-asset-subclass");
  if (hold) {
    if (!FIAT_CODES.has(code)) throw new Error("unsupported-asset-subclass");
    return { code, kind: "fiat" };
  }
  if (normalizedSubclass === "crypto") {
    if (!/^[A-Z0-9]{1,20}$/.test(code)) throw new Error("unsupported-asset");
    return { code, kind: "crypto" };
  }
  if (normalizedSubclass === "fiat" || FIAT_CODES.has(code)) {
    if (!FIAT_CODES.has(code)) throw new Error("unsupported-asset");
    return { code, kind: "fiat" };
  }
  if (!/^[A-Z0-9]{1,20}$/.test(code)) throw new Error("unsupported-asset");
  return { code, kind: "crypto" };
}
function rowAsset(row: LedgerRow): AssetInfo {
  return asset(row.asset, row.aclass, row.subclass);
}
function cryptoAsset(code: string, quoteCurrency: string) {
  return {
    symbol: `${code}-${quoteCurrency}`,
    symbolName: code === "BTC" ? "Bitcoin" : code,
    instrumentType: "CRYPTO",
    quoteCcy: quoteCurrency,
  };
}
function matchesFiatPair(
  pair: string,
  cryptoCode: string,
  rawCryptoCode: string,
  cashCurrency: string,
): boolean {
  const normalized = pair.trim().toUpperCase();
  const [base, quote, ...rest] = normalized.split(/[/-]/);
  if (/[/-]/.test(normalized)) {
    return (
      !!base &&
      !!quote &&
      rest.length === 0 &&
      normalizeCode(base) === cryptoCode &&
      normalizeCode(quote) === cashCurrency
    );
  }
  const compact = normalized;
  const cryptoAliases = Object.entries(ALIASES)
    .filter(([, canonical]) => canonical === cryptoCode)
    .map(([alias]) => alias);
  const fiatAliases = Object.entries(ALIASES)
    .filter(([, canonical]) => canonical === cashCurrency)
    .map(([alias]) => alias);
  return [...new Set([cryptoCode, rawCryptoCode.toUpperCase(), ...cryptoAliases])].some(
    (baseCode) =>
      [...new Set([cashCurrency, ...fiatAliases])].some(
        (quoteCode) => compact === `${baseCode}${quoteCode}`,
      ),
  );
}
function date(value: string): string {
  const result = value.includes("T") ? value : value.replace(" ", "T");
  const utc = /(?:Z|[+-]\d{2}:\d{2})$/.test(result) ? result : `${result}Z`;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(utc))
    throw new Error("invalid-date");
  const parsed = new Date(utc);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== utc.slice(0, 10))
    throw new Error("invalid-date");
  return parsed.toISOString();
}
function records(file: KrakenCsv): Record<string, string>[] {
  const headers = file.headers.map((header) =>
    header
      .replace(/^\uFEFF/, "")
      .trim()
      .toLowerCase(),
  );
  if (new Set(headers).size !== headers.length) throw new Error("invalid-columns");
  return file.rows.map((row) => {
    if (row.length !== headers.length) throw new Error("invalid-columns");
    return Object.fromEntries(headers.map((header, index) => [header, row[index].trim()]));
  });
}

export interface KrakenBalanceCheck {
  asset: string;
  opening: string;
  closing: string;
}
export function prepareKrakenImport(
  files: KrakenCsv[],
  accountId: string,
  walletAccountId: string,
  accountQuoteCurrency = "EUR",
): { drafts: DraftActivity[]; balances: KrakenBalanceCheck[]; purchases: number } {
  if (!accountId) throw new Error("account-required");
  const quoteCurrency = asset(accountQuoteCurrency).code;
  const columns = (file: KrakenCsv) =>
    file.headers.map((header) =>
      header
        .replace(/^\uFEFF/, "")
        .trim()
        .toLowerCase(),
    );
  const ledgerFiles = files.filter(
    (file) => columns(file).includes("refid") && columns(file).includes("balance"),
  );
  const tradeFiles = files.filter(
    (file) => columns(file).includes("pair") && columns(file).includes("ledgers"),
  );
  if (
    ledgerFiles.length !== 1 ||
    tradeFiles.length > 1 ||
    ledgerFiles.length + tradeFiles.length !== files.length
  )
    throw new Error("ledger-required");
  const required = [
    "txid",
    "refid",
    "time",
    "type",
    "asset",
    "amount",
    "fee",
    "balance",
    "feeusd",
    "feecurrency",
    "wallet",
  ];
  if (required.some((key) => !columns(ledgerFiles[0]).includes(key)))
    throw new Error("invalid-columns");
  const rows = records(ledgerFiles[0]) as unknown as LedgerRow[];
  if (!rows.length) throw new Error("empty-ledger");
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row.txid || !row.refid || ids.has(row.txid)) throw new Error("invalid-reference");
    ids.add(row.txid);
    date(row.time);
    const rowInfo = rowAsset(row);
    if (!row.wallet.toLowerCase().startsWith("spot /")) throw new Error("unsupported-wallet");
    if (number(row.fee) < 0n || number(row.feeusd) < 0n) throw new Error("invalid-number");
    if (number(row.fee) !== 0n && asset(row.feecurrency).code !== rowInfo.code)
      throw new Error("unsupported-fee-currency");
  }
  // Check each Kraken balance bucket independently before normalising .HOLD variants.
  const balances = new Map<string, { opening: bigint; closing: bigint }>();
  const byAssetAndTime = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const key = `${row.asset}|${date(row.time)}`;
    byAssetAndTime.set(key, [...(byAssetAndTime.get(key) ?? []), row]);
  }
  const orderedRows = [...byAssetAndTime]
    .map(([key, entries]) => ({ key, entries, time: key.slice(key.indexOf("|") + 1) }))
    .sort((a, b) => a.time.localeCompare(b.time) || a.key.localeCompare(b.key));
  for (const { entries } of orderedRows) {
    const assetCode = entries[0].asset;
    const previous = balances.get(assetCode);
    const pending = entries.map((row) => ({
      row,
      opening: number(row.balance) - number(row.amount) + number(row.fee),
      closing: number(row.balance),
    }));
    let opening = previous?.opening;
    let current = previous?.closing;
    if (current === undefined) {
      const closings = new Set(pending.map((entry) => entry.closing.toString()));
      const starts = pending.filter((entry) => !closings.has(entry.opening.toString()));
      if (starts.length > 1) throw new Error("ledger-balance-mismatch");
      const first =
        starts[0] ?? [...pending].sort((a, b) => a.row.txid.localeCompare(b.row.txid))[0];
      opening = first.opening;
      current = opening;
    }
    while (pending.length) {
      const matches = pending.filter((entry) => entry.opening === current);
      if (!matches.length) throw new Error("ledger-balance-mismatch");
      const next = matches[0];
      if (matches.some((entry) => entry.closing !== next.closing))
        throw new Error("ledger-balance-mismatch");
      current = next.closing;
      pending.splice(pending.indexOf(next), 1);
    }
    balances.set(assetCode, { opening: opening!, closing: current });
  }
  const trades = tradeFiles.flatMap(records);
  const ledgerById = new Map(rows.map((row) => [row.txid, row]));
  const tradeByReference = new Map<string, Record<string, string>>();
  for (const trade of trades) {
    if (!trade.txid || tradeByReference.has(trade.txid)) throw new Error("invalid-reference");
    if (number(trade.margin || "0") !== 0n) throw new Error("unsupported-margin");
    const linked = trade.ledgers?.split(",").map((id) => ledgerById.get(id.trim()));
    if (
      linked?.length !== 2 ||
      linked.some((row) => !row || row.refid !== trade.txid || row.type !== "trade")
    )
      throw new Error("trade-ledger-mismatch");
    tradeByReference.set(trade.txid, trade);
  }
  const groups = new Map<string, LedgerRow[]>();
  for (const row of rows) groups.set(row.refid, [...(groups.get(row.refid) ?? []), row]);
  if (tradeFiles.length > 0) {
    const tradeReferences = new Set(
      rows.filter((row) => row.type === "trade").map((row) => row.refid),
    );
    if (trades.length !== tradeReferences.size) throw new Error("trade-ledger-mismatch");
    for (const reference of tradeReferences)
      if (!tradeByReference.has(reference)) throw new Error("trade-ledger-mismatch");
  }
  const drafts: DraftActivity[] = [];
  const preparedChanges = new Map<string, bigint>();
  let purchases = 0;
  const addChange = (currency: string, amount: bigint) =>
    preparedChanges.set(currency, (preparedChanges.get(currency) ?? 0n) + amount);
  const base = (row: LedgerRow): DraftActivity => ({
    rowIndex: 0,
    rawRow: Object.values(row),
    accountId,
    activityDate: date(row.time),
    activityType: "",
    currency: rowAsset(row).code,
    currencySource: "csv",
    status: "valid",
    errors: {},
    warnings: {},
    isEdited: false,
    sourceOperationGroup: `kraken:${row.refid}`,
    comment: `[Kraken: ${row.txid}; refid: ${row.refid}; asset: ${row.asset}]`,
  });
  const fee = (row: LedgerRow) => {
    const quantity = number(row.fee);
    if (quantity === 0n) return;
    const info = rowAsset(row);
    if (info.kind === "crypto") {
      const value = number(row.feeusd);
      if (value <= 0n) throw new Error("missing-fee-valuation");
      drafts.push({
        ...base(row),
        ...cryptoAsset(info.code, quoteCurrency),
        activityType: "FEE",
        subtype: "FEE_IN_KIND",
        currency: "USD",
        quantity: decimal(quantity),
        amount: decimal(value),
        // Retain the historical source valuation ratio so importing the same
        // fee again keeps the existing activity idempotency key. This is not a
        // market quote or an FX rate; feeusd is Kraken's reported value.
        unitPrice: decimal((value * SCALE) / quantity),
        comment: `${info.code} network fee ${row.fee} ${info.code}; reported valuation ${row.feeusd} USD ${base(row).comment}`,
      });
    } else drafts.push({ ...base(row), activityType: "FEE", amount: decimal(quantity) });
    addChange(info.code, -quantity);
  };
  for (const group of groups.values()) {
    const infos = group.map((row) => rowAsset(row));
    const cryptoRows = group.filter((_, index) => infos[index].kind === "crypto");
    const fiatRows = group.filter((_, index) => infos[index].kind === "fiat");
    if (cryptoRows.length > 1 && fiatRows.length === 0) throw new Error("unsupported-crypto-pair");

    // Kraken represents an explicit fiat conversion as two cash ledger rows under
    // one refid. Preserve both source currencies and let Wealthfolio link the legs.
    if (
      group.length === 2 &&
      fiatRows.length === 2 &&
      infos[0].code !== infos[1].code &&
      ((group[0].type === "spend" && number(group[0].amount) < 0n && group[1].type === "receive") ||
        (group[0].type === "receive" &&
          number(group[0].amount) > 0n &&
          group[1].type === "spend") ||
        (group[0].type === "trade" && group[1].type === "trade")) &&
      number(group[0].amount) * number(group[1].amount) < 0n
    ) {
      const trade = tradeByReference.get(group[0].refid);
      if (trade) {
        const outgoing = group.find((row) => number(row.amount) < 0n)!;
        const incoming = group.find((row) => number(row.amount) > 0n)!;
        const baseRow = trade.type === "buy" ? incoming : outgoing;
        const quoteRow = trade.type === "buy" ? outgoing : incoming;
        const quoteCode = rowAsset(quoteRow).code;
        if (
          !["buy", "sell"].includes(trade.type) ||
          !matchesFiatPair(trade.pair, rowAsset(baseRow).code, baseRow.asset, quoteCode) ||
          number(trade.vol) !== abs(number(baseRow.amount)) ||
          roundToMinorUnits(number(trade.cost), currencyFractionDigits(quoteCode)) !==
            roundToMinorUnits(abs(number(quoteRow.amount)), currencyFractionDigits(quoteCode))
        )
          throw new Error("trade-ledger-mismatch");
      }
      for (const row of group) {
        const outgoing = number(row.amount) < 0n;
        drafts.push({
          ...base(row),
          activityType: outgoing ? "TRANSFER_OUT" : "TRANSFER_IN",
          subtype: "FX_CONVERSION",
          amount: decimal(abs(number(row.amount))),
          isExternal: false,
        });
        addChange(rowAsset(row).code, number(row.amount));
        fee(row);
      }
      continue;
    }

    if (group.length === 2 && cryptoRows.length === 1 && fiatRows.length === 1) {
      const crypto = cryptoRows[0];
      const cash = fiatRows[0];
      const cryptoInfo = rowAsset(crypto);
      const cashCurrency = rowAsset(cash).code;
      const cryptoDelta = number(crypto.amount);
      const cashDelta = number(cash.amount);
      const buying = cryptoDelta > 0n && cashDelta < 0n;
      const selling = cryptoDelta < 0n && cashDelta > 0n;
      const trade = tradeByReference.get(crypto.refid);
      const tradeKindsMatch =
        (crypto.type === "trade" && cash.type === "trade") ||
        (buying && crypto.type === "receive" && cash.type === "spend") ||
        (selling && crypto.type === "spend" && cash.type === "receive");
      if (!buying && !selling) throw new Error("unsupported-trade");
      if (!tradeKindsMatch) throw new Error("trade-ledger-mismatch");
      if (
        trade &&
        (trade.type !== (buying ? "buy" : "sell") ||
          !matchesFiatPair(trade.pair, cryptoInfo.code, crypto.asset, cashCurrency) ||
          number(trade.vol) !== abs(cryptoDelta) ||
          roundToMinorUnits(number(trade.cost), currencyFractionDigits(cashCurrency)) !==
            roundToMinorUnits(abs(cashDelta), currencyFractionDigits(cashCurrency)))
      )
        throw new Error("trade-ledger-mismatch");
      const cashFee = number(cash.fee);
      const quantity = abs(cryptoDelta);
      const cryptoAmount = decimal(quantity);
      const netCashAmount = buying ? abs(cashDelta) + cashFee : cashDelta - cashFee;
      // Wealthfolio requires a unit price for BUY/SELL. When Kraken omits its
      // trades export, the ledger cash amount is the only source to derive it.
      const unitPrice = trade?.price || decimal((abs(cashDelta) * SCALE) / quantity);
      drafts.push({
        ...base(crypto),
        ...cryptoAsset(cryptoInfo.code, quoteCurrency),
        activityType: buying ? "BUY" : "SELL",
        quantity: cryptoAmount,
        unitPrice,
        amount: decimal(netCashAmount),
        fee: decimal(cashFee),
        currency: cashCurrency,
        comment: `Kraken ${buying ? "purchase" : "sale"}; cash ledger ${cash.txid}; cash amount ${cash.amount}; cash fee ${cash.fee} ${base(crypto).comment}`,
      });
      addChange(cryptoInfo.code, cryptoDelta);
      addChange(cashCurrency, cashDelta - cashFee);
      fee(crypto);
      if (buying) purchases++;
      continue;
    }

    if (group.length === 1 && fiatRows.length === 1) {
      const row = group[0];
      const amount = number(row.amount);
      if (row.type === "deposit" && amount > 0n) {
        drafts.push({ ...base(row), activityType: "DEPOSIT", amount: decimal(amount) });
      } else if (row.type === "withdrawal" && amount < 0n) {
        drafts.push({ ...base(row), activityType: "WITHDRAWAL", amount: decimal(-amount) });
      } else throw new Error("unsupported-operation");
      addChange(rowAsset(row).code, amount);
      fee(row);
      continue;
    }

    if (group.length === 1 && cryptoRows.length === 1 && cryptoRows[0].type === "withdrawal") {
      const crypto = cryptoRows[0];
      if (!walletAccountId || accountId === walletAccountId) throw new Error("wallet-required");
      if (number(crypto.amount) >= 0n) throw new Error("unsupported-operation");
      const cryptoInfo = rowAsset(crypto);
      const quantity = decimal(-number(crypto.amount));
      drafts.push({
        ...base(crypto),
        ...cryptoAsset(cryptoInfo.code, quoteCurrency),
        activityType: "TRANSFER_OUT",
        quantity,
        currency: quoteCurrency,
        isExternal: false,
      });
      drafts.push({
        ...base(crypto),
        ...cryptoAsset(cryptoInfo.code, quoteCurrency),
        accountId: walletAccountId,
        activityType: "TRANSFER_IN",
        quantity,
        currency: quoteCurrency,
        isExternal: false,
      });
      addChange(cryptoInfo.code, number(crypto.amount));
      fee(crypto);
      continue;
    }

    throw new Error("unsupported-operation");
  }
  const expected = new Map<string, bigint>();
  for (const row of rows) {
    const currency = rowAsset(row).code;
    expected.set(currency, (expected.get(currency) ?? 0n) + number(row.amount) - number(row.fee));
  }
  for (const [currency, change] of expected)
    if (preparedChanges.get(currency) !== change) throw new Error("prepared-balance-mismatch");
  const normalizedBalances = new Map<string, { opening: bigint; closing: bigint }>();
  for (const [sourceAsset, value] of balances) {
    const normalizedAsset = asset(sourceAsset).code;
    const current = normalizedBalances.get(normalizedAsset) ?? { opening: 0n, closing: 0n };
    current.opening += value.opening;
    current.closing += value.closing;
    normalizedBalances.set(normalizedAsset, current);
  }
  return {
    drafts: drafts.map((draft, rowIndex) => ({ ...draft, rowIndex })),
    purchases,
    balances: [...normalizedBalances].map(([asset, values]) => ({
      asset,
      opening: decimal(values.opening),
      closing: decimal(values.closing),
    })),
  };
}
