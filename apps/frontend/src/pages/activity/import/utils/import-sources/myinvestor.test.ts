import { describe, expect, it } from "vitest";
import { sourceReconciliationSchema } from "@/lib/source-reconciliation";
import { draftToActivityImport } from "../draft-utils";
import {
  matchMyInvestorOperations,
  parseMyInvestorFiles,
  prepareMyInvestorImport,
} from "./myinvestor";

const cashHtml = `<!doctype html><html><body><table>
<tr><th>Fecha operación</th><th>FECHA VALOR</th><th>Tipo de operación</th><th>Concepto</th><th>C/A</th><th>Cargo/Abono Importe</th><th>Saldo</th></tr>
<tr><td>01/01/2026</td><td>Saldo Inicio</td><td>100,00</td></tr>
<tr><td>02/01/2026</td><td>02/01/2026</td><td>SUSCRIPCION IIC</td><td>Fund One</td><td>C</td><td>-50,00</td><td>50,00</td></tr>
<tr><td>03/01/2026</td><td>03/01/2026</td><td>LIQUIDAC. INTERESES</td><td>PERIODO 02/12/2025 02/01/2026</td><td>A</td><td>0,04</td><td>50,04</td></tr>
<tr><td>04/01/2026</td><td>Saldo Final</td><td>50,04</td></tr>
</table></body></html>`;

const fundOperationsHtml = `<!doctype html><html><body><table>
<tr><th>Fechas</th><th>Operación</th><th>Mercado</th><th>Operación</th><th>ISIN</th><th>Valor</th><th>Títulos/NOMINAL</th><th>Divisa</th><th>Precio Neto</th><th>Importe neto</th></tr>
<tr><th>Operación</th><th>Liquidación</th></tr>
<tr><td>2026-01-02</td><td>2026-01-02</td><td>OP-1</td><td>FONDOS EXTRANJEROS</td><td>SUSCRIPCION</td><td>IE0000000001</td><td>Fund One</td><td>2</td><td>EUR</td><td>25.00</td><td>50.00</td></tr>
</table></body></html>`;

const stockCashHtml = `<!doctype html><html><body><table>
<tr><th>Fecha operación</th><th>FECHA VALOR</th><th>Tipo de operación</th><th>Concepto</th><th>C/A</th><th>Cargo/Abono Importe</th><th>Saldo</th></tr>
<tr><td>01/01/2026</td><td>Saldo Inicio</td><td>1000,00</td></tr>
<tr><td>02/01/2026</td><td>02/01/2026</td><td>COMPRA RV CONTADO</td><td>Example Corp</td><td>C</td><td>-92,00</td><td>908,00</td></tr>
<tr><td>03/01/2026</td><td>Saldo Final</td><td>908,00</td></tr>
</table></body></html>`;

const stockOperationsHtml = `<!doctype html><html><body><table>
<tr><th>Fechas</th><th>Operación</th><th>Mercado</th><th>Operación</th><th>ISIN</th><th>Valor</th><th>Títulos/NOMINAL</th><th>Divisa</th><th>Precio Neto</th><th>Importe neto</th></tr>
<tr><th>Operación</th><th>Liquidación</th></tr>
<tr><td>2026-01-02</td><td>2026-01-02</td><td>OP-2</td><td>NASDAQ</td><td>COMPRA</td><td>US0000000001</td><td>Example Corp</td><td>1</td><td>USD</td><td>100.00</td><td>100.00</td></tr>
</table></body></html>`;

