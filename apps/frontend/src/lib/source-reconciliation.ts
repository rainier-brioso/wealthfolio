import { z } from "zod";

export const MYINVESTOR_RECONCILIATION_URL =
  "https://www.rankia.com/foros/fondos-inversion/temas/4472241-seguimiento-opiniones-myinvestor?page=575";
export const SOURCE_RECONCILIATION_KEY = "source_reconciliation";
const decimal = z
  .string()
  .max(64)
  .regex(/^-?\d+(?:\.\d+)?$/);

export const sourceReconciliationSchema = z.object({
  version: z.literal(1),
  issueCode: z.literal("myinvestor_settlement_difference"),
  reasonCode: z.literal("undetermined"),
  tradeDate: z.iso.date(),
  settlementDate: z.iso.date(),
  operationReference: z.string().max(128),
  isin: z.string().max(32),
  sourceFile: z.string().max(255),
  sourceRow: z.number().int().positive(),
  currency: z.string().min(1).max(12),
  quantity: decimal,
  unitPrice: decimal,
  sourceAmount: decimal,
  settledAmount: decimal,
  calculatedAmount: decimal,
  difference: decimal,
  referenceUrl: z.literal(MYINVESTOR_RECONCILIATION_URL),
});

export type SourceReconciliation = z.infer<typeof sourceReconciliationSchema>;
