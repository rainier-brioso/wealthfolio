import { describe, it, expect } from "vitest";
import {
  buildMyInvestorAiPacket,
  validateMyInvestorAiResponse,
  type MyInvestorAiPacket,
} from "./myinvestor-ai";
import type { MyInvestorParsedFiles } from "./source-types";

const packet: MyInvestorAiPacket = {
  context: {
    operations: [
      {
        id: "S1",
        date: "2026-10-29",
        settlementDate: "2026-11-02",
        kind: "BUY",
        name: "Fund",
        isin: "IE0000000001",
        amount: "100",
        quantity: "2",
        unitPrice: "50",
        currency: "EUR",
      },
    ],
    movements: [
      {
        id: "C1",
        date: "2026-10-29",
        valueDate: "2026-11-02",
        operation: "SUSCRIPCION IIC",
        concept: "Fund",
        amount: "-100",
        currency: "EUR",
      },
    ],
    reserved: [],
    candidates: [{ operationId: "S1", movementIds: ["C1"] }],
  },
  operationKeys: { S1: "source-operation" },
  movementKeys: { C1: "source-movement" },
};
const response = {
  proposals: [{ operationId: "S1", movementId: "C1", reason: "Source evidence" }],
  rejectedCount: 0,
  abstainedCount: 0,
};
describe("MyInvestor AI proposal boundary", () => {
  it("maps known source IDs only and leaves inputs untouched", () => {
    const before = structuredClone(packet);
    expect(validateMyInvestorAiResponse(packet, response).proposals).toEqual({
      "source-operation": { movementKey: "source-movement", reason: "Source evidence" },
    });
    expect(packet).toEqual(before);
  });
  it("rejects wrong amounts or value dates and rejects whole duplicate/unknown batches", () => {
    const wrong = structuredClone(packet);
    wrong.context.movements[0].amount = "-999";
    expect(validateMyInvestorAiResponse(wrong, response).rejectedCount).toBe(1);
    wrong.context.movements[0].amount = "-100";
    wrong.context.movements[0].valueDate = "2026-11-03";
    expect(validateMyInvestorAiResponse(wrong, response).proposals).toEqual({});
    expect(() =>
      validateMyInvestorAiResponse(packet, {
        ...response,
        proposals: [...response.proposals, ...response.proposals],
      }),
    ).toThrow();
    expect(() =>
      validateMyInvestorAiResponse(packet, {
        ...response,
        proposals: [{ ...response.proposals[0], movementId: "invented" }],
      }),
    ).toThrow();
  });
  it("preserves automatic matches, rule proposals and explicit manual clears", () => {
    const parsed: MyInvestorParsedFiles = {
      securities: [],
      movements: [],
      controls: [],
      diagnostics: [],
    };
    for (let i = 1; i <= 3; i++) {
      parsed.securities.push({
        source: { fileName: "s.xls", rowIndex: i, rowKey: `s${i}` },
        tradeDate: "2026-10-29",
        settlementDate: "2026-11-02",
        operationNumber: String(i),
        market: "",
        operation: "SUSCRIPCION",
        isin: `IE${i}`,
        name: `Specific Fund ${i}`,
        quantity: "2",
        unitPrice: "50",
        amount: "100",
        currency: "EUR",
        activityType: "BUY",
      });
      parsed.movements.push({
        source: { fileName: "m.xls", rowIndex: i, rowKey: `c${i}` },
        date: "2026-10-29",
        valueDate: "2026-11-02",
        operation: "SUSCRIPCION IIC",
        concept: `Specific Fund ${i}`,
        amount: "-100",
        currency: "EUR",
      });
    }
    const result = buildMyInvestorAiPacket(parsed, { s1: "" });
    expect(result.context.candidates.some((c) => c.operationId === "S1")).toBe(false);
    expect(result.context.reserved.length).toBe(2);
    expect(result.context.operations.map((o) => o.id)).toEqual(["S1", "S2", "S3"]);
    expect(JSON.stringify(result.context)).not.toContain("s.xls");
  });
});
