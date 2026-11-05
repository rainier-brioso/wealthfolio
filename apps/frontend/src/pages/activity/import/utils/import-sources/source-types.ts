import type { DraftActivity } from "../../context";

export interface SourceDiagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  fileName?: string;
  rowIndex?: number;
  values?: Record<string, string>;
}

export interface ControlBalance {
  fileName: string;
  kind: "opening" | "closing";
  date: string;
  amount: string;
  currency: string;
  rowIndex: number;
}

export interface SourceProvenance {
  fileName: string;
  rowIndex: number;
  rowKey: string;
}

export interface MyInvestorMovement {
  source: SourceProvenance;
  date: string;
  valueDate: string;
  operation: string;
  concept: string;
  amount: string;
  currency: string;
  balance?: string;
}

export interface MyInvestorSecurityOperation {
  source: SourceProvenance;
  tradeDate: string;
  settlementDate: string;
  operationNumber: string;
  market: string;
  operation: string;
  isin: string;
  name: string;
  quantity: string;
  currency: string;
  unitPrice: string;
  amount: string;
  activityType: DraftActivity["activityType"];
}

export interface MyInvestorParsedFiles {
  movements: MyInvestorMovement[];
  securities: MyInvestorSecurityOperation[];
  controls: ControlBalance[];
  diagnostics: SourceDiagnostic[];
}

export interface PreparedMyInvestorImport {
  drafts: DraftActivity[];
  /** Original transfer comments for detecting duplicates from earlier importer versions. */
  legacyTransferDrafts?: DraftActivity[];
  diagnostics: SourceDiagnostic[];
  controls: ControlBalance[];
  matchSuggestions: MyInvestorMatchSuggestion[];
  settlementChecks: SettlementCheck[];
}

export interface SettlementCheck {
  accountId: string;
  currency: string;
  expected: string;
  actual: string;
  isBalanced: boolean;
}

export interface MyInvestorOperationMatches {
  /** Manual selections plus mutually unique strong matches. Empty values preserve explicit clears. */
  matches: Record<string, string>;
  /** Reciprocal unique instrument-and-date proposals for editable preselection. */
  proposals: Record<string, string>;
  /** All eligible cash candidates, ordered deterministically for review. */
  suggestions: MyInvestorMatchSuggestion[];
}

export interface MyInvestorMatchCandidate {
  movement: SourceProvenance;
  criteria: (
    | "same-date"
    | "near-date"
    | "same-amount"
    | "same-name"
    | "cross-currency"
    | "far-date"
  )[];
  evidence: MyInvestorMatchEvidence;
}

export interface MyInvestorMatchEvidence {
  dateRelation: "settlement-value" | "trade-operation" | "other";
  nameMatch: "exact" | "similar" | "different";
  nameScore: number;
  amountDifference?: string;
  fxRate?: string;
}

export interface MyInvestorMatchSuggestion {
  security: SourceProvenance;
  candidates: MyInvestorMatchCandidate[];
}

export interface PrepareMyInvestorImportOptions {
  fundsAccountId: string;
  cashAccountId?: string;
  /** Explicit security rowKey -> cash movement rowKey associations selected in review. */
  matches?: Record<string, string>;
}

export type { DraftActivity };
