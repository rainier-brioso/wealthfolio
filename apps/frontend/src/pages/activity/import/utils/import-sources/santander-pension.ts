import type { DraftActivity } from "../../context/import-context";
import type { PensionPdfPage } from "./santander-pension-pdf";

export interface PensionStatement {
  symbol: string;
  name: string;
  closingDate: string;
  closingUnits: string;
  closingPrice: string;
  closingValue: string;
  openingUnits: string;
  drafts: DraftActivity[];
}
const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
const SCALE = 10000000000n;
function decimal(value: string): string {
  const clean = value.replace(/\s/g, "");
  if (!/^-?(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2,5}$/.test(clean)) throw new Error("invalid-number");
  return clean.replace(/\./g, "").replace(",", ".");
}
function scaled(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole + fraction.padEnd(10, "0"));
}
function date(value: string): string {
  const match = /^(\d{2})[./](\d{2})[./](\d{4})$/.exec(value.replace(/\s/g, ""));
  if (!match) throw new Error("invalid-date");
  const result = `${match[3]}-${match[2]}-${match[1]}`;
  const parsed = new Date(result);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== result ||
    result < "1970-01-01" ||
    result > "2100-12-31"
  )
    throw new Error("invalid-date");
  return result;
}
function field(summary: string, label: string): string {
  const line = summary.split("\n").find((line) => normalize(line).includes(label));
  const number = line?.match(/-?\d[\d. ]*,\s*\d+/)?.[0];
  if (!number) throw new Error("missing-control");
  return decimal(number);
}
const abs = (value: bigint) => (value < 0n ? -value : value);

