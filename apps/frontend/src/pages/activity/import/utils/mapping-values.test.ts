import { describe, expect, it } from "vitest";
import { ImportFormat } from "@/lib/constants";
import { computeFieldMappings } from "../hooks/use-import-mapping";
import { createDefaultActivityMapping } from "./default-activity-template";
import {
  ACTIVITY_SKIP,
  createDraftActivities,
  draftToActivityImport,
  validateDraft,
} from "./draft-utils";
import { getActivityImportProfileForAccountType } from "./activity-import-profile";
import { buildImportAssetCandidateFromDraft } from "./asset-review-utils";
import {
  CALCULATED_UNIT_PRICE,
  FIXED_ACTIVITY_TYPE_PREFIX,
  calculateUnitPrice,
  fixedActivityType,
  importFieldMapped,
  readMappedValue,
} from "./mapping-values";

const config = {
  dateFormat: "auto",
  decimalSeparator: ",",
  thousandsSeparator: ".",
  defaultCurrency: "EUR",
};
const headers = [
  "Fecha de la orden",
  "ISIN",
  "Importe estimado",
  "Nº de participaciones",
  "Estado",
];
const row = ["01/10/2026", "IE000ZYRH0Q7", "100,00", "4,000", "Finalizada"];

describe("normal CSV mapping values", () => {
  it("imports completed fund purchases into the funds account and skips cancelled orders", () => {
    const mapping = {
      ...createDefaultActivityMapping("funds"),
      fieldMappings: { ...computeFieldMappings(headers), activityType: "Estado" },
      activityMappings: { BUY: ["Finalizada"], [ACTIVITY_SKIP]: ["Cancelada"] },
    };
    const drafts = createDraftActivities(
      [
        ["01/10/2026", "IE000ZYRH0Q7", "123.45 EUR", "2,5", "Finalizada"],
        ["02/10/2026", "IE000ZYRH0Q7", "200 EUR", "5", "Cancelada"],
        ["03/10/2026", "IE000ZYRH0Q7", "200 EUR", "5", "Pendiente"],
      ],
      headers,
      mapping,
      { ...config, decimalSeparator: "auto", thousandsSeparator: "auto" },
      "funds",
    );
    expect(drafts).toHaveLength(2);
    expect(draftToActivityImport(drafts[0])).toMatchObject({
      accountId: "funds",
      activityType: "BUY",
      amount: "123.45",
      quantity: "2.5",
      unitPrice: "49.380000000000",
      isin: "IE000ZYRH0Q7",
      isValid: true,
    });
    expect(drafts[1].rowIndex).toBe(2);
    expect(drafts[1].errors.activityType).toBeDefined();
    expect(draftToActivityImport(drafts[1]).isValid).toBe(false);
  });

  it.each([
    { decimalSeparator: "auto", thousandsSeparator: "auto", amount: "123.45 EUR" },
    { decimalSeparator: "auto", thousandsSeparator: ".", amount: "123,45 EUR" },
  ])(
    "keeps calculated prices and ISIN in the import payload with $thousandsSeparator thousands",
    (numeric) => {
      const mapping = {
        ...createDefaultActivityMapping("funds"),
        fieldMappings: {
          ...computeFieldMappings(headers),
          activityType: FIXED_ACTIVITY_TYPE_PREFIX + "BUY",
        },
      };
      const [draft] = createDraftActivities(
        [["01/10/2026", "IE000ZYRH0Q7", numeric.amount, "2,5", "Finalizada"]],
        headers,
        mapping,
        { ...config, ...numeric },
        "funds",
      );
      expect(draft).toMatchObject({
        amount: "123.45",
        quantity: "2.5",
        unitPrice: "49.380000000000",
      });
      expect(draftToActivityImport(draft)).toMatchObject({
        isin: "IE000ZYRH0Q7",
        activityType: "BUY",
        amount: "123.45",
        quantity: "2.5",
        unitPrice: "49.380000000000",
      });
    },
  );

  it("auto-maps Spanish orders and calculates price without a separate importer", () => {
    const fields = computeFieldMappings(headers);
    expect(fields).toMatchObject({
      date: headers[0],
      isin: "ISIN",
      amount: "Importe estimado",
      quantity: headers[3],
      unitPrice: CALCULATED_UNIT_PRICE,
    });
    expect(importFieldMapped(ImportFormat.SYMBOL, fields, headers)).toBe(true);
    const mapping = {
      ...createDefaultActivityMapping("funds"),
      fieldMappings: { ...fields, activityType: FIXED_ACTIVITY_TYPE_PREFIX + "BUY" },
    };
    const [draft] = createDraftActivities([row], headers, mapping, config, "funds");
    expect(draft).toMatchObject({
      activityType: "BUY",
      unitPrice: "25.000000000000",
      quantity: "4.000",
      amount: "100.00",
      currency: "EUR",
      currencySource: "default",
      isin: "IE000ZYRH0Q7",
      status: "valid",
    });
    expect(draft.symbol).toBe("IE000ZYRH0Q7");
    expect(buildImportAssetCandidateFromDraft(draft)).toMatchObject({
      isin: "IE000ZYRH0Q7",
      symbol: "IE000ZYRH0Q7",
    });
    expect(validateDraft(draft).status).toBe("valid");
    expect(draftToActivityImport(draft)).toMatchObject({
      activityType: "BUY",
      unitPrice: "25.000000000000",
      amount: "100.00",
      currency: "",
    });
    expect(
      readMappedValue(
        Object.fromEntries(headers.map((h, i) => [h, row[i]])),
        ImportFormat.UNIT_PRICE,
        mapping.fieldMappings,
        config,
      ),
    ).toBe("25,000000000000");
  });

  it("requires a deliberate type choice and does not infer BUY from an unsigned amount", () => {
    const mapping = {
      ...createDefaultActivityMapping("funds"),
      fieldMappings: computeFieldMappings(headers),
    };
    const [draft] = createDraftActivities([row], headers, mapping, config, "funds");
    expect(draft.errors.activityType).toBeDefined();
    expect(fixedActivityType(FIXED_ACTIVITY_TYPE_PREFIX + "UNKNOWN")).toBeUndefined();
  });

  it("preserves fixed choices in saved templates and does not replace a supplied price", () => {
    const saved = {
      activityType: FIXED_ACTIVITY_TYPE_PREFIX + "SELL",
      unitPrice: CALCULATED_UNIT_PRICE,
    };
    expect(computeFieldMappings(headers, saved)).toMatchObject(saved);
    expect(computeFieldMappings([...headers, "unitPrice"]).unitPrice).toBe("unitPrice");
    const fields = computeFieldMappings([...headers, "unitPrice"]);
    fields.activityType = FIXED_ACTIVITY_TYPE_PREFIX + "SELL";
    const [draft] = createDraftActivities(
      [[...row, "26,50"]],
      [...headers, "unitPrice"],
      { ...createDefaultActivityMapping("funds"), fieldMappings: fields },
      config,
      "funds",
    );
    expect(draft.activityType).toBe("SELL");
    expect(draft.unitPrice).toBe("26.50");
  });

  it("keeps the cash-account import profile and the normal concept mapping", () => {
    const cashHeaders = ["Fecha de operación", "Fecha de valor", "Concepto", "Importe", "Divisa"];
    const profile = getActivityImportProfileForAccountType("CASH");
    const mapping = {
      ...createDefaultActivityMapping("cash", profile),
      fieldMappings: computeFieldMappings(cashHeaders, {}, profile),
      activityMappings: { INTEREST: ["Intereses"] },
    };
    expect(mapping.fieldMappings.unitPrice).toBeUndefined();
    const [draft] = createDraftActivities(
      [["01/10/2026", "02/10/2026", "Intereses", "1,25", "EUR"]],
      cashHeaders,
      mapping,
      config,
      "cash",
      undefined,
      new Map([["cash", "CASH"]]),
      { importProfile: profile },
    );
    expect(draft).toMatchObject({
      activityType: "INTEREST",
      amount: "1.25",
      currency: "EUR",
      comment: "Intereses",
      status: "valid",
    });
  });

  it("leaves cancelled or invalid rows for existing exclusion and validation", () => {
    const mapping = {
      ...createDefaultActivityMapping("funds"),
      fieldMappings: {
        ...computeFieldMappings(headers),
        activityType: FIXED_ACTIVITY_TYPE_PREFIX + "BUY",
      },
    };
    const cancelled = [...row];
    cancelled[2] = "0";
    cancelled[3] = "0";
    cancelled[4] = "Cancelada";
    const drafts = createDraftActivities([row, cancelled], headers, mapping, config, "funds");
    expect(drafts[1].errors.unitPrice).toBeDefined();
    expect(
      createDraftActivities(
        [row, cancelled],
        headers,
        mapping,
        config,
        "funds",
        undefined,
        undefined,
        { skippedRowIndexes: [1] },
      ),
    ).toHaveLength(1);
  });

  it("rounds decimal division deterministically and rejects missing or zero operands", () => {
    expect(calculateUnitPrice("0.3", "0.1")).toBe("3.000000000000");
    expect(calculateUnitPrice("1", "3")).toBe("0.333333333333");
    expect(calculateUnitPrice("2", "3")).toBe("0.666666666667");
    expect(calculateUnitPrice("1e2", "4")).toBe("25.000000000000");
    for (const quantity of [undefined, "0", "invalid", "1e100"])
      expect(calculateUnitPrice("100", quantity)).toBeUndefined();
  });
});