describe("MyInvestor Inversis HTML source parser", () => {
  it.each([
    ["2026-01-03", "cash", "BUY"],
    ["2026-01-01", "cash", "BUY"],
    ["2026-01-03", undefined, "BUY"],
    ["2026-01-03", "cash", "SELL"],
    ["2026-01-01", "cash", "SELL"],
  ])(
    "books the trade with its matched cash movement on %s (cash account: %s, type: %s)",
    (date, cashAccountId, activityType) => {
      const parsed = parseMyInvestorFiles([
        { name: "movimientos.xls", content: cashHtml },
        { name: "operaciones valores.xls", content: fundOperationsHtml },
      ]);
      parsed.movements[0].date = date;
      parsed.securities[0].settlementDate = "2026-01-04";
      if (activityType === "SELL") {
        parsed.securities[0].activityType = "SELL";
        parsed.securities[0].operation = "REEMBOLSO";
        parsed.movements[0].operation = "REEMBOLSO IIC";
        parsed.movements[0].amount = "50";
      }
      const result = prepareMyInvestorImport(parsed, {
        fundsAccountId: "funds",
        cashAccountId,
        matches: { [parsed.securities[0].source.rowKey]: parsed.movements[0].source.rowKey },
      });
      const buy = result.drafts.find((draft) => draft.activityType === activityType)!;
      expect(buy.activityDate).toBe(date);
      expect(buy.comment).toContain("Trade: 2026-01-02; Settlement: 2026-01-04");
      expect(buy).toMatchObject({ quantity: "2", unitPrice: "25", amount: "50" });
      expect(result.settlementChecks.every(({ isBalanced }) => isBalanced)).toBe(true);
      if (cashAccountId) {
        const dailyFundCash = new Map<string, number>();
        for (const draft of result.drafts.filter(({ accountId }) => accountId === "funds")) {
          const sign = ["TRANSFER_IN", "SELL"].includes(draft.activityType) ? 1 : -1;
          dailyFundCash.set(
            draft.activityDate,
            (dailyFundCash.get(draft.activityDate) ?? 0) + sign * Number(draft.amount),
          );
        }
        expect([...dailyFundCash.values()]).toEqual([0]);
      }
    },
  );

  it.each([
    ["24.9975", false],
    ["24.997", true],
    ["24.998", false],
    ["20.00", true],
  ])("previews net amount review at half a minor unit (%s)", (price, needsReview) => {
    const parsed = parseMyInvestorFiles([
      { name: "movimientos.xls", content: cashHtml },
      { name: "operaciones valores.xls", content: fundOperationsHtml.replace("25.00", price) },
    ]);
    const result = prepareMyInvestorImport(parsed, {
      fundsAccountId: "funds",
      matches: { [parsed.securities[0].source.rowKey]: parsed.movements[0].source.rowKey },
    });
    expect(result.diagnostics.some(({ code }) => code === "trade-total-review")).toBe(needsReview);
    expect(result.drafts.find(({ activityType }) => activityType === "BUY")).toMatchObject({
      quantity: "2",
      unitPrice: price.replace(/\.00$/, ""),
      amount: "50",
    });
    expect(result.settlementChecks.every(({ isBalanced }) => isBalanced)).toBe(true);
    const buy = result.drafts.find(({ activityType }) => activityType === "BUY")!;
    if (needsReview) {
      expect(sourceReconciliationSchema.safeParse(buy.sourceReconciliation).success).toBe(true);
      expect(buy.sourceReconciliation).toMatchObject({
        quantity: "2",
        unitPrice: price.replace(/\.00$/, ""),
        sourceAmount: "50",
        settledAmount: "50",
      });
      const edited = { ...buy, unitPrice: "25", amount: "50" };
      expect(draftToActivityImport(edited).sourceReconciliation).toEqual(buy.sourceReconciliation);
    } else {
      expect(buy.sourceReconciliation).toBeUndefined();
    }
  });
  it("ranks settlement/value evidence ahead of fallback dates and unrelated source order", () => {
    const parsed = parseMyInvestorFiles([
      { name: "movimientos.xls", content: cashHtml },
      { name: "operaciones valores.xls", content: fundOperationsHtml },
    ]);
    const primary = {
      ...parsed.movements[0],
      source: { ...parsed.movements[0].source, rowKey: "z-primary" },
    };
    const fallback = {
      ...primary,
      source: { ...primary.source, rowKey: "a-fallback" },
      valueDate: "2026-01-20",
    };
    const unrelated = {
      ...primary,
      source: { ...primary.source, rowKey: "b-unrelated" },
      date: "2025-01-01",
      valueDate: "2025-01-01",
    };
    const result = matchMyInvestorOperations({
      ...parsed,
      movements: [unrelated, fallback, primary],
    });
    expect(result.suggestions[0].candidates.map((candidate) => candidate.movement.rowKey)).toEqual([
      "z-primary",
      "a-fallback",
      "b-unrelated",
    ]);
    expect(result.matches[parsed.securities[0].source.rowKey]).toBe("z-primary");
  });
  it("auto-matches only reciprocal strong evidence and proposes weaker exact identity/date matches", () => {
    const parsed = parseMyInvestorFiles([
      { name: "movimientos.xls", content: cashHtml },
      { name: "operaciones valores.xls", content: fundOperationsHtml },
    ]);
    const security = parsed.securities[0];
    const purchaseMovement = parsed.movements[0];
    const unrelatedEligibleMovement = {
      ...purchaseMovement,
      source: { ...purchaseMovement.source, rowKey: "decoy-cash-row" },
      concept: "Fund One",
      amount: "-70",
    };
    const withDecoy = {
      ...parsed,
      movements: [...parsed.movements, unrelatedEligibleMovement],
    };
    const strong = matchMyInvestorOperations(withDecoy);
    expect(strong.matches[security.source.rowKey]).toBe(purchaseMovement.source.rowKey);

    const weaker = {
      ...parsed,
      movements: parsed.movements.map((movement) =>
        movement === purchaseMovement
          ? { ...movement, amount: "-51", concept: "Fund One @ ISIN IE0000000001" }
          : movement,
      ),
    };
    const proposed = matchMyInvestorOperations(weaker);
    expect(proposed.matches[security.source.rowKey]).toBeUndefined();
    expect(proposed.proposals[security.source.rowKey]).toBe(purchaseMovement.source.rowKey);

    const crossCurrency = parseMyInvestorFiles([
      { name: "movimientos.xls", content: stockCashHtml },
      { name: "operaciones valores.xls", content: stockOperationsHtml },
    ]);
    const crossCurrencyResult = matchMyInvestorOperations(crossCurrency);
    expect(crossCurrencyResult.matches).toEqual({});
    expect(crossCurrencyResult.proposals[crossCurrency.securities[0].source.rowKey]).toBe(
      crossCurrency.movements[0].source.rowKey,
    );

    const repeatedMovement = {
      ...purchaseMovement,
      source: { ...purchaseMovement.source, rowKey: "repeated-fund-cash-row" },
      amount: "-49",
    };
    const repeatedResult = matchMyInvestorOperations({
      ...weaker,
      movements: [...weaker.movements, repeatedMovement],
    });
    expect(repeatedResult.proposals[security.source.rowKey]).toBeUndefined();

    const prefixOnly = {
      ...parsed,
      movements: parsed.movements.map((movement) =>
        movement === purchaseMovement ? { ...movement, concept: "Fund One Plus" } : movement,
      ),
    };
    expect(matchMyInvestorOperations(prefixOnly).proposals[security.source.rowKey]).toBeUndefined();
  });

  it("filters operation direction before calculating strong-match and proposal uniqueness", () => {
    const parsed = parseMyInvestorFiles([
      { name: "movimientos.xls", content: cashHtml },
      { name: "operaciones valores.xls", content: fundOperationsHtml },
    ]);
    const security = parsed.securities[0];
    const purchase = parsed.movements[0];
    const validButDifferentAmount = { ...purchase, amount: "-51" };
    const invalidCredit = {
      ...purchase,
      source: { ...purchase.source, rowKey: "credit-row" },
      amount: "50",
    };
    const result = matchMyInvestorOperations({
      ...parsed,
      movements: [validButDifferentAmount, invalidCredit],
    });
    expect(result.matches[security.source.rowKey]).toBeUndefined();
    expect(result.proposals[security.source.rowKey]).toBe(validButDifferentAmount.source.rowKey);
    expect(result.suggestions[0]?.candidates.map(({ movement }) => movement.rowKey)).toEqual([
      validButDifferentAmount.source.rowKey,
    ]);
  });

  it("uses settlement/value dates for automation and limits trade-date matches to proposals", () => {
    const parsed = parseMyInvestorFiles([
      { name: "movimientos.xls", content: cashHtml },
      { name: "operaciones valores.xls", content: fundOperationsHtml },
    ]);
    const security = parsed.securities[0];
    const movement = parsed.movements[0];
    const tradeOnly = {
      ...parsed,
      securities: [{ ...security, settlementDate: "2026-01-05" }],
      movements: [{ ...movement, valueDate: "2026-01-03" }],
    };
    const fallback = matchMyInvestorOperations(tradeOnly);
    expect(fallback.matches[security.source.rowKey]).toBeUndefined();
    expect(fallback.proposals[security.source.rowKey]).toBe(movement.source.rowKey);

    const unrelatedDate = {
      ...parsed,
      securities: [{ ...security, tradeDate: "2026-01-06", settlementDate: "2026-01-07" }],
      movements: [{ ...movement, date: "2026-01-07", valueDate: "2026-01-08" }],
    };
    expect(matchMyInvestorOperations(unrelatedDate).matches).toEqual({});
    expect(matchMyInvestorOperations(unrelatedDate).proposals).toEqual({});
  });

  it("proposes conservative name similarities and rejects generic or share-class conflicts", () => {
    const parsed = parseMyInvestorFiles([
      { name: "movimientos.xls", content: cashHtml },
      { name: "operaciones valores.xls", content: fundOperationsHtml },
    ]);
    const security = parsed.securities[0];
    const movement = parsed.movements[0];
    const similar = {
      ...parsed,
      securities: [{ ...security, name: "Global Equity Index Fund" }],
      movements: [{ ...movement, concept: "Global Equity Fund @ instrument" }],
    };
    const fuzzy = matchMyInvestorOperations(similar);
    expect(fuzzy.matches).toEqual({});
    expect(fuzzy.proposals[security.source.rowKey]).toBe(movement.source.rowKey);
    expect(fuzzy.suggestions[0].candidates[0].evidence).toMatchObject({
      nameMatch: "similar",
      dateRelation: "settlement-value",
    });

    const conflicts = [
      ["Global Equity Fund ACC EUR", "Global Equity Fund DIST EUR"],
      ["Global Equity Fund CLASS A", "Global Equity Fund CLASS B"],
      ["Global Equity Fund EUR", "Global Equity Fund USD"],
      ["Global Equity Fund HEDGED", "Global Equity Fund UNHEDGED"],
      ["Global Index Fund EUR", "Index Fund EUR"],
    ];
    for (const [name, concept] of conflicts) {
      const conflict = {
        ...parsed,
        securities: [{ ...security, name }],
        movements: [{ ...movement, concept }],
      };
      expect(matchMyInvestorOperations(conflict).proposals).toEqual({});
    }
  });

  it("does not match a fund subscription to a same-name stock cash debit", () => {
    const parsed = parseMyInvestorFiles([
      { name: "movimientos.xls", content: cashHtml },
      { name: "operaciones valores.xls", content: fundOperationsHtml },
    ]);
    const subscription = parsed.securities[0];
    const sameNameStockDebit = {
      ...parsed.movements[0],
      operation: "COMPRA RV CONTADO SF",
    };
    const unrelated = {
      ...parsed,
      movements: [sameNameStockDebit],
    };
    const result = matchMyInvestorOperations(unrelated);
    expect(result.suggestions[0].candidates).toEqual([]);
    expect(result.matches[subscription.source.rowKey]).toBeUndefined();
    expect(result.proposals[subscription.source.rowKey]).toBeUndefined();
  });

  it("respects value dates, manual conflicts, cleared rows, ambiguity, and input order", () => {
    const parsed = parseMyInvestorFiles([
      { name: "movimientos.xls", content: cashHtml },
      { name: "operaciones valores.xls", content: fundOperationsHtml },
    ]);
    const security = parsed.securities[0];
    const purchaseMovement = parsed.movements[0];
    const valueDateOnly = {
      ...parsed,
      movements: parsed.movements.map((movement) =>
        movement === purchaseMovement
          ? { ...movement, date: "2026-01-04", valueDate: security.settlementDate }
          : movement,
      ),
    };
    expect(matchMyInvestorOperations(valueDateOnly).matches[security.source.rowKey]).toBe(
      purchaseMovement.source.rowKey,
    );

    const blocked = matchMyInvestorOperations(parsed, { [security.source.rowKey]: "" });
    expect(blocked.matches[security.source.rowKey]).toBeUndefined();
    expect(blocked.proposals[security.source.rowKey]).toBeUndefined();
    expect(blocked.suggestions).toHaveLength(parsed.securities.length);

    const reserved = matchMyInvestorOperations(parsed, {
      "other-security-key": purchaseMovement.source.rowKey,
    });
    expect(reserved.matches[security.source.rowKey]).toBeUndefined();

    const duplicateSecurity = {
      ...security,
      source: { ...security.source, rowKey: "duplicate-security-row" },
    };
    const ambiguous = matchMyInvestorOperations({
      ...parsed,
      securities: [...parsed.securities, duplicateSecurity],
    });
    expect(ambiguous.matches[security.source.rowKey]).toBeUndefined();
    expect(ambiguous.proposals[security.source.rowKey]).toBeUndefined();

    const original = matchMyInvestorOperations(parsed);
    const reordered = matchMyInvestorOperations({
      ...parsed,
      securities: [...parsed.securities].reverse(),
      movements: [...parsed.movements].reverse(),
    });
    expect(reordered.matches).toEqual(original.matches);
    expect(reordered.proposals).toEqual(original.proposals);
  });

  it("keeps repeated cash entries distinct with stable comments across renamed exports", () => {
    const row =
      "<tr><td>02/01/2026</td><td>02/01/2026</td><td>LIQUIDAC. INTERESES</td><td>Interest</td><td>EUR</td><td>0,25</td></tr>";
    const content =
      "<table><tr><th>Fecha operación</th><th>Fecha valor</th><th>Tipo de operación</th><th>Concepto</th><th>Divisa</th><th>Importe</th></tr>" +
      row +
      row +
      "</table>";
    const prepare = (name: string) =>
      prepareMyInvestorImport(parseMyInvestorFiles([{ name, content }]), {
        fundsAccountId: "funds",
      }).drafts;
    const first = prepare("first.xls");
    expect(first).toHaveLength(2);
    expect(first[0].comment).not.toBe(first[1].comment);
    expect(prepare("renamed.xls").map((draft) => draft.comment)).toEqual(
      first.map((draft) => draft.comment),
    );
  });
  it("decodes movement and securities tables, controls, dates, and strict locale numbers", () => {
    const parsed = parseMyInvestorFiles([
      { name: "movimientos.xls", content: cashHtml },
      { name: "operaciones valores.xls", content: fundOperationsHtml },
    ]);
    expect(parsed.movements).toHaveLength(2);
    expect(parsed.securities).toMatchObject([
      {
        tradeDate: "2026-01-02",
        settlementDate: "2026-01-02",
        isin: "IE0000000001",
        quantity: "2",
        currency: "EUR",
        unitPrice: "25",
        amount: "50",
        activityType: "BUY",
      },
    ]);
    expect(parsed.controls).toMatchObject([
      { kind: "opening", date: "2026-01-01", amount: "100", currency: "EUR" },
      { kind: "closing", date: "2026-01-04", amount: "50.04", currency: "EUR" },
    ]);
    expect(parsed.diagnostics).toEqual([]);
  });

  it("keeps opening/closing controls out of activities and checks the running balance", () => {
    const parsed = parseMyInvestorFiles([
      { name: "movimientos.xls", content: cashHtml },
      { name: "operaciones valores.xls", content: fundOperationsHtml },
    ]);
    const result = prepareMyInvestorImport(parsed, {
      fundsAccountId: "funds",
      cashAccountId: "cash",
      matches: {
        [parsed.securities[0].source.rowKey]: parsed.movements[0].source.rowKey,
      },
    });
    expect(
      result.drafts.map(({ activityType, accountId, amount, quantity, unitPrice }) => ({
        activityType,
        accountId,
        amount,
        quantity,
        unitPrice,
      })),
    ).toEqual([
      {
        activityType: "TRANSFER_OUT",
        accountId: "cash",
        amount: "50",
        quantity: undefined,
        unitPrice: undefined,
      },
      {
        activityType: "TRANSFER_IN",
        accountId: "funds",
        amount: "50",
        quantity: undefined,
        unitPrice: undefined,
      },
      {
        activityType: "INTEREST",
        accountId: "cash",
        amount: "0.04",
        quantity: undefined,
        unitPrice: undefined,
      },
      { activityType: "BUY", accountId: "funds", amount: "50", quantity: "2", unitPrice: "25" },
    ]);
    expect(result.drafts.every((draft) => draft.status === "valid")).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.settlementChecks).toEqual([
      {
        accountId: "cash",
        currency: "EUR",
        expected: "-49.96",
        actual: "-49.96",
        isBalanced: true,
      },
      { accountId: "funds", currency: "EUR", expected: "0", actual: "0", isBalanced: true },
    ]);
    expect(result.legacyTransferDrafts).toHaveLength(2);
    expect(result.legacyTransferDrafts?.map(({ rowIndex }) => rowIndex)).toEqual([0, 1]);
    expect(
      result.drafts.find(({ activityType }) => activityType.startsWith("TRANSFER_"))?.comment,
    ).toContain("[Inversis ref");
  });

  it("requires an explicit match and offers suggestions instead of guessing", () => {
    const parsed = parseMyInvestorFiles([
      { name: "movimientos.xls", content: cashHtml },
      { name: "operaciones valores.xls", content: fundOperationsHtml },
    ]);
    const result = prepareMyInvestorImport(parsed, { fundsAccountId: "funds" });
    expect(result.matchSuggestions[0].candidates[0].criteria).toEqual(
      expect.arrayContaining(["same-date", "same-amount", "same-name"]),
    );
    expect(result.diagnostics.some(({ code }) => code === "security-match-required")).toBe(true);
  });

  it("keeps single-account imports balanced by suppressing the matched cash debit", () => {
    const parsed = parseMyInvestorFiles([
      { name: "movimientos.xls", content: cashHtml },
      { name: "operaciones valores.xls", content: fundOperationsHtml },
    ]);
    const result = prepareMyInvestorImport(parsed, {
      fundsAccountId: "funds",
      cashAccountId: "funds",
      matches: {
        [parsed.securities[0].source.rowKey]: parsed.movements[0].source.rowKey,
      },
    });
    expect(
      result.drafts.filter(({ activityType }) => activityType.startsWith("TRANSFER_")).length,
    ).toBe(0);
    expect(result.drafts.filter(({ activityType }) => activityType === "BUY")).toHaveLength(1);
    expect(
      result.drafts.every(({ sourceOperationGroup }) => sourceOperationGroup === undefined),
    ).toBe(true);
    expect(result.drafts.some(({ activityType }) => activityType === "WITHDRAWAL")).toBe(false);
    expect(result.diagnostics.some(({ severity }) => severity === "error")).toBe(false);
  });

  it("uses the real EUR debit and source USD price with the implied FX rate", () => {
    const parsed = parseMyInvestorFiles([
      { name: "movimientos.xls", content: stockCashHtml },
      { name: "valores.xls", content: stockOperationsHtml },
    ]);
    const result = prepareMyInvestorImport(parsed, {
      fundsAccountId: "funds",
      cashAccountId: "cash",
      matches: {
        [parsed.securities[0].source.rowKey]: parsed.movements[0].source.rowKey,
      },
    });
    const buy = result.drafts.find(({ activityType }) => activityType === "BUY");
    expect(buy).toMatchObject({
      currency: "USD",
      amount: "100",
      quantity: "1",
      unitPrice: "100",
      fxRate: "0.920000000000",
      accountId: "funds",
      status: "valid",
    });
    expect(
      result.drafts
        .filter(({ activityType }) => activityType.startsWith("TRANSFER_"))
        .map(({ currency, amount }) => ({ currency, amount })),
    ).toEqual([
      { currency: "EUR", amount: "92" },
      { currency: "EUR", amount: "92" },
    ]);
    expect(result.settlementChecks).toEqual([
      { accountId: "cash", currency: "EUR", expected: "-92", actual: "-92", isBalanced: true },
      { accountId: "funds", currency: "EUR", expected: "0", actual: "0", isBalanced: true },
    ]);
  });

  it("keeps transfer references unique and stable for repeated identical bank rows", () => {
    const parsed = parseMyInvestorFiles([
      { name: "movimientos.xls", content: cashHtml },
      { name: "operaciones valores.xls", content: fundOperationsHtml },
    ]);
    const security = parsed.securities[0];
    const movement = parsed.movements[0];
    const repeatedSecurity = {
      ...security,
      source: { ...security.source, rowKey: "second-security-row" },
      operationNumber: "OP-2",
      isin: "IE0000000002",
    };
    const repeatedMovement = {
      ...movement,
      source: { ...movement.source, rowKey: "second-cash-row" },
    };
    const extended = {
      ...parsed,
      securities: [...parsed.securities, repeatedSecurity],
      movements: [...parsed.movements, repeatedMovement],
    };
    const manualMatches = {
      [security.source.rowKey]: movement.source.rowKey,
      [repeatedSecurity.source.rowKey]: repeatedMovement.source.rowKey,
    };
    const prepare = (source: typeof extended) =>
      prepareMyInvestorImport(source, {
        fundsAccountId: "funds",
        cashAccountId: "cash",
        matches: manualMatches,
      });
    const first = prepare(extended);
    const reordered = prepare({
      ...extended,
      securities: [...extended.securities].reverse(),
      movements: [...extended.movements].reverse(),
    });
    const transferComments = (result: typeof first) =>
      result.drafts
        .filter(({ activityType }) => activityType.startsWith("TRANSFER_"))
        .map(({ comment }) => comment)
        .sort();
    expect(new Set(transferComments(first)).size).toBe(2);
    expect(transferComments(reordered)).toEqual(transferComments(first));
    const groups = new Map<string, string[]>();
    for (const draft of first.drafts) {
      if (!draft.activityType.startsWith("TRANSFER_") && draft.activityType !== "BUY") continue;
      const group = draft.sourceOperationGroup;
      expect(group).toBeDefined();
      if (!group) continue;
      groups.set(group, [...(groups.get(group) ?? []), draft.activityType]);
    }
    expect(groups.size).toBe(2);
    expect([...groups.values()].map((activities) => activities.sort())).toEqual([
      ["BUY", "TRANSFER_IN", "TRANSFER_OUT"],
      ["BUY", "TRANSFER_IN", "TRANSFER_OUT"],
    ]);
    expect(
      first.drafts
        .filter(({ activityType }) => activityType === "BUY")
        .every(({ sourceOperationGroup }) =>
          first.drafts
            .filter(({ activityType }) => activityType.startsWith("TRANSFER_"))
            .some(
              ({ sourceOperationGroup: transferGroup }) => transferGroup === sourceOperationGroup,
            ),
        ),
    ).toBe(true);
    expect(
      first.legacyTransferDrafts?.every(
        ({ sourceOperationGroup }) => sourceOperationGroup === undefined,
      ),
    ).toBe(true);
    expect(first.legacyTransferDrafts).toHaveLength(2);
    expect(first.legacyTransferDrafts?.map(({ rowIndex }) => rowIndex)).toEqual([0, 1]);
  });

  it("blocks an unclassified cash operation when its amount prevents ledger reconciliation", () => {
    const parsed = parseMyInvestorFiles([
      { name: "movimientos.xls", content: cashHtml.replace("LIQUIDAC. INTERESES", "OTRO CARGO") },
      { name: "operaciones valores.xls", content: fundOperationsHtml },
    ]);
    const result = prepareMyInvestorImport(parsed, {
      fundsAccountId: "funds",
      matches: {
        [parsed.securities[0].source.rowKey]: parsed.movements[0].source.rowKey,
      },
    });
    expect(result.diagnostics.some(({ code }) => code === "prepared-cash-mismatch")).toBe(true);
    expect(result.settlementChecks).toContainEqual({
      accountId: "funds",
      currency: "EUR",
      expected: "-49.96",
      actual: "-50",
      isBalanced: false,
    });
  });

  it("does not silently deduplicate overlapping exports or import malformed HTML values", () => {
    const parsed = parseMyInvestorFiles([
      { name: "movimientos-a.xls", content: cashHtml },
      { name: "movimientos-b.xls", content: cashHtml },
      { name: "operaciones valores.xls", content: fundOperationsHtml },
      { name: "operaciones valores overlap.xls", content: fundOperationsHtml },
    ]);
    expect(parsed.movements).toHaveLength(2);
    expect(parsed.securities).toHaveLength(1);
    expect(parsed.diagnostics).toEqual([]);
    const invalid = parseMyInvestorFiles([
      { name: "movimientos.xls", content: cashHtml.replace("-50,00", "-wat") },
      { name: "operaciones valores.xls", content: fundOperationsHtml },
    ]);
    expect(invalid.diagnostics.some(({ code }) => code === "invalid-cash-row")).toBe(true);
  });

  it("supports the six-column account export and blocks incorrect control-balance totals", () => {
    const sixColumn = `<!doctype html><table>
<tr><th>Fecha operación</th><th>Fecha valor</th><th>Tipo de operación</th><th>Concepto</th><th>Divisa</th><th>Importe</th></tr>
<tr><td>02/01/2026</td><td>02/01/2026</td><td>LIQUIDAC. INTERESES</td><td>PERIODO 01/12/2025 02/01/2026</td><td>EUR</td><td>0,25</td></tr>
</table>`;
    const parsed = parseMyInvestorFiles([
      { name: "movimientos.xls", content: sixColumn },
      { name: "valores.xls", content: stockOperationsHtml },
    ]);
    expect(parsed.movements).toHaveLength(1);
    expect(parsed.movements[0]).toMatchObject({ amount: "0.25", currency: "EUR" });

    const badControl = parseMyInvestorFiles([
      {
        name: "movimientos.xls",
        content: cashHtml.replace("Saldo Final</td><td>50,04", "Saldo Final</td><td>55,04"),
      },
      { name: "operaciones valores.xls", content: fundOperationsHtml },
    ]);
    expect(badControl.diagnostics.some(({ code }) => code === "cash-balance-mismatch")).toBe(true);
  });

  it("skips zero-value APERTURA rows and blocks nonzero opening movements", () => {
    const openingHtml = `<!doctype html><table>
<tr><th>Fecha operación</th><th>FECHA VALOR</th><th>Tipo de operación</th><th>Concepto</th><th>C/A</th><th>Cargo/Abono Importe</th><th>Saldo</th></tr>
<tr><td>01/01/2026</td><td>Saldo Inicio</td><td>100,00</td></tr>
<tr><td>02/01/2026</td><td>02/01/2026</td><td>APERTURA</td><td>Saldo inicial</td><td>A</td><td>0,00</td><td>100,00</td></tr>
<tr><td>03/01/2026</td><td>Saldo Final</td><td>100,00</td></tr>
</table>`;
    const parsed = parseMyInvestorFiles([
      { name: "movimientos.xls", content: openingHtml },
      { name: "operaciones valores.xls", content: fundOperationsHtml },
    ]);
    const result = prepareMyInvestorImport(parsed, { fundsAccountId: "funds" });
    expect(result.diagnostics.some(({ code }) => code === "zero-opening-movement-skipped")).toBe(
      true,
    );
    expect(result.diagnostics.some(({ code }) => code === "unsupported-cash-operation")).toBe(
      false,
    );
    expect(result.drafts.some(({ comment }) => comment === "Saldo inicial")).toBe(false);

    const nonzero = parseMyInvestorFiles([
      {
        name: "movimientos.xls",
        content: openingHtml
          .replace("0,00</td><td>100,00", "1,00</td><td>101,00")
          .replace("Saldo Final</td><td>100,00", "Saldo Final</td><td>101,00"),
      },
      { name: "operaciones valores.xls", content: fundOperationsHtml },
    ]);
    const nonzeroResult = prepareMyInvestorImport(nonzero, { fundsAccountId: "funds" });
    expect(nonzeroResult.diagnostics.some(({ code }) => code === "nonzero-opening-movement")).toBe(
      true,
    );
  });

  it("surfaces unsupported fee-like operations as blocking review instead of guessing a type", () => {
    const html = cashHtml.replace("SUSCRIPCION IIC", "CARGO POR TRANSFERENCIA");
    const parsed = parseMyInvestorFiles([
      { name: "movimientos.xls", content: html },
      { name: "operaciones valores.xls", content: fundOperationsHtml },
    ]);
    const result = prepareMyInvestorImport(parsed, { fundsAccountId: "funds" });
    expect(result.diagnostics.some(({ code }) => code === "unmatched-security-operation")).toBe(
      true,
    );
    const cashWithdrawal = result.drafts.find(({ activityType }) => activityType === "WITHDRAWAL");
    expect(cashWithdrawal).toMatchObject({ amount: "50", status: "valid" });
  });
});
