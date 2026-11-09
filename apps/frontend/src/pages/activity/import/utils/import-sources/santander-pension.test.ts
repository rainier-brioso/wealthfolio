import { describe, expect, it } from "vitest";
import { parseSantanderPension, prepareSantanderPension } from "./santander-pension";
import type { PensionPdfPage } from "./santander-pension-pdf";
import { draftToActivityImport } from "../draft-utils";
import { hasPartialSourceOperation } from "../source-operation-groups";

export function statementFixture(): PensionPdfPage {
  return {
    header:
      "Santander Pensiones EXTRACTO DE MOVIMIENTOS FONDO 212 FONDO EJEMPLO PLAN 001 PP EJEMPLO IDENTIFICACION",
    summary: `DATOS ECONOMICOS AL 31.03.2026
Derecho consolidado al inicio del periodo 0,00
Total operaciones de Entrada en el periodo 2.540,57
Total operaciones de Salida en el periodo 0,00
Revalorización del Periodo -73,82
Derecho consolidado al final del periodo 2.466,75
Unidades de Cuenta Totales 1.453,87943
Valor Unidad de Cuenta al final del periodo 1,69667`,
    rows: [
      ["", "", "SALDO ANTERIOR", "0,00", "0,00000", "1,72250"],
      ["01.01.2026", "27.01.2026", "AP. PROMOTOR SERV. CORRIENTES", "83,34", "47,93140", "1,73873"],
      [
        "10.02.2026",
        "10.02.2026",
        "INGR.TRASPASO NO DETERMINADO",
        "1.921,98",
        "1.098,61390",
        "1,74946",
      ],
      ["11.02.2026", "11.02.2026", "INGRESO POR TRASPASO", "368,57", "210,61793", "1,74995"],
      ["01.02.2026", "27.02.2026", "AP. PROMOTOR SERV. CORRIENTES", "83,34", "47,38354", "1,75884"],
      ["01.03.2026", "27.03.2026", "AP. PROMOTOR SERV. CORRIENTES", "83,34", "49,33266", "1,68935"],
      ["99.99.9999", "", "", "250,02", "1.453,87943", "1,69667"],
    ].map(([operationDate, valueDate, concept, amount, units, price]) => ({
      operationDate,
      valueDate,
      concept,
      amount,
      units,
      price,
    })),
  };
}
describe("Santander pension statements", () => {
  function roundedClosingFixture(): PensionPdfPage {
    const page = statementFixture();
    page.summary = `DATOS ECONOMICOS AL 31.03.2026
Derecho consolidado al inicio del periodo 0,00
Total operaciones de Entrada en el periodo 2.500,01
Total operaciones de Salida en el periodo 0,00
Revalorización del Periodo 0,00
Derecho consolidado al final del periodo 2.500,01
Unidades de Cuenta Totales 2.500,00000
Valor Unidad de Cuenta al final del periodo 1,00001`;
    page.rows = [
      page.rows[0],
      {
        operationDate: "01.03.2026",
        valueDate: "27.03.2026",
        concept: "AP. PROMOTOR SERV. CORRIENTES",
        amount: "2.500,01",
        units: "2.500,00000",
        price: "1,00000",
      },
    ];
    return page;
  }

  it("accepts closing differences explained by the precision printed in the statement", () => {
    const result = parseSantanderPension(roundedClosingFixture(), "pension");
    expect(result).toMatchObject({
      closingUnits: "2500.00000",
      closingPrice: "1.00001",
      closingValue: "2500.01",
    });
    expect(result.drafts[1]).toMatchObject({
      amount: "2500.01",
      quantity: "2500.00000",
      unitPrice: "1.00000",
    });
  });

  it("rejects closing differences beyond the printed rounding precision", () => {
    const page = roundedClosingFixture();
    page.summary = page.summary
      .replace("Revalorización del Periodo 0,00", "Revalorización del Periodo -0,01")
      .replace("final del periodo 2.500,01", "final del periodo 2.500,00");
    expect(() => parseSantanderPension(page, "pension")).toThrow("closing-valuation-mismatch");
  });

  it.each([
    "APORTACIÓN ADICIONAL",
    "AP. COMPLEMENTARIA PROMOTOR",
    "AP. VOL. RECAUDADAS POR NÓMINA",
  ])("imports %s as a contribution within the pension account", (concept) => {
    const page = statementFixture();
    page.rows[1].concept = concept;
    const result = parseSantanderPension(page, "pension");
    expect(result.drafts.slice(0, 2).map((row) => row.activityType)).toEqual(["DEPOSIT", "BUY"]);
    expect(result.drafts.slice(0, 2).every((row) => row.accountId === "pension")).toBe(true);
  });

  it("reconstructs the five operations and closing position without touching a bank account", () => {
    const result = prepareSantanderPension([parseSantanderPension(statementFixture(), "pension")]);
    expect(result.drafts).toHaveLength(8);
    expect(new Set(result.drafts.map((row) => row.accountId))).toEqual(new Set(["pension"]));
    expect(result.drafts.filter((row) => row.activityType === "DEPOSIT")).toHaveLength(3);
    expect(result.drafts.filter((row) => row.activityType === "TRANSFER_IN")).toHaveLength(2);
    expect(
      result.drafts
        .filter((row) => row.quantity)
        .reduce((sum, row) => sum + Math.round(Number(row.quantity) * 1e5), 0),
    ).toBe(145387943);
    const cash = result.drafts.reduce(
      (sum, row) =>
        sum +
        (row.activityType === "DEPOSIT" ? 1 : row.activityType === "BUY" ? -1 : 0) *
          Math.round(Number(row.amount) * 100),
      0,
    );
    expect(cash).toBe(0);
    expect(result.statements[0]).toMatchObject({
      closingDate: "2026-03-31",
      closingPrice: "1.69667",
      closingValue: "2466.75",
    });
    expect(result.drafts[0].activityDate).toBe("2026-01-27");
    expect(result.drafts[0].comment).toContain("2026-01-01|2026-01-27");
    expect(
      result.drafts
        .filter((row) => row.activityType === "TRANSFER_IN")
        .map(draftToActivityImport)
        .every((row) => row.isExternal),
    ).toBe(true);
    expect(
      hasPartialSourceOperation([
        { ...result.drafts[0], status: "skipped" },
        ...result.drafts.slice(1),
      ]),
    ).toBe(true);
    expect(parseSantanderPension(statementFixture(), "pension").drafts).toEqual(
      result.drafts.map((row) => ({ ...row, rowIndex: 0 })),
    );
  });
  it.each(["amount", "units", "price", "valueDate", "concept"] as const)(
    "rejects misread %s",
    (field) => {
      const page = statementFixture();
      page.rows[1][field] = field === "concept" ? "UNKNOWN" : "123";
      expect(() => parseSantanderPension(page, "pension")).toThrow();
    },
  );
  it("rejects a missing operation even when other rows are readable", () => {
    const page = statementFixture();
    page.rows.splice(2, 1);
    expect(() => parseSantanderPension(page, "pension")).toThrow("movement-units-mismatch");
  });
  it("rejects invalid dates and unsupported withdrawals", () => {
    const page = statementFixture();
    page.rows[1].valueDate = "31.02.2026";
    expect(() => parseSantanderPension(page, "pension")).toThrow("invalid-date");
    page.rows[1].valueDate = "27.01.2026";
    page.summary = page.summary.replace("Salida en el periodo 0,00", "Salida en el periodo 1,00");
    expect(() => parseSantanderPension(page, "pension")).toThrow("unsupported-exit");
  });
  it("imports a standalone statement with opening holdings without inventing opening activities", () => {
    const page = statementFixture();
    page.summary = page.summary
      .replace("inicio del periodo 0,00", "inicio del periodo 172,25")
      .replace("-73,82", "-76,40")
      .replace("2.466,75", "2.636,42")
      .replace("1.453,87943", "1.553,87943");
    page.rows[0] = { ...page.rows[0], amount: "172,25", units: "100,00000" };
    page.rows[page.rows.length - 1].units = "1.553,87943";
    const parsed = parseSantanderPension(page, "pension");
    const result = prepareSantanderPension([parsed]);
    expect(result.statements[0].openingUnits).toBe("100.00000");
    expect(result.drafts).toHaveLength(8);
    expect(result.drafts).toEqual(parsed.drafts.map((draft, rowIndex) => ({ ...draft, rowIndex })));
  });

  it("leaves repeated statements for the normal activity duplicate review", () => {
    const parsed = parseSantanderPension(statementFixture(), "pension");
    const result = prepareSantanderPension([parsed, parsed]);
    expect(result.drafts).toHaveLength(16);
    expect(result.drafts.slice(8).map((draft) => draft.comment)).toEqual(
      result.drafts.slice(0, 8).map((draft) => draft.comment),
    );
    expect(new Set(result.drafts.map((draft) => draft.rowIndex)).size).toBe(16);
  });

  it("prepares independent periods without requiring continuity with other selected files", () => {
    const parsed = parseSantanderPension(statementFixture(), "pension");
    const later = { ...parsed, closingDate: "2026-09-30", openingUnits: "2000.00000" };
    const result = prepareSantanderPension([later, parsed]);
    expect(result.statements.map((statement) => statement.closingDate)).toEqual([
      "2026-03-31",
      "2026-09-30",
    ]);
    expect(result.drafts).toHaveLength(16);
  });
});
