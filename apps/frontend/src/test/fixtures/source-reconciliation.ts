import type { SourceReconciliation } from "@/lib/source-reconciliation";
import { MYINVESTOR_RECONCILIATION_URL } from "@/lib/source-reconciliation";

export const sourceReconciliationFixture: SourceReconciliation = {
  version: 1,
  issueCode: "myinvestor_settlement_difference",
  reasonCode: "undetermined",
  tradeDate: "2026-01-02",
  settlementDate: "2026-01-05",
  operationReference: "TEST-1",
  isin: "IE000ZYRH0Q7",
  sourceFile: "operations.xls",
  sourceRow: 3,
  currency: "EUR",
  quantity: "2",
  unitPrice: "24.99",
  sourceAmount: "50",
  settledAmount: "50",
  calculatedAmount: "49.98",
  difference: "0.02",
  referenceUrl: MYINVESTOR_RECONCILIATION_URL,
};
