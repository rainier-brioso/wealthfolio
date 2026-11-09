import { describe, expect, it } from "vitest";
import type { DraftActivity } from "../context/import-context";
import { hasPartialSourceOperation } from "./source-operation-groups";

const row = (
  status: DraftActivity["status"],
  group = "purchase-1",
  forceImport = false,
): DraftActivity => ({
  rowIndex: 0,
  rawRow: [],
  activityDate: "2026-01-01",
  activityType: "BUY",
  currency: "EUR",
  accountId: "funds",
  status,
  errors: {},
  warnings: {},
  isEdited: false,
  sourceOperationGroup: group,
  forceImport,
});

describe("source operation inclusion", () => {
  it("blocks a duplicate trade with fresh transfer legs", () => {
    expect(hasPartialSourceOperation([row("duplicate"), row("valid"), row("valid")])).toBe(true);
  });
  it("blocks skipping only one leg", () => {
    expect(hasPartialSourceOperation([row("valid"), row("skipped"), row("valid")])).toBe(true);
    expect(hasPartialSourceOperation([row("valid"), row("error"), row("valid")])).toBe(true);
  });
  it("permits an entirely new, duplicate or skipped operation", () => {
    for (const status of ["valid", "duplicate", "skipped"] as const) {
      expect(hasPartialSourceOperation([row(status), row(status), row(status)])).toBe(false);
    }
  });
  it("checks each operation separately", () => {
    expect(hasPartialSourceOperation([row("valid", "one"), row("duplicate", "two")])).toBe(false);
  });
  it("honors an explicit force-import selection while still checking the other legs", () => {
    expect(hasPartialSourceOperation([row("duplicate", "one", true), row("valid", "one")])).toBe(
      false,
    );
    expect(
      hasPartialSourceOperation([row("duplicate", "one", true), row("duplicate", "one")]),
    ).toBe(true);
  });
  it("does not constrain ordinary CSV rows", () => {
    expect(hasPartialSourceOperation([row("valid", ""), row("duplicate", "")])).toBe(false);
  });
});
