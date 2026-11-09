import { cn } from "@/lib/utils";
import { useAmountFormatting, useDateFormatting, useNumberFormatting } from "@wealthfolio/ui";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { INVERSIS_MATCH_STATES } from "./inversis-match-states";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  MyInvestorMatchEvidence,
  MyInvestorMovement,
  MyInvestorSecurityOperation,
} from "../utils/import-sources/source-types";

interface InversisMatchCardProps {
  security: MyInvestorSecurityOperation;
  movement?: MyInvestorMovement;
  matchState: keyof typeof INVERSIS_MATCH_STATES;
  evidence?: MyInvestorMatchEvidence;
  automatic: boolean;
  suggestionSource?: "ai" | "rules";
  aiReason?: string;
  children: ReactNode;
}

export function InversisMatchCard({
  security,
  movement,
  matchState,
  evidence,
  automatic,
  suggestionSource,
  aiReason,
  children,
}: InversisMatchCardProps) {
  const { t } = useTranslation();
  const amounts = useAmountFormatting();
  const dates = useDateFormatting();
  const numbers = useNumberFormatting();
  const appearance = INVERSIS_MATCH_STATES[matchState];
  const StateIcon = appearance.icon;
  const suggested = suggestionSource !== undefined;
  const sourceRow = (source: MyInvestorMovement["source"]) =>
    t("activity:import.inversis.sourceRow", { file: source.fileName, row: source.rowIndex + 1 });

  return (
    <div
      role="group"
      aria-label={`${security.name || security.isin}: ${t(`activity:import.inversis.matchStatus.${matchState}`)}`}
      className={cn("bg-card space-y-4 rounded-lg border border-s-4 p-4", appearance.card)}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={cn("gap-1.5", appearance.badge)}>
          <StateIcon aria-hidden="true" className="size-3.5" />
          {t(`activity:import.inversis.matchStatus.${matchState}`)}
        </Badge>
        {suggested && (
          <Badge variant="secondary" className="gap-1.5">
            {suggestionSource === "ai" && (
              <Icons.Sparkles aria-hidden="true" className="size-3.5" />
            )}
            {t(
              suggestionSource === "ai"
                ? "activity:import.inversis.aiProposal"
                : "activity:import.inversis.ruleProposal",
            )}
          </Badge>
        )}
        {automatic && (
          <span role="status" className="text-muted-foreground text-xs">
            {t("activity:import.inversis.automaticMatch")}
          </span>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="bg-muted/20 min-w-0 space-y-2 rounded-md border p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-muted-foreground text-xs font-medium">
              {t("activity:import.inversis.securityOperation")}
            </p>
            <p className="text-base font-semibold tabular-nums">
              <bdi dir="ltr">
                {amounts.formatAmount(Math.abs(Number(security.amount)), security.currency)}
              </bdi>
            </p>
          </div>
          <p className="text-sm font-medium break-words">
            <bdi>{security.name || security.isin}</bdi>
          </p>
          <p className="text-muted-foreground text-xs">
            {security.operation} · {t("common:quantity")}:{" "}
            {numbers.formatQuantity(Number(security.quantity))}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("activity:import.inversis.securityDates", {
              tradeDate: dates.formatDate(security.tradeDate),
              settlementDate: dates.formatDate(security.settlementDate),
            })}
          </p>
        </div>

        <div className="min-w-0 space-y-2 rounded-md border p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-muted-foreground text-xs font-medium">
              {t(
                suggested
                  ? "activity:import.inversis.suggestedCashMovement"
                  : "activity:import.inversis.cashMovement",
              )}
            </p>
            {movement && (
              <p className="text-base font-semibold tabular-nums">
                <bdi dir="ltr">
                  {amounts.formatAmount(Number(movement.amount), movement.currency)}
                </bdi>
              </p>
            )}
          </div>
          {movement && (
            <>
              <p className="text-sm font-medium break-words">
                <bdi>{movement.concept}</bdi>
              </p>
              <p className="text-muted-foreground text-xs">{movement.operation}</p>
              <p className="text-muted-foreground text-xs">
                {t("activity:import.inversis.cashDates", {
                  operationDate: dates.formatDate(movement.date),
                  valueDate: dates.formatDate(movement.valueDate),
                })}
              </p>
            </>
          )}
          {children}
        </div>
      </div>

      {movement && evidence && (
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
          <span className="flex items-center gap-1.5">
            {evidence.dateRelation === "settlement-value" ? (
              <Icons.Check aria-hidden="true" className="text-success size-3.5 shrink-0" />
            ) : (
              <Icons.AlertCircle aria-hidden="true" className="text-warning size-3.5 shrink-0" />
            )}
            {t(`activity:import.inversis.evidence.date.${evidence.dateRelation}`)}
          </span>
          {evidence.amountDifference !== undefined && (
            <span className="tabular-nums">
              {t("activity:import.inversis.amountDifferenceShort", {
                amount: amounts.formatAmount(Number(evidence.amountDifference), security.currency),
              })}
            </span>
          )}
          {evidence.fxRate !== undefined && (
            <span className="tabular-nums">
              {t("activity:import.inversis.evidence.fxRate", {
                rate: numbers.formatQuantity(Number(evidence.fxRate)),
                fromCurrency: security.currency,
                toCurrency: movement.currency,
              })}
            </span>
          )}
          <span className="text-muted-foreground">
            {t(`activity:import.inversis.evidence.name.${evidence.nameMatch}`)}
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-3 border-t pt-3">
        <details className="group min-w-0 flex-1 text-xs">
          <summary className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex w-fit cursor-pointer items-center gap-1 rounded-sm py-2 focus-visible:ring-2 focus-visible:outline-none">
            <Icons.ChevronRight
              aria-hidden="true"
              className="size-3.5 group-open:rotate-90 rtl:rotate-180 rtl:group-open:rotate-90"
            />
            {t("common:details")}
          </summary>
          <div className="text-muted-foreground mt-2 space-y-2 break-words">
            <p>
              {sourceRow(security.source)} · {security.isin}
            </p>
            {movement && <p>{sourceRow(movement.source)}</p>}
            {aiReason && (
              <p>
                <span className="font-medium">{t("activity:import.inversis.aiProposal")}:</span>{" "}
                {aiReason}
              </p>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}