export function parseSantanderPension(page: PensionPdfPage, accountId: string): PensionStatement {
  const header = normalize(page.header);
  if (!header.includes("SANTANDER") || !header.includes("EXTRACTO DE MOVIMIENTOS"))
    throw new Error("not-santander");
  const fund =
    /FONDO\s+(\d{3})\s+(.+?)\s+PLAN\s+(\d{3})\s+(.+?)(?:IDENTIFICACION|FECHA DE ALTA)/.exec(header);
  if (!fund) throw new Error("missing-plan");
  const symbol = `SANPP${fund[1]}${fund[3]}`;
  const name = fund[4].replace(/\s*[-=]+\s*/g, " ").trim();
  const closing = /DATOS ECONOMICOS AL\s*(\d{2}[./]\d{2}[./]\d{4})/.exec(normalize(page.summary));
  if (!closing) throw new Error("missing-control");
  const closingDate = date(closing[1]);
  const closingValue = field(page.summary, "DERECHO CONSOLIDADO AL FINAL DEL PERIODO");
  const closingUnits = field(page.summary, "UNIDADES DE CUENTA TOTALES");
  const closingPrice = field(page.summary, "VALOR UNIDAD DE CUENTA AL FINAL DEL PERIODO");
  const openingValue = field(page.summary, "DERECHO CONSOLIDADO AL INICIO DEL PERIODO");
  const entries = field(page.summary, "TOTAL OPERACIONES DE ENTRADA EN EL PERIODO");
  const exits = field(page.summary, "TOTAL OPERACIONES DE SALIDA EN EL PERIODO");
  const change = field(page.summary, "REVALORIZACI");
  if (scaled(exits) !== 0n) throw new Error("unsupported-exit");
  if (
    abs(scaled(openingValue) + scaled(entries) + scaled(change) - scaled(closingValue)) >
    SCALE / 100n
  )
    throw new Error("summary-value-mismatch");
  if (
    abs((scaled(closingUnits) * scaled(closingPrice)) / SCALE - scaled(closingValue)) >
    SCALE / 100n
  )
    throw new Error("closing-valuation-mismatch");
  const opening = page.rows.find((row) => normalize(row.concept).includes("SALDO ANTERIOR"));
  if (!opening) throw new Error("missing-control");
  const openingUnits = decimal(opening.units);
  let units = scaled(openingUnits);
  let total = 0n;
  const drafts: DraftActivity[] = [];
  const seen = new Map<string, number>();
  for (const row of page.rows) {
    const concept = normalize(row.concept).replace(/^[^A-Z]+/, "");
    if (
      !concept &&
      !row.valueDate &&
      scaled(decimal(row.units)) === scaled(closingUnits) &&
      scaled(decimal(row.price)) === scaled(closingPrice)
    )
      continue;
    if (
      concept.includes("SALDO ANTERIOR") ||
      /^99[.,/]99[.,/]9999/.test(row.operationDate.replace(/\s/g, ""))
    )
      continue;
    const operationDate = date(row.operationDate);
    const valueDate = date(row.valueDate);
    if (valueDate > closingDate) throw new Error("invalid-date");
    const amount = decimal(row.amount),
      quantity = decimal(row.units),
      price = decimal(row.price);
    if ([amount, quantity, price].some((value) => scaled(value) <= 0n))
      throw new Error("invalid-number");
    const contribution = /^AP[. ]*\s*(PROMOTOR|PARTICIPE|VOLUNTARIA)/.test(concept);
    const transfer = /^(INGR[. ]*TRASPASO|INGRESO POR TRASPASO)/.test(concept);
    if (!contribution && !transfer) throw new Error("unknown-operation");
    if (abs((scaled(quantity) * scaled(price)) / SCALE - scaled(amount)) > SCALE / 100n)
      throw new Error("trade-mismatch");
    units += scaled(quantity);
    total += scaled(amount);
    const identity = `${symbol}|${operationDate}|${valueDate}|${concept}|${amount}|${quantity}`;
    const occurrence = (seen.get(identity) ?? 0) + 1;
    seen.set(identity, occurrence);
    const group = `santander-pp|${identity}|${occurrence}`;
    const comment = `${concept} [Santander PP: ${identity}|${occurrence}]`;
    const base: DraftActivity = {
      rowIndex: 0,
      rawRow: [row.operationDate, row.valueDate, row.concept, row.amount, row.units, row.price],
      activityDate: valueDate,
      activityType: "BUY",
      amount,
      currency: "EUR",
      currencySource: "csv",
      accountId,
      comment,
      status: "valid",
      errors: {},
      warnings: {},
      isEdited: false,
      sourceOperationGroup: group,
    };
    if (contribution) drafts.push({ ...base, activityType: "DEPOSIT" });
    drafts.push({
      ...base,
      activityType: transfer ? "TRANSFER_IN" : "BUY",
      quantity,
      unitPrice: price,
      symbol,
      sourceQuoteSymbol: symbol,
      symbolName: name,
      quoteMode: "MANUAL",
      quoteCcy: "EUR",
      instrumentType: "EQUITY",
      ...(transfer ? { isExternal: true } : {}),
    });
  }
  if (drafts.length === 0 || units !== scaled(closingUnits))
    throw new Error("movement-units-mismatch");
  if (total !== scaled(entries)) throw new Error("movement-total-mismatch");
  return {
    symbol,
    name,
    closingDate,
    closingValue,
    closingUnits,
    closingPrice,
    openingUnits,
    drafts,
  };
}

export function prepareSantanderPension(statements: PensionStatement[]): {
  drafts: DraftActivity[];
  statements: PensionStatement[];
} {
  const ordered = [...statements].sort((a, b) => a.closingDate.localeCompare(b.closingDate));
  if (!ordered.length || scaled(ordered[0].openingUnits) !== 0n) throw new Error("missing-history");
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1],
      next = ordered[index];
    if (
      previous.symbol !== next.symbol ||
      previous.closingDate === next.closingDate ||
      scaled(previous.closingUnits) !== scaled(next.openingUnits) ||
      next.drafts.some((draft) => draft.activityDate <= previous.closingDate)
    )
      throw new Error("overlapping-history");
  }
  return {
    statements: ordered,
    drafts: ordered
      .flatMap((statement) => statement.drafts)
      .map((draft, rowIndex) => ({ ...draft, rowIndex })),
  };
}
