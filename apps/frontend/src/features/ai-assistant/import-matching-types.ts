export interface ImportMatchPair {
  operationId: string;
  movementId: string;
}
export interface ImportMatchOperation {
  id: string;
  date: string;
  settlementDate: string;
  kind: string;
  name: string;
  isin: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  currency: string;
}
export interface ImportMatchMovement {
  id: string;
  date: string;
  valueDate: string;
  operation: string;
  concept: string;
  amount: string;
  currency: string;
  balance?: string;
}
export interface ImportMatchContext {
  operations: ImportMatchOperation[];
  movements: ImportMatchMovement[];
  reserved: ImportMatchPair[];
  candidates: { operationId: string; movementIds: string[] }[];
}
export interface ImportMatchRequest {
  providerId: string;
  modelId: string;
  context: ImportMatchContext;
}
export interface ImportMatchProposal extends ImportMatchPair {
  reason: string;
}
export interface ImportMatchResponse {
  proposals: ImportMatchProposal[];
  rejectedCount: number;
  abstainedCount: number;
}
