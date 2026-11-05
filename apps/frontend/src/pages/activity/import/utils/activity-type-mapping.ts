import { ActivityType } from "@/lib/constants";

export const LEGACY_ACTIVITY_MAPPING_PREFIX_LENGTH = 12;

export function normalizeActivityLabel(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
}

function isLegacyActivityLabelMatch(
  normalizedCsvValue: string,
  normalizedMappedValue: string,
): boolean {
  return (
    normalizedMappedValue.length === LEGACY_ACTIVITY_MAPPING_PREFIX_LENGTH &&
    normalizedCsvValue.length > LEGACY_ACTIVITY_MAPPING_PREFIX_LENGTH &&
    normalizedCsvValue.startsWith(normalizedMappedValue) &&
    !normalizedMappedValue.endsWith("_") &&
    normalizedCsvValue[LEGACY_ACTIVITY_MAPPING_PREFIX_LENGTH] !== "_"
  );
}

/**
 * Find the best activity type match for a CSV value.
 * Explicit user/template mappings take precedence over inferred interest periods.
 * A narrow legacy fallback keeps old 12-character truncated mappings working
 * without reintroducing broad prefix collisions like TRANSFER_OUT vs TRANSFER_OUT_FEE.
 */
export function findMappedActivityType(
  csvValue: string,
  activityMappings: Record<string, string[]>,
): ActivityType | null {
  const normalized = normalizeActivityLabel(csvValue);
  let legacyMatch: ActivityType | null = null;

  for (const [activityType, csvValues] of Object.entries(activityMappings)) {
    for (const value of csvValues ?? []) {
      const normalizedValue = normalizeActivityLabel(value);

      if (normalized === normalizedValue) {
        return activityType as ActivityType;
      }

      if (isLegacyActivityLabelMatch(normalized, normalizedValue)) {
        if (legacyMatch && legacyMatch !== activityType) {
          return null;
        }
        legacyMatch = activityType as ActivityType;
      }
    }
  }

  if (legacyMatch) return legacyMatch;

  // MyInvestor account interest descriptions contain a changing settlement period.
  // Match the entire description so fees or withholding mentioning a period stay unresolved.
  if (/^PERIODO_\d{2}\/\d{2}\/\d{4}_\d{2}\/\d{2}\/\d{4}$/.test(normalized)) {
    return ActivityType.INTEREST;
  }

  return null;
}
