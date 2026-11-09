import { openUrlInBrowser } from "@/adapters";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { SOURCE_RECONCILIATION_KEY, sourceReconciliationSchema } from "@/lib/source-reconciliation";
import type { ActivityDetails } from "@/lib/types";
import { Badge, Button, Icons, useDateFormatting, useNumberFormatting } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";

export function ActivitySourceReconciliation({
  activity,
}: {
  activity: Pick<ActivityDetails, "metadata" | "needsReview">;
}) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const { formatDecimal } = useNumberFormatting();
  const { formatDate } = useDateFormatting();
  const parsed = sourceReconciliationSchema.safeParse(
    activity.metadata?.[SOURCE_RECONCILIATION_KEY],
  );
  if (!parsed.success) return null;
  const original = parsed.data;
  const decimal = (value: string, signed = false) =>
    isBalanceHidden
      ? "••••"
      : formatDecimal(Number(value), {
          maximumFractionDigits: 20,
          ...(signed ? { signDisplay: "always" as const } : {}),
        });
  const rows = [
    [
      t("activity:sourceReconciliation.tradeDate"),
      formatDate(new Date(`${original.tradeDate}T12:00:00`)),
    ],
    [
      t("activity:sourceReconciliation.settlementDate"),
      formatDate(new Date(`${original.settlementDate}T12:00:00`)),
    ],
    [t("activity:sourceReconciliation.reference"), original.operationReference || "—"],
    ["ISIN", original.isin],
    [t("activity:sourceReconciliation.quantity"), decimal(original.quantity)],
    [
      t("activity:sourceReconciliation.unitPrice"),
      `${decimal(original.unitPrice)} ${original.currency}`,
    ],
    [
      t("activity:sourceReconciliation.sourceAmount"),
      `${decimal(original.sourceAmount)} ${original.currency}`,
    ],
    [
      t("activity:sourceReconciliation.settledAmount"),
      `${decimal(original.settledAmount)} ${original.currency}`,
    ],
    [
      t("activity:sourceReconciliation.calculatedAmount"),
      `${decimal(original.calculatedAmount)} ${original.currency}`,
    ],
    [
      t("activity:sourceReconciliation.difference"),
      `${decimal(original.difference, true)} ${original.currency}`,
    ],
  ];

  return (
    <section className="space-y-2" aria-label={t("activity:sourceReconciliation.title")}>
      <h4 className="text-sm font-semibold">{t("activity:sourceReconciliation.title")}</h4>
      <div className="bg-muted/30 space-y-3 rounded-lg border p-3">
        <Badge variant="outline">
          {activity.needsReview
            ? t("activity:detail.needs_review")
            : t("activity:sourceReconciliation.reviewed")}
        </Badge>
        <p className="text-muted-foreground text-xs">
          {t("activity:sourceReconciliation.description")}
        </p>
        <dl className="space-y-2 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4">
              <dt className="text-muted-foreground min-w-0">{label}</dt>
              <dd className="max-w-[60%] min-w-0 shrink-0 text-end font-medium break-all">
                <bdi>{value}</bdi>
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-muted-foreground text-xs">{t("activity:sourceReconciliation.reason")}</p>
        <p className="text-muted-foreground text-xs break-all">
          {t("activity:import.inversis.sourceRow", {
            file: original.sourceFile,
            row: original.sourceRow,
          })}
        </p>
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0"
          onClick={() => void openUrlInBrowser(original.referenceUrl)}
        >
          {t("activity:sourceReconciliation.link")}
          <Icons.ExternalLink className="ms-1 h-3 w-3" />
        </Button>
      </div>
    </section>
  );
}
