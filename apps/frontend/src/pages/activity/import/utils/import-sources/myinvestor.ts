import { AccountType, ActivityType } from "@/lib/constants";
import { currencyFractionDigits } from "@/lib/currency-decimals";
import {
  MYINVESTOR_RECONCILIATION_URL,
  type SourceReconciliation,
} from "@/lib/source-reconciliation";
import type { DraftActivity } from "../../context";
import { validateDraft } from "../draft-utils";
import { calculateUnitPrice } from "../mapping-values";
import { parseSignedNumericValue } from "../review-draft-utils";
import type {
  ControlBalance,
  MyInvestorMovement,
  MyInvestorParsedFiles,
  MyInvestorSecurityOperation,
  MyInvestorMatchCandidate,
  MyInvestorMatchSuggestion,
  MyInvestorMatchEvidence,
  MyInvestorOperationMatches,
  PrepareMyInvestorImportOptions,
  PreparedMyInvestorImport,
  SourceDiagnostic,
  SourceProvenance,
  SettlementCheck,
} from "./source-types";

interface ParsedHtmlFile {
  fileName: string;
  movements: MyInvestorMovement[];
  securities: MyInvestorSecurityOperation[];
  controls: ControlBalance[];
  diagnostics: SourceDiagnostic[];
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleUpperCase("es");
}

function canonicalDecimal(value: string, locale: "es" | "en", rowIndex: number): string {
  const compact = value.trim().replace(/\s/g, "");
  const spanish =
    /^[+-]?\d+(?:,\d+)?$/.test(compact) || /^[+-]?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(compact);
  const english =
    /^[+-]?\d+(?:\.\d+)?$/.test(compact) || /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(compact);
  if (!(locale === "es" ? spanish : english)) {
    throw new Error(`Invalid number in source row ${rowIndex + 1}.`);
  }
  const normalized =
    locale === "es" ? compact.replace(/\./g, "").replace(",", ".") : compact.replace(/,/g, "");
  const parsed = parseSignedNumericValue(normalized, ".", "none");
  if (parsed === undefined) throw new Error(`Invalid number in source row ${rowIndex + 1}.`);
  const negative = parsed.startsWith("-");
  const unsigned = parsed.replace(/^[+-]/, "");
  const [integer = "0", fraction = ""] = unsigned.split(".");
  const cleanInteger = integer.replace(/^0+(?=\d)/, "");
  const cleanFraction = fraction.replace(/0+$/, "");
  const magnitude = cleanFraction ? `${cleanInteger}.${cleanFraction}` : cleanInteger;
  return negative && magnitude !== "0" ? `-${magnitude}` : magnitude;
}

