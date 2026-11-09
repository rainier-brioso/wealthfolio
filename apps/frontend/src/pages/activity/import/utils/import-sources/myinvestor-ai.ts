import type {
  ImportMatchContext,
  ImportMatchResponse,
} from "@/features/ai-assistant/import-matching-types";
import { matchMyInvestorOperations } from "./myinvestor";
import type { MyInvestorParsedFiles } from "./source-types";

export interface MyInvestorAiProposal {
  movementKey: string;
  reason: string;
}
export interface MyInvestorAiPacket {
  context: ImportMatchContext;
  operationKeys: Record<string, string>;
  movementKeys: Record<string, string>;
}

export function buildMyInvestorAiPacket(
  parsed: MyInvestorParsedFiles,
  manual: Record<string, string>,
): MyInvestorAiPacket {
  const matching = matchMyInvestorOperations(parsed, manual);
  const operationIds = new Map(parsed.securities.map((s, i) => [s.source.rowKey, `S${i + 1}`]));
  const movementIds = new Map(parsed.movements.map((m, i) => [m.source.rowKey, `C${i + 1}`]));
  const reserved = Object.entries({ ...matching.proposals, ...matching.matches })
    .filter(([s, m]) => !!m && operationIds.has(s) && movementIds.has(m))
    .map(([s, m]) => ({ operationId: operationIds.get(s)!, movementId: movementIds.get(m)! }));
  const occupied = new Set(reserved.map((p) => p.movementId));
  const context: ImportMatchContext = {
    operations: parsed.securities.map((s) => ({
      id: operationIds.get(s.source.rowKey)!,
      date: s.tradeDate,
      settlementDate: s.settlementDate,
      kind: s.activityType ?? "UNKNOWN",
      name: s.name,
      isin: s.isin,
      quantity: s.quantity,
      unitPrice: s.unitPrice,
      amount: s.amount,
      currency: s.currency,
    })),
    movements: parsed.movements.map((m) => ({
      id: movementIds.get(m.source.rowKey)!,
      date: m.date,
      valueDate: m.valueDate,
      operation: m.operation,
      concept: m.concept,
      amount: m.amount,
      currency: m.currency,
      ...(m.balance === undefined ? {} : { balance: m.balance }),
    })),
    reserved,
    candidates: matching.suggestions
      .filter(
        (s) =>
          !matching.matches[s.security.rowKey] &&
          !matching.proposals[s.security.rowKey] &&
          !Object.hasOwn(manual, s.security.rowKey),
      )
      .map((s) => ({
        operationId: operationIds.get(s.security.rowKey)!,
        movementIds: s.candidates
          .filter((c) => c.evidence.dateRelation === "settlement-value")
          .map((c) => movementIds.get(c.movement.rowKey)!)
          .filter((id) => !!id && !occupied.has(id)),
      })),
  };
  // Keep the whole securities context, but do not send unrelated bank transfers,
  // interest or other cash rows that cannot participate in this reconciliation.
  const relevantMovements = new Set([
    ...context.reserved.map((p) => p.movementId),
    ...context.candidates.flatMap((c) => c.movementIds),
  ]);
  context.movements = context.movements.filter((m) => relevantMovements.has(m.id));
  return {
    context,
    operationKeys: Object.fromEntries([...operationIds].map(([key, id]) => [id, key])),
    movementKeys: Object.fromEntries([...movementIds].map(([key, id]) => [id, key])),
  };
}

function amountParts(value: string): { units: bigint; scale: bigint } | undefined {
  if (!/^-?\d+(?:\.\d{1,12})?$/.test(value)) return;
  const fraction = value.split(".")[1] ?? "";
  return { units: BigInt(value.replace(".", "")), scale: 10n ** BigInt(fraction.length) };
}

/** Validate again at the UI boundary; never trust IDs, amounts, or uniqueness from a model. */
export function validateMyInvestorAiResponse(
  packet: MyInvestorAiPacket,
  response: ImportMatchResponse,
): {
  proposals: Record<string, MyInvestorAiProposal>;
  rejectedCount: number;
} {
  if (
    !Array.isArray(response.proposals) ||
    !Number.isInteger(response.rejectedCount) ||
    response.rejectedCount < 0 ||
    !Number.isInteger(response.abstainedCount) ||
    response.abstainedCount < 0
  )
    throw new Error("Invalid AI matching response");
  const { context } = packet;
  if (
    response.proposals.length + response.rejectedCount + response.abstainedCount !==
    context.candidates.length
  )
    throw new Error("Incomplete AI matching response");
  const occupied = new Set(context.reserved.map((p) => p.movementId));
  const seen = new Set<string>();
  const proposals: Record<string, MyInvestorAiProposal> = {};
  let rejectedCount = response.rejectedCount;
  for (const p of response.proposals) {
    const allowed = context.candidates.find((c) => c.operationId === p.operationId);
    const operation = context.operations.find((o) => o.id === p.operationId);
    const movement = context.movements.find((m) => m.id === p.movementId);
    if (
      !allowed ||
      !operation ||
      !movement ||
      !allowed.movementIds.includes(p.movementId) ||
      seen.has(p.operationId) ||
      occupied.has(p.movementId) ||
      typeof p.reason !== "string" ||
      [...p.reason].length > 300
    )
      throw new Error("Invalid AI matching response");
    seen.add(p.operationId);
    occupied.add(p.movementId);
    const amount = amountParts(operation.amount),
      cash = amountParts(movement.amount);
    if (!amount || !cash) throw new Error("Invalid AI matching response");
    const debit = cash.units < 0n;
    const direction =
      operation.kind === "BUY" ? debit : operation.kind === "SELL" && cash.units > 0n;
    const absoluteCash = cash.units < 0n ? -cash.units : cash.units;
    const difference = amount.units * cash.scale - absoluteCash * amount.scale;
    const magnitude = difference < 0n ? -difference : difference;
    const compatibleAmount =
      operation.currency === movement.currency
        ? magnitude * 100n <= 2n * amount.scale * cash.scale
        : allowed.movementIds.filter(
            (id) =>
              context.movements.find((m) => m.id === id)?.valueDate === operation.settlementDate,
          ).length === 1;
    if (operation.settlementDate !== movement.valueDate || !direction || !compatibleAmount) {
      rejectedCount++;
      continue;
    }
    proposals[packet.operationKeys[p.operationId]] = {
      movementKey: packet.movementKeys[p.movementId],
      reason: p.reason,
    };
  }
  return { proposals, rejectedCount };
}
