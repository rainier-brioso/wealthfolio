import { ActivityType, ImportFormat } from "@/lib/constants";
import { parseNumericValue } from "./review-draft-utils";

// Stored in the existing fieldMappings JSON, alongside ordinary column names.
export const FIXED_ACTIVITY_TYPE_PREFIX = "__fixed_activity_type:";
export const CALCULATED_UNIT_PRICE = "__unit_price_from_amount_quantity__";

export function fixedActivityType(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string" || !value.startsWith(FIXED_ACTIVITY_TYPE_PREFIX)) return;
  const type = value.slice(FIXED_ACTIVITY_TYPE_PREFIX.length);
  return Object.values(ActivityType).some(
    (candidate) => candidate === type && candidate !== ActivityType.UNKNOWN,
  )
    ? type
    : undefined;
}

export function isCalculatedMapping(value: string | string[] | undefined): boolean {
  return value === CALCULATED_UNIT_PRICE || !!fixedActivityType(value);
}

export function importFieldMapped(
  field: ImportFormat,
  mappings: Record<string, string | string[]>,
  headers: string[],
): boolean {
  const present = (value: string | string[] | undefined) =>
    typeof value === "string"
      ? headers.includes(value) || isCalculatedMapping(value)
      : (value?.some((header) => headers.includes(header)) ?? false);
  return (
    present(mappings[field]) ||
    (field === ImportFormat.SYMBOL && present(mappings[ImportFormat.ISIN]))
  );
}

interface NumericConfig {
  decimalSeparator: string;
  thousandsSeparator: string;
}

/** Integer arithmetic avoids binary floating point drift; round to 12 decimals. */
export function calculateUnitPrice(
  amount: string | undefined,
  quantity: string | undefined,
): string | undefined {
  const scaled = (value: string | undefined) => {
    const match = value?.match(/^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
    if (!match) return;
    const exponent = Number(match[3] ?? 0);
    if (Math.abs(exponent) > 28 || (match[2]?.length ?? 0) > 28) return;
    const decimals = (match[2]?.length ?? 0) - exponent;
    return {
      units: BigInt(match[1] + (match[2] ?? "")) * 10n ** BigInt(Math.max(0, -decimals)),
      scale: 10n ** BigInt(Math.max(0, decimals)),
    };
  };
  const a = scaled(amount),
    q = scaled(quantity);
  if (!a || !q || a.units <= 0n || q.units <= 0n) return;
  const precision = 10n ** 12n;
  const denominator = a.scale * q.units;
  const rounded = (a.units * q.scale * precision + denominator / 2n) / denominator;
  if (rounded === 0n) return;
  return `${rounded / precision}.${(rounded % precision).toString().padStart(12, "0")}`;
}

export function readMappedValue(
  row: Record<string, string>,
  field: ImportFormat,
  mappings: Record<string, string | string[]>,
  config: NumericConfig,
): string {
  const raw = (key: ImportFormat) => {
    const value = mappings[key];
    if (Array.isArray(value)) return value.map((header) => row[header]?.trim()).find(Boolean) ?? "";
    return value ? (row[value] ?? "") : "";
  };
  if (field === ImportFormat.ACTIVITY_TYPE) return fixedActivityType(mappings[field]) ?? raw(field);
  if (field === ImportFormat.UNIT_PRICE && mappings[field] === CALCULATED_UNIT_PRICE) {
    const parse = (key: ImportFormat) =>
      parseNumericValue(raw(key), config.decimalSeparator, config.thousandsSeparator);
    const price = calculateUnitPrice(parse(ImportFormat.AMOUNT), parse(ImportFormat.QUANTITY));
    // The preview and draft parser read this value using the source separators again.
    // With automatic decimals and explicit dot grouping, a dot would be stripped.
    const usesComma =
      config.decimalSeparator === "," ||
      (config.decimalSeparator === "auto" && config.thousandsSeparator === ".");
    return usesComma ? (price?.replace(".", ",") ?? "") : (price ?? "");
  }
  return raw(field);
}