function strictDate(value: string, rowIndex: number, order: "es" | "iso"): string {
  let year: number, month: number, day: number;
  if (order === "es") {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
    if (!match) throw new Error(`Invalid date in source row ${rowIndex + 1}.`);
    day = Number(match[1]);
    month = Number(match[2]);
    year = Number(match[3]);
  } else {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) throw new Error(`Invalid date in source row ${rowIndex + 1}.`);
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid date in source row ${rowIndex + 1}.`);
  }
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function htmlRows(html: string): { rowIndex: number; cells: string[] }[] {
  const document = new DOMParser().parseFromString(html, "text/html");
  return [...document.querySelectorAll("tr")].flatMap((row, rowIndex) => {
    const cells = [...row.querySelectorAll("th, td")].map((cell) =>
      (cell.textContent ?? "").replace(/\u00a0/g, " ").trim(),
    );
    return cells.length > 0 ? [{ rowIndex, cells }] : [];
  });
}

function provenance(fileName: string, rowIndex: number, cells: string[]): SourceProvenance {
  return {
    fileName,
    rowIndex,
    rowKey: [fileName, rowIndex, cells.map((cell) => normalize(cell)).join("|")]
      .join("|")
      .toLocaleLowerCase("es"),
  };
}

function parseMovementFile(
  fileName: string,
  rows: ReturnType<typeof htmlRows>,
): ParsedHtmlFile | undefined {
  const header = rows.find(
    ({ cells }) =>
      cells.some((cell) => normalize(cell) === "FECHA OPERACION") &&
      cells.some((cell) => normalize(cell) === "CONCEPTO"),
  );
  const sevenColumn = rows.filter(
    ({ cells }) => cells.length === 7 && /^\d{2}\/\d{2}\/\d{4}$/.test(cells[0]),
  );
  const sixColumn = rows.filter(
    ({ cells }) => cells.length === 6 && /^\d{2}\/\d{2}\/\d{4}$/.test(cells[0]),
  );
  if (!header || (sevenColumn.length === 0 && sixColumn.length === 0)) return undefined;

  const diagnostics: SourceDiagnostic[] = [];
  const controls: ControlBalance[] = [];
  for (const { rowIndex, cells } of rows) {
    if (cells.length !== 3 || !/^\d{2}\/\d{2}\/\d{4}$/.test(cells[0])) continue;
    const kind = normalize(cells[1]).includes("INICIO")
      ? "opening"
      : normalize(cells[1]).includes("FINAL")
        ? "closing"
        : undefined;
    if (!kind) continue;
    try {
      controls.push({
        fileName,
        kind,
        date: strictDate(cells[0], rowIndex, "es"),
        amount: canonicalDecimal(cells[2], "es", rowIndex),
        currency: "EUR",
        rowIndex,
      });
    } catch (error) {
      diagnostics.push({
        severity: "error",
        code: "invalid-control-balance",
        message: error instanceof Error ? error.message : "Invalid MyInvestor balance row.",
        fileName,
        rowIndex,
      });
    }
  }

  const movements: MyInvestorMovement[] = [];
  for (const { rowIndex, cells } of [...sevenColumn, ...sixColumn]) {
    try {
      const hasBalance = cells.length === 7;
      const [
        dateText,
        valueDateText,
        operation,
        concept,
        currencyOrDirection,
        amountText,
        balanceText,
      ] = cells;
      const currency = hasBalance ? "EUR" : currencyOrDirection.toUpperCase();
      const amount = canonicalDecimal(amountText, "es", rowIndex);
      movements.push({
        source: provenance(fileName, rowIndex, cells),
        date: strictDate(dateText, rowIndex, "es"),
        valueDate: strictDate(valueDateText, rowIndex, "es"),
        operation: operation.trim(),
        concept: concept.trim(),
        amount,
        currency,
        ...(hasBalance && balanceText
          ? { balance: canonicalDecimal(balanceText, "es", rowIndex) }
          : {}),
      });
    } catch (error) {
      diagnostics.push({
        severity: "error",
        code: "invalid-cash-row",
        message: error instanceof Error ? error.message : "Invalid MyInvestor cash row.",
        fileName,
        rowIndex,
      });
    }
  }
  return { fileName, movements, securities: [], controls, diagnostics };
}

function parseSecurityFile(
  fileName: string,
  rows: ReturnType<typeof htmlRows>,
): ParsedHtmlFile | undefined {
  const data = rows.filter(
    ({ cells }) => cells.length === 11 && /^\d{4}-\d{2}-\d{2}$/.test(cells[0]),
  );
  if (
    data.length === 0 ||
    !rows.some(({ cells }) => cells.some((cell) => normalize(cell) === "ISIN"))
  ) {
    return undefined;
  }
  const diagnostics: SourceDiagnostic[] = [];
  const securities: MyInvestorSecurityOperation[] = [];
  for (const { rowIndex, cells } of data) {
    const [
      tradeDateText,
      settlementDateText,
      operationNumber,
      market,
      operation,
      isin,
      name,
      quantityText,
      currency,
      unitPriceText,
      amountText,
    ] = cells;
    try {
      const normalizedOperation = normalize(operation);
      const activityType =
        normalizedOperation === "SUSCRIPCION" || normalizedOperation === "COMPRA"
          ? ActivityType.BUY
          : normalizedOperation === "REEMBOLSO" || normalizedOperation === "VENTA"
            ? ActivityType.SELL
            : undefined;
      if (!activityType) {
        diagnostics.push({
          severity: "error",
          code: "unsupported-security-operation",
          message: `Unsupported MyInvestor security operation: ${operation}.`,
          fileName,
          rowIndex,
        });
        continue;
      }
      const amount = canonicalDecimal(amountText, "en", rowIndex);
      const quantity = canonicalDecimal(quantityText, "en", rowIndex);
      const unitPrice = canonicalDecimal(unitPriceText, "en", rowIndex);
      if (!isin.trim() || Number(quantity) <= 0 || Number(unitPrice) <= 0 || Number(amount) <= 0) {
        throw new Error(`Invalid security operation in source row ${rowIndex + 1}.`);
      }
      securities.push({
        source: provenance(fileName, rowIndex, cells),
        tradeDate: strictDate(tradeDateText, rowIndex, "iso"),
        settlementDate: strictDate(settlementDateText, rowIndex, "iso"),
        operationNumber: operationNumber.trim(),
        market: market.trim(),
        operation: operation.trim(),
        isin: isin.trim().toUpperCase(),
        name: name.trim(),
        quantity,
        currency: currency.trim().toUpperCase(),
        unitPrice,
        amount,
        activityType,
      });
    } catch (error) {
      diagnostics.push({
        severity: "error",
        code: "invalid-security-row",
        message: error instanceof Error ? error.message : "Invalid MyInvestor security row.",
        fileName,
        rowIndex,
      });
    }
  }
  return { fileName, movements: [], securities, controls: [], diagnostics };
}

function decimalToParts(value: string): { units: bigint; scale: number } {
  const negative = value.startsWith("-");
  const [integer, fraction = ""] = value.replace(/^[+-]/, "").split(".");
  const units = BigInt(`${integer}${fraction}` || "0");
  return { units: negative ? -units : units, scale: fraction.length };
}

function sumDecimals(values: string[]): string {
  const parts = values.map(decimalToParts);
  const scale = Math.max(0, ...parts.map((part) => part.scale));
  const units = parts.reduce(
    (sum, part) => sum + part.units * 10n ** BigInt(scale - part.scale),
    0n,
  );
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const magnitude = scale > 0 ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return canonicalDecimal(`${negative ? "-" : ""}${magnitude}`, "en", 0);
}

function sameMoney(a: string, b: string): boolean {
  return canonicalDecimal(a, "en", 0) === canonicalDecimal(b, "en", 0);
}

function deduplicateOverlappingMovements(fileRows: MyInvestorMovement[][]): MyInvestorMovement[] {
  const maxCounts = new Map<string, number>();
  const result: MyInvestorMovement[] = [];
  for (const movements of fileRows) {
    const counts = new Map<string, number>();
    for (const movement of movements) {
      const key = [
        movement.date,
        movement.valueDate,
        normalize(movement.operation),
        normalize(movement.concept),
        movement.amount,
        movement.currency,
        movement.balance ?? "",
      ].join("|");
      const occurrence = (counts.get(key) ?? 0) + 1;
      counts.set(key, occurrence);
      if (occurrence > (maxCounts.get(key) ?? 0)) {
        maxCounts.set(key, occurrence);
        result.push(movement);
      }
    }
  }
  return result;
}

function deduplicateOverlappingSecurities(
  fileRows: MyInvestorSecurityOperation[][],
): MyInvestorSecurityOperation[] {
  const maxCounts = new Map<string, number>();
  const result: MyInvestorSecurityOperation[] = [];
  for (const securities of fileRows) {
    const counts = new Map<string, number>();
    for (const security of securities) {
      const key = [
        security.tradeDate,
        security.settlementDate,
        security.operationNumber,
        security.market,
        security.operation,
        security.isin,
        security.quantity,
        security.currency,
        security.unitPrice,
        security.amount,
      ].join("|");
      const occurrence = (counts.get(key) ?? 0) + 1;
      counts.set(key, occurrence);
      if (occurrence > (maxCounts.get(key) ?? 0)) {
        maxCounts.set(key, occurrence);
        result.push(security);
      }
    }
  }
  return result;
}

export function parseMyInvestorFiles(
  files: { name: string; content: string }[],
): MyInvestorParsedFiles {
  const parsed: ParsedHtmlFile[] = [];
  const diagnostics: SourceDiagnostic[] = [];
  for (const file of files) {
    const rows = htmlRows(file.content);
    const result = parseMovementFile(file.name, rows) ?? parseSecurityFile(file.name, rows);
    if (!result) {
      diagnostics.push({
        severity: "error",
        code: "unrecognized-html-export",
        message: `Could not recognize the Inversis HTML export in ${file.name}.`,
        fileName: file.name,
      });
      continue;
    }
    diagnostics.push(...result.diagnostics);
    parsed.push(result);
  }

  const controls = parsed.flatMap((file) => file.controls);
  for (const file of parsed.filter((item) => item.controls.length > 0)) {
    const opening = file.controls.find((control) => control.kind === "opening");
    const closing = file.controls.find((control) => control.kind === "closing");
    if (!opening || !closing) {
      diagnostics.push({
        severity: "error",
        code: "incomplete-control-balances",
        message: `The balances in ${file.fileName} are missing their opening or closing value.`,
        fileName: file.fileName,
      });
      continue;
    }
    const calculatedClosing = sumDecimals([
      opening.amount,
      ...file.movements.map((row) => row.amount),
    ]);
    if (!sameMoney(calculatedClosing, closing.amount)) {
      diagnostics.push({
        severity: "error",
        code: "cash-balance-mismatch",
        message: `The cash movements in ${file.fileName} do not reconcile to its closing balance.`,
        fileName: file.fileName,
      });
    }
  }

  const movements = deduplicateOverlappingMovements(parsed.map((file) => file.movements));
  const securities = deduplicateOverlappingSecurities(parsed.map((file) => file.securities));
  if (movements.length === 0) {
    diagnostics.push({
      severity: "error",
      code: "missing-cash-rows",
      message: "No cash movement rows were found.",
    });
  }
  if (securities.length === 0) {
    diagnostics.push({
      severity: "error",
      code: "missing-security-rows",
      message: "No security operation rows were found.",
    });
  }
  return { movements, securities, controls, diagnostics };
}

function daysBetween(dateA: string, dateB: string): number {
  return Math.abs(Date.parse(`${dateA}T00:00:00Z`) - Date.parse(`${dateB}T00:00:00Z`)) / 86_400_000;
}

function isPurchase(operation: MyInvestorSecurityOperation): boolean {
  return operation.activityType === ActivityType.BUY;
}

function suggestMovementForSecurity(
  movement: MyInvestorMovement,
  security: MyInvestorSecurityOperation,
): MyInvestorMatchCandidate | undefined {
  const cashOperation = normalize(movement.operation);
  const securityOperation = normalize(security.operation);
  const categoryMatches =
    (securityOperation === "SUSCRIPCION" && cashOperation.startsWith("SUSCRIPCION IIC")) ||
    (securityOperation === "COMPRA" && cashOperation.startsWith("COMPRA RV CONTADO")) ||
    (securityOperation === "REEMBOLSO" && cashOperation.startsWith("REEMBOLSO")) ||
    (securityOperation === "VENTA" && cashOperation.startsWith("VENTA"));
  const purchase = isPurchase(security);
  const signMatches = purchase ? Number(movement.amount) < 0 : Number(movement.amount) > 0;
  const nameEvidence = compareInstrumentNames(movement.concept, security.name);
  const cashDates = [movement.date, movement.valueDate];
  const securityDates = [security.tradeDate, security.settlementDate];
  const operationDateDistance = Math.min(
    ...cashDates.flatMap((cashDate) =>
      securityDates.map((securityDate) => daysBetween(cashDate, securityDate)),
    ),
  );
  if (!categoryMatches || !signMatches) return undefined;
  const criteria: MyInvestorMatchCandidate["criteria"] = [];
  if (cashDates.some((cashDate) => securityDates.includes(cashDate))) {
    criteria.push("same-date");
  } else if (operationDateDistance <= 10) {
    criteria.push("near-date");
  } else {
    criteria.push("far-date");
  }
  if (sameMoney(movement.amount.replace(/^-/, ""), security.amount)) criteria.push("same-amount");
  if (nameEvidence.nameMatch === "exact") criteria.push("same-name");
  if (movement.currency !== security.currency) criteria.push("cross-currency");
  return {
    movement: movement.source,
    criteria,
    evidence: {
      dateRelation: getDateRelation(movement, security),
      ...nameEvidence,
      ...(movement.currency === security.currency
        ? {
            amountDifference: subtractDecimals(movement.amount.replace(/^-/, ""), security.amount),
          }
        : movement.currency === "EUR" && security.currency === "USD"
          ? { fxRate: calculateUnitPrice(movement.amount.replace(/^-/, ""), security.amount) }
          : {}),
    },
  };
}

const GENERIC_NAME_TOKENS = new Set([
  "ACC",
  "ACCUMULATING",
  "FUND",
  "FUNDS",
  "INDEX",
  "INVESTMENT",
  "INVESTMENTS",
  "PORTFOLIO",
  "SHARES",
  "TRUST",
  "UCITS",
]);
const CURRENCY_NAME_TOKENS = new Set(["EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD"]);
const HEDGING_NAME_TOKENS = new Set(["HEDGED", "UNHEDGED", "HDG", "UNHDG"]);
const CLASS_NAME_TOKENS = new Set(["ACC", "DIST", "DISTRIBUTING", "INC", "INCOME"]);

interface InstrumentNameEvidence {
  nameMatch: MyInvestorMatchEvidence["nameMatch"];
  nameScore: number;
}

function instrumentTokens(value: string): string[] {
  return normalize(value.split("@")[0]).match(/[A-Z0-9]+/g) ?? [];
}

function exactInstrumentName(first: string, second: string): boolean {
  const normalizeExact = (value: string) =>
    normalize(value.split("@")[0]).replace(/[^A-Z0-9]/g, "");
  const a = normalizeExact(first);
  return a.length > 0 && a === normalizeExact(second);
}

function tokenConflicts(first: string[], second: string[]): boolean {
  const values = [first, second];
  for (const group of [CURRENCY_NAME_TOKENS, HEDGING_NAME_TOKENS, CLASS_NAME_TOKENS]) {
    const descriptors = values.map((tokens) =>
      tokens
        .filter((token) => group.has(token))
        .sort()
        .join(" "),
    );
    if (descriptors[0] && descriptors[1] && descriptors[0] !== descriptors[1]) return true;
  }
  const classDescriptors = values.map((tokens) => {
    const index = tokens.findIndex((token) => token === "CLASS" || token === "CL");
    const prefixedClass = index >= 0 ? (tokens[index + 1] ?? "") : "";
    const codedClasses = tokens.filter((token) => /^[A-Z]\d{1,2}$/.test(token)).sort();
    return [prefixedClass, ...codedClasses].filter(Boolean).join(" ");
  });
  return Boolean(
    classDescriptors[0] && classDescriptors[1] && classDescriptors[0] !== classDescriptors[1],
  );
}

function compareInstrumentNames(first: string, second: string): InstrumentNameEvidence {
  if (exactInstrumentName(first, second)) return { nameMatch: "exact", nameScore: 1 };
  const a = instrumentTokens(first);
  const b = instrumentTokens(second);
  if (tokenConflicts(a, b)) return { nameMatch: "different", nameScore: 0 };
  const descriptors = new Set([
    ...CURRENCY_NAME_TOKENS,
    ...HEDGING_NAME_TOKENS,
    ...CLASS_NAME_TOKENS,
  ]);
  const meaningfulA = new Set(
    a.filter((token) => !GENERIC_NAME_TOKENS.has(token) && !descriptors.has(token)),
  );
  const meaningfulB = new Set(
    b.filter((token) => !GENERIC_NAME_TOKENS.has(token) && !descriptors.has(token)),
  );
  const overlap = [...meaningfulA].filter((token) => meaningfulB.has(token)).length;
  const union = new Set([...meaningfulA, ...meaningfulB]).size;
  const nameScore = union === 0 ? 0 : overlap / union;
  return overlap >= 2 && nameScore >= 0.5
    ? { nameMatch: "similar", nameScore }
    : { nameMatch: "different", nameScore };
}

function getDateRelation(
  movement: MyInvestorMovement,
  security: MyInvestorSecurityOperation,
): MyInvestorMatchEvidence["dateRelation"] {
  if (movement.valueDate === security.settlementDate) return "settlement-value";
  if (movement.date === security.tradeDate) return "trade-operation";
  return "other";
}

function eligibleProposalEvidence(
  movement: MyInvestorMovement,
  security: MyInvestorSecurityOperation,
): MyInvestorMatchEvidence | undefined {
  const candidate = suggestMovementForSecurity(movement, security);
  if (!candidate || candidate.evidence.dateRelation === "other") return undefined;
  if (
    movement.currency !== security.currency &&
    !(movement.currency === "EUR" && security.currency === "USD")
  ) {
    return undefined;
  }
  const { nameMatch } = candidate.evidence;
  if (nameMatch === "different") return undefined;
  if (nameMatch === "similar" && candidate.evidence.dateRelation !== "settlement-value") {
    return undefined;
  }
  return candidate.evidence;
}

function isStrongEvidence(evidence: MyInvestorMatchEvidence): boolean {
  return (
    evidence.dateRelation === "settlement-value" &&
    evidence.nameMatch === "exact" &&
    evidence.amountDifference === "0"
  );
}

function proposalScore(evidence: MyInvestorMatchEvidence): number {
  const dateScore =
    evidence.dateRelation === "settlement-value"
      ? 1000
      : evidence.dateRelation === "trade-operation"
        ? 500
        : 0;
  const nameScore = evidence.nameMatch === "exact" ? 100 : evidence.nameScore * 100;
  const sameAmount = evidence.amountDifference === "0" ? 5 : 0;
  const sameCurrency = evidence.amountDifference !== undefined ? 3 : 0;
  return dateScore + nameScore + sameAmount + sameCurrency;
}

function uniqueSeparatedBest<T>(
  values: T[],
  score: (value: T) => number,
  key: (value: T) => string,
): T | undefined {
  const ordered = [...values].sort((a, b) => score(b) - score(a) || key(a).localeCompare(key(b)));
  if (ordered.length === 0) return undefined;
  const best = ordered[0];
  const runnerUp = ordered[1];
  return best && (!runnerUp || score(best) - score(runnerUp) >= 5) ? best : undefined;
}

function decimalScaled(value: string, scale: number): bigint {
  const negative = value.startsWith("-");
  const [integer = "0", fraction = ""] = value.replace(/^[+-]/, "").split(".");
  const retained = (fraction + "0".repeat(scale)).slice(0, scale);
  let units = BigInt(integer) * 10n ** BigInt(scale) + BigInt(retained || "0");
  if (fraction.length > scale && Number(fraction[scale]) >= 5) units += 1n;
  return negative ? -units : units;
}

function formatScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const base = 10n ** BigInt(scale);
  const integer = magnitude / base;
  const fraction = (magnitude % base).toString().padStart(scale, "0").replace(/0+$/, "");
  const formatted = fraction ? `${integer}.${fraction}` : integer.toString();
  return negative && magnitude !== 0n ? `-${formatted}` : formatted;
}

function subtractDecimals(first: string, second: string): string {
  const scale = Math.max(first.split(".")[1]?.length ?? 0, second.split(".")[1]?.length ?? 0);
  return formatScaled(decimalScaled(first, scale) - decimalScaled(second, scale), scale);
}

function multiplyDecimals(first: string, second: string, resultScale = 2): string {
  const precision = Math.max(first.split(".")[1]?.length ?? 0, 2);
  const ratePrecision = Math.max(second.split(".")[1]?.length ?? 0, 2);
  const product = decimalScaled(first, precision) * decimalScaled(second, ratePrecision);
  const productScale = precision + ratePrecision;
  const divisor = 10n ** BigInt(productScale - resultScale);
  const rounded =
    product >= 0n ? (product + divisor / 2n) / divisor : (product - divisor / 2n) / divisor;
  return formatScaled(rounded, resultScale);
}

function stableTransferReferences(
  securities: MyInvestorSecurityOperation[],
): Map<MyInvestorSecurityOperation, string> {
  const describe = (security: MyInvestorSecurityOperation) =>
    [
      security.operationNumber,
      security.isin,
      security.tradeDate,
      security.settlementDate,
      security.quantity,
      security.currency,
      security.unitPrice,
      security.amount,
    ].join("|");
  const occurrences = new Map<string, number>();
  const result = new Map<MyInvestorSecurityOperation, string>();
  for (const security of [...securities].sort((a, b) => describe(a).localeCompare(describe(b)))) {
    const identity = describe(security);
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    result.set(security, `${identity}|${occurrence}`);
  }
  return result;
}

function signedActivityAmount(draft: DraftActivity): string | undefined {
  const amount = draft.amount ?? "0";
  const negativeTypes = new Set<string>([
    ActivityType.BUY,
    ActivityType.FEE,
    ActivityType.TAX,
    ActivityType.TRANSFER_OUT,
    ActivityType.WITHDRAWAL,
  ]);
  const positiveTypes = new Set<string>([
    ActivityType.DEPOSIT,
    ActivityType.DIVIDEND,
    ActivityType.INTEREST,
    ActivityType.SELL,
    ActivityType.TRANSFER_IN,
  ]);
  if (negativeTypes.has(draft.activityType)) return `-${amount.replace(/^-/, "")}`;
  if (positiveTypes.has(draft.activityType)) return amount.replace(/^-/, "");
  return undefined;
}

function addLedgerValue(
  ledger: Map<string, { accountId: string; currency: string; amount: bigint }>,
  accountId: string,
  currency: string,
  value: string,
): void {
  const key = `${accountId}|${currency}`;
  const item = ledger.get(key) ?? { accountId, currency, amount: 0n };
  item.amount += decimalScaled(value, 2);
  ledger.set(key, item);
}

function ledgerChecks(
  drafts: DraftActivity[],
  parsed: MyInvestorParsedFiles,
  fundsAccountId: string,
  cashAccountId: string | undefined,
  resolvedMatches: Map<MyInvestorSecurityOperation, MyInvestorMovement>,
): SettlementCheck[] {
  const separateCashAccount = !!cashAccountId && cashAccountId !== fundsAccountId;
  const expected = new Map<string, { accountId: string; currency: string; amount: bigint }>();
  const actual = new Map<string, { accountId: string; currency: string; amount: bigint }>();
  const cashAccount =
    cashAccountId && cashAccountId !== fundsAccountId ? cashAccountId : fundsAccountId;
  for (const movement of parsed.movements) {
    if (normalize(movement.operation) === "APERTURA") continue;
    addLedgerValue(expected, cashAccount, movement.currency, movement.amount);
  }
  if (separateCashAccount) {
    for (const movement of resolvedMatches.values()) {
      addLedgerValue(expected, fundsAccountId, movement.currency, "0");
    }
  }
  for (const draft of drafts) {
    const signed = signedActivityAmount(draft);
    if (!signed) continue;
    let currency = draft.currency;
    let value = signed;
    const fxRate = draft.fxRate;
    if (draft.accountId === fundsAccountId && draft.currency !== "EUR" && fxRate) {
      currency = "EUR";
      value = multiplyDecimals(signed, fxRate, 2);
    }
    addLedgerValue(actual, draft.accountId, currency, value);
  }
  const keys = new Set([...expected.keys(), ...actual.keys()]);
  return [...keys].sort().map((key) => {
    const expectedAmount = expected.get(key);
    const actualAmount = actual.get(key);
    const accountId = expectedAmount?.accountId ?? actualAmount!.accountId;
    const currency = expectedAmount?.currency ?? actualAmount!.currency;
    const expectedValue = expectedAmount?.amount ?? 0n;
    const actualValue = actualAmount?.amount ?? 0n;
    return {
      accountId,
      currency,
      expected: formatScaled(expectedValue, 2),
      actual: formatScaled(actualValue, 2),
      isBalanced: expectedValue === actualValue,
    };
  });
}

export function matchMyInvestorOperations(
  parsed: MyInvestorParsedFiles,
  manualMatches: Record<string, string> = {},
): MyInvestorOperationMatches {
  const securities = [...parsed.securities].sort((a, b) =>
    a.source.rowKey.localeCompare(b.source.rowKey),
  );
  const movements = [...parsed.movements].sort((a, b) =>
    a.source.rowKey.localeCompare(b.source.rowKey),
  );
  const reservedMovementKeys = new Set(
    Object.values(manualMatches).filter((movementKey) => movementKey.length > 0),
  );
  const matches: Record<string, string> = Object.fromEntries(
    Object.entries(manualMatches)
      .filter(([, movementKey]) => movementKey.length > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const suggestions: MyInvestorMatchSuggestion[] = securities.map((security) => ({
    security: security.source,
    candidates: movements
      .flatMap((movement) => {
        const candidate = suggestMovementForSecurity(movement, security);
        return candidate ? [candidate] : [];
      })
      .sort(
        (a, b) =>
          proposalScore(b.evidence) - proposalScore(a.evidence) ||
          a.movement.rowKey.localeCompare(b.movement.rowKey),
      ),
  }));

  const availableSecurities = securities.filter(
    (security) => !Object.hasOwn(manualMatches, security.source.rowKey),
  );
  const availableMovements = movements.filter(
    (movement) => !reservedMovementKeys.has(movement.source.rowKey),
  );
  const strongBySecurity = new Map<string, string[]>();
  const strongByMovement = new Map<string, string[]>();
  for (const security of availableSecurities) {
    for (const movement of availableMovements) {
      const evidence = eligibleProposalEvidence(movement, security);
      if (!evidence || !isStrongEvidence(evidence) || movement.currency !== security.currency) {
        continue;
      }
      const securityCandidates = strongBySecurity.get(security.source.rowKey) ?? [];
      securityCandidates.push(movement.source.rowKey);
      strongBySecurity.set(security.source.rowKey, securityCandidates);
      const movementCandidates = strongByMovement.get(movement.source.rowKey) ?? [];
      movementCandidates.push(security.source.rowKey);
      strongByMovement.set(movement.source.rowKey, movementCandidates);
    }
  }

  const autoMatches: Record<string, string> = {};
  for (const [securityKey, movementKeys] of [...strongBySecurity.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (movementKeys.length !== 1) continue;
    const movementKey = movementKeys[0];
    if (movementKey && strongByMovement.get(movementKey)?.length === 1) {
      autoMatches[securityKey] = movementKey;
    }
  }
  Object.assign(matches, autoMatches);

  const usedSecurityKeys = new Set([...Object.keys(manualMatches), ...Object.keys(autoMatches)]);
  const usedMovementKeys = new Set([...reservedMovementKeys, ...Object.values(autoMatches)]);
  const proposalCandidates: { securityKey: string; movementKey: string; score: number }[] = [];
  for (const security of securities) {
    if (usedSecurityKeys.has(security.source.rowKey)) continue;
    for (const movement of movements) {
      if (usedMovementKeys.has(movement.source.rowKey)) continue;
      const evidence = eligibleProposalEvidence(movement, security);
      if (!evidence) continue;
      proposalCandidates.push({
        securityKey: security.source.rowKey,
        movementKey: movement.source.rowKey,
        score: proposalScore(evidence),
      });
    }
  }
  const bestMovementBySecurity = new Map<string, string>();
  const bestSecurityByMovement = new Map<string, string>();
  for (const securityKey of [
    ...new Set(proposalCandidates.map(({ securityKey }) => securityKey)),
  ].sort()) {
    const candidates = proposalCandidates.filter(
      (candidate) => candidate.securityKey === securityKey,
    );
    const best = uniqueSeparatedBest(
      candidates,
      ({ score }) => score,
      ({ movementKey }) => movementKey,
    );
    if (best) bestMovementBySecurity.set(securityKey, best.movementKey);
  }
  for (const movementKey of [
    ...new Set(proposalCandidates.map(({ movementKey }) => movementKey)),
  ].sort()) {
    const candidates = proposalCandidates.filter(
      (candidate) => candidate.movementKey === movementKey,
    );
    const best = uniqueSeparatedBest(
      candidates,
      ({ score }) => score,
      ({ securityKey }) => securityKey,
    );
    if (best) bestSecurityByMovement.set(movementKey, best.securityKey);
  }
  const proposals: Record<string, string> = {};
  for (const [securityKey, movementKey] of [...bestMovementBySecurity.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (bestSecurityByMovement.get(movementKey) === securityKey)
      proposals[securityKey] = movementKey;
  }
  return { matches, proposals, suggestions };
}

function inferredCashActivityType(movement: MyInvestorMovement): string {
  const operation = normalize(movement.operation);
  if (
    operation === "LIQUIDAC. INTERESES" ||
    (operation.includes("LIQUIDAC") && operation.includes("INTERES"))
  ) {
    return ActivityType.INTEREST;
  }
  if (operation.includes("RETENCION") || operation.includes("IMPUESTO")) return ActivityType.TAX;
  if (operation.includes("COMISION") || operation.includes("GASTOS")) return ActivityType.FEE;
  if (operation === "CARGO POR TRANSFERENCIA") return ActivityType.WITHDRAWAL;
  if (operation === "ABONO POR TRANSFERENCIA") return ActivityType.DEPOSIT;
  if (operation === "TRANSFERENCIA INMEDIATA" || operation === "TRANSFERENCIA SEPA") {
    return Number(movement.amount) < 0 ? ActivityType.WITHDRAWAL : ActivityType.DEPOSIT;
  }
  return ActivityType.UNKNOWN;
}

export function prepareMyInvestorImport(
  parsed: MyInvestorParsedFiles,
  { fundsAccountId, cashAccountId, matches: selectedMatches = {} }: PrepareMyInvestorImportOptions,
): PreparedMyInvestorImport {
  const diagnostics = [...parsed.diagnostics];
  const drafts: DraftActivity[] = [];
  const matchSuggestions: MyInvestorMatchSuggestion[] = parsed.securities.map((security) => ({
    security: security.source,
    candidates: parsed.movements.flatMap((movement) => {
      const suggestion = suggestMovementForSecurity(movement, security);
      return suggestion ? [suggestion] : [];
    }),
  }));
  if (!fundsAccountId) {
    return {
      drafts,
      legacyTransferDrafts: [],
      controls: parsed.controls,
      matchSuggestions,
      settlementChecks: [],
      diagnostics: [
        ...diagnostics,
        {
          severity: "error",
          code: "missing-funds-account",
          message: "Select the MyInvestor funds account.",
        },
      ],
    };
  }
  const separateCashAccount = !!cashAccountId && cashAccountId !== fundsAccountId;
  if (cashAccountId === fundsAccountId) {
    diagnostics.push({
      severity: "warning",
      code: "same-cash-funds-account",
      message: "Cash and fund operations will be imported into the selected account.",
    });
  }

  const resolvedMatches = new Map<MyInvestorSecurityOperation, MyInvestorMovement>();
  const matchedMovements = new Set<MyInvestorMovement>();
  const securityByKey = new Map(
    parsed.securities.map((security) => [security.source.rowKey, security]),
  );
  const movementByKey = new Map(
    parsed.movements.map((movement) => [movement.source.rowKey, movement]),
  );
  for (const [securityKey, movementKey] of Object.entries(selectedMatches)) {
    if (!securityByKey.has(securityKey) || !movementByKey.has(movementKey)) {
      diagnostics.push({
        severity: "error",
        code: "invalid-row-match",
        message: "A selected MyInvestor match no longer exists in the parsed files.",
      });
      continue;
    }
    const security = securityByKey.get(securityKey)!;
    const movement = movementByKey.get(movementKey)!;
    if (matchedMovements.has(movement)) {
      diagnostics.push({
        severity: "error",
        code: "cash-row-matched-more-than-once",
        message: `Cash row ${movement.source.rowIndex + 1} is selected for more than one security operation.`,
        fileName: movement.source.fileName,
        rowIndex: movement.source.rowIndex,
      });
      continue;
    }
    const candidate = suggestMovementForSecurity(movement, security);
    if (!candidate) {
      diagnostics.push({
        severity: "error",
        code: "invalid-row-match",
        message: `Cash row ${movement.source.rowIndex + 1} does not fit the operation type and direction for ${security.name}.`,
        fileName: movement.source.fileName,
        rowIndex: movement.source.rowIndex,
      });
      continue;
    }
    if (
      movement.currency !== security.currency &&
      !(movement.currency === "EUR" && security.currency === "USD")
    ) {
      diagnostics.push({
        severity: "error",
        code: "unsupported-currency-match",
        message: `Cannot reconcile ${movement.currency} cash with ${security.currency} security activity.`,
        fileName: movement.source.fileName,
        rowIndex: movement.source.rowIndex,
      });
      continue;
    }
    resolvedMatches.set(security, movement);
    matchedMovements.add(movement);
  }
  for (const security of parsed.securities) {
    if (resolvedMatches.has(security)) continue;
    const candidates =
      matchSuggestions.find((suggestion) => suggestion.security.rowKey === security.source.rowKey)
        ?.candidates ?? [];
    diagnostics.push({
      severity: "error",
      code: candidates.length === 0 ? "unmatched-security-operation" : "security-match-required",
      message:
        candidates.length === 0
          ? `No likely cash match was found for ${security.operation} ${security.name}; select the actual cash row to continue.`
          : `Select the cash row for ${security.operation} ${security.name}; ${candidates.length} possible match${candidates.length === 1 ? "" : "es"} found.`,
      fileName: security.source.fileName,
      rowIndex: security.source.rowIndex,
    });
  }
  for (const movement of matchedMovements) {
    const security = [...resolvedMatches.entries()].find(
      ([, candidate]) => candidate === movement,
    )?.[0];
    if (!security) continue;
    if (
      movement.currency === security.currency &&
      !sameMoney(movement.amount.replace(/^-/, ""), security.amount)
    ) {
      diagnostics.push({
        severity: "warning",
        code: "bank-amount-differs-from-security-net",
        message: `The cash debit differs from the source net amount for ${security.name}; the imported amount will use the bank movement.`,
        fileName: movement.source.fileName,
        rowIndex: movement.source.rowIndex,
      });
    }
  }

  const accountTypeById = new Map<string, string>([
    [fundsAccountId, AccountType.SECURITIES],
    ...(separateCashAccount ? [[cashAccountId, AccountType.CASH] as [string, string]] : []),
  ]);
  const addDraft = (data: Omit<DraftActivity, "status" | "errors" | "warnings" | "isEdited">) => {
    const validation = validateDraft(data, accountTypeById);
    const draft = { ...data, ...validation, isEdited: false };
    drafts.push(draft);
    return draft;
  };
  let rowIndex = 0;
  const transferReferences = stableTransferReferences([...resolvedMatches.keys()]);
  const legacyTransferDrafts: DraftActivity[] = [];
  const legacyProbeKeys = new Set<string>();
  const addTransferLeg = (
    movement: MyInvestorMovement,
    date: string,
    activityType: string,
    amount: string,
    currency: string,
    accountId: string,
    comment: string,
    sourceOperationGroup: string,
  ) => {
    const draft = addDraft({
      rowIndex: rowIndex++,
      rawRow: [date, activityType, amount],
      activityDate: date,
      activityType,
      amount,
      currency,
      currencySource: "csv",
      accountId,
      comment,
      isExternal: false,
      sourceOperationGroup,
    });
    const legacyDescription = movement.concept.trim().split(/\s+/).join(" ");
    const legacyKey = [
      draft.accountId,
      draft.activityType,
      draft.activityDate,
      "",
      "",
      "",
      canonicalDecimal(draft.amount ?? "0", "en", draft.rowIndex),
      draft.currency,
      "",
      legacyDescription,
    ].join("|");
    if (legacyProbeKeys.has(legacyKey)) return;
    legacyProbeKeys.add(legacyKey);
    const { sourceOperationGroup: _sourceOperationGroup, ...legacyDraft } = draft;
    legacyTransferDrafts.push({
      ...legacyDraft,
      rowIndex: legacyTransferDrafts.length,
      rawRow: [date, activityType, amount, movement.concept],
      comment: movement.concept,
    });
  };
  const cashOccurrences = new Map<string, number>();
  const addMovementActivity = (movement: MyInvestorMovement) => {
    const activityType = inferredCashActivityType(movement);
    if (activityType === ActivityType.UNKNOWN) {
      diagnostics.push({
        severity: "error",
        code: "unsupported-cash-operation",
        message: `Unrecognized MyInvestor cash operation: ${movement.operation} (${movement.source.fileName}, row ${movement.source.rowIndex + 1}).`,
        fileName: movement.source.fileName,
        rowIndex: movement.source.rowIndex,
      });
    }
    const absAmount = movement.amount.replace(/^-/, "");
    const cashIdentity = JSON.stringify([
      movement.date,
      movement.valueDate,
      movement.operation,
      movement.concept,
      movement.amount,
      movement.currency,
    ]);
    const occurrence = (cashOccurrences.get(cashIdentity) ?? 0) + 1;
    cashOccurrences.set(cashIdentity, occurrence);
    const reference =
      movement.balance !== undefined ? `balance=${movement.balance}` : `occurrence=${occurrence}`;
    addDraft({
      rowIndex: rowIndex++,
      rawRow: [
        movement.date,
        movement.operation,
        movement.concept,
        movement.amount,
        movement.currency,
      ],
      activityDate: movement.date,
      activityType,
      amount: absAmount,
      currency: movement.currency,
      currencySource: "csv",
      accountId: separateCashAccount ? cashAccountId : fundsAccountId,
      comment: `${movement.concept || movement.operation} [Inversis: ${movement.valueDate}; ${reference}]`,
    });
  };

  for (const movement of parsed.movements) {
    if (normalize(movement.operation) === "APERTURA") {
      if (sameMoney(movement.amount, "0")) {
        diagnostics.push({
          severity: "warning",
          code: "zero-opening-movement-skipped",
          message: `The zero-value opening movement in ${movement.source.fileName} was skipped.`,
          fileName: movement.source.fileName,
          rowIndex: movement.source.rowIndex,
        });
      } else {
        diagnostics.push({
          severity: "error",
          code: "nonzero-opening-movement",
          message: `The opening movement in ${movement.source.fileName} has a nonzero amount and requires review.`,
          fileName: movement.source.fileName,
          rowIndex: movement.source.rowIndex,
        });
      }
      continue;
    }
    const security = [...resolvedMatches.entries()].find(
      ([, candidate]) => candidate === movement,
    )?.[0];
    if (!security) {
      addMovementActivity(movement);
      continue;
    }
    if (!separateCashAccount) continue;
    const amount = movement.amount.replace(/^-/, "");
    const purchase = isPurchase(security);
    const reference = transferReferences.get(security) ?? security.source.rowKey;
    const transferComment = `${movement.concept || security.name} [Inversis ref ${reference}]`;
    if (purchase) {
      addTransferLeg(
        movement,
        movement.date,
        ActivityType.TRANSFER_OUT,
        amount,
        movement.currency,
        cashAccountId,
        transferComment,
        reference,
      );
      addTransferLeg(
        movement,
        movement.date,
        ActivityType.TRANSFER_IN,
        amount,
        movement.currency,
        fundsAccountId,
        transferComment,
        reference,
      );
    } else {
      addTransferLeg(
        movement,
        movement.date,
        ActivityType.TRANSFER_OUT,
        amount,
        movement.currency,
        fundsAccountId,
        transferComment,
        reference,
      );
      addTransferLeg(
        movement,
        movement.date,
        ActivityType.TRANSFER_IN,
        amount,
        movement.currency,
        cashAccountId,
        transferComment,
        reference,
      );
    }
  }

  for (const security of parsed.securities) {
    const movement = resolvedMatches.get(security);
    if (!movement) continue;
    const amount =
      movement.currency === security.currency ? movement.amount.replace(/^-/, "") : security.amount;
    const fxRate =
      movement.currency === "EUR" && security.currency === "USD"
        ? calculateUnitPrice(movement.amount.replace(/^-/, ""), security.amount)
        : undefined;
    const quantity = decimalToParts(security.quantity);
    const price = decimalToParts(security.unitPrice);
    const productScale = quantity.scale + price.scale;
    const calculated = formatScaled(quantity.units * price.units, productScale);
    const scale = Math.max(
      productScale,
      decimalToParts(amount).scale,
      currencyFractionDigits(security.currency) + 1,
    );
    const difference = decimalScaled(amount, scale) - decimalScaled(calculated, scale);
    const tolerance = 5n * 10n ** BigInt(scale - currencyFractionDigits(security.currency) - 1);
    let sourceReconciliation: SourceReconciliation | undefined;
    if ((difference < 0n ? -difference : difference) > tolerance) {
      sourceReconciliation = {
        version: 1,
        issueCode: "myinvestor_settlement_difference",
        reasonCode: "undetermined",
        tradeDate: security.tradeDate,
        settlementDate: security.settlementDate,
        operationReference: security.operationNumber,
        isin: security.isin,
        sourceFile: security.source.fileName,
        sourceRow: security.source.rowIndex + 1,
        currency: security.currency,
        quantity: security.quantity,
        unitPrice: security.unitPrice,
        sourceAmount: security.amount,
        settledAmount: amount,
        calculatedAmount: calculated,
        difference: formatScaled(difference, scale),
        referenceUrl: MYINVESTOR_RECONCILIATION_URL,
      };
      diagnostics.push({
        severity: "warning",
        code: "trade-total-review",
        message:
          "Quantity × price differs from the net amount. Source values are preserved; this trade will require review after import.",
        fileName: security.source.fileName,
        rowIndex: security.source.rowIndex,
        values: {
          isin: security.isin,
          quantity: security.quantity,
          price: security.unitPrice,
          amount,
          currency: security.currency,
          difference: formatScaled(difference, scale),
        },
      });
    }
    addDraft({
      rowIndex: rowIndex++,
      rawRow: [
        security.tradeDate,
        security.operation,
        security.isin,
        security.quantity,
        security.unitPrice,
        security.amount,
      ],
      // The engine applies units and cash together on activityDate. Use the
      // cash booking date so the trade and its funding share one ledger day.
      activityDate: movement.date,
      activityType: security.activityType,
      symbol: security.isin,
      isin: security.isin,
      symbolName: security.name,
      sourceReconciliation,
      quantity: security.quantity,
      unitPrice: security.unitPrice,
      amount,
      fxRate,
      currency: security.currency,
      currencySource: "csv",
      accountId: fundsAccountId,
      comment:
        (security.operationNumber
          ? `${security.operation} [Inversis: ${security.operationNumber}]`
          : security.operation) +
        (movement.date !== security.tradeDate
          ? ` [Trade: ${security.tradeDate}; Settlement: ${security.settlementDate}]`
          : ""),
      ...(separateCashAccount ? { sourceOperationGroup: transferReferences.get(security) } : {}),
    });
  }

  const settlementChecks = ledgerChecks(
    drafts,
    parsed,
    fundsAccountId,
    separateCashAccount ? cashAccountId : undefined,
    resolvedMatches,
  );
  for (const check of settlementChecks) {
    if (check.isBalanced) continue;
    diagnostics.push({
      severity: "error",
      code: "prepared-cash-mismatch",
      message: `Imported cash movements do not reconcile for ${check.accountId} in ${check.currency} (${check.expected} expected, ${check.actual} generated).`,
    });
  }
  return {
    drafts,
    legacyTransferDrafts,
    diagnostics,
    controls: parsed.controls,
    matchSuggestions,
    settlementChecks,
  };
}
