import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  useAmountFormatting,
  useNumberFormatting,
  useDateFormatting,
} from "@wealthfolio/ui";
import { readSantanderPensionPdf } from "../utils/import-sources/santander-pension-pdf";
import {
  parseSantanderPension,
  prepareSantanderPension,
  type PensionStatement,
} from "../utils/import-sources/santander-pension";
import type { DraftActivity, SourceImportQuote } from "../context/import-context";

export function SantanderPensionPanel({
  accountId,
  onPrepared,
  onReset,
}: {
  accountId: string;
  onPrepared: (drafts: DraftActivity[], quotes: SourceImportQuote[]) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const amounts = useAmountFormatting();
  const numbers = useNumberFormatting();
  const dates = useDateFormatting();
  const [statements, setStatements] = useState<PensionStatement[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);
  useEffect(
    () => () => {
      run.current++;
    },
    [],
  );
  useEffect(() => {
    run.current++;
    setStatements([]);
    setError(null);
    setProgress(null);
  }, [accountId]);
  const load = async (files: File[]) => {
    const current = ++run.current;
    onReset();
    setStatements([]);
    setError(null);
    if (!files.length) return;
    if (files.length > 12) {
      setError("pdf-limit");
      return;
    }
    setProgress(0);
    try {
      const result: PensionStatement[] = [];
      for (let index = 0; index < files.length; index++) {
        const page = await readSantanderPensionPdf(files[index], (value) => {
          if (run.current === current)
            setProgress(Math.round((index * 100 + value) / files.length));
        });
        if (run.current !== current) return;
        result.push(parseSantanderPension(page, accountId));
      }
      const prepared = prepareSantanderPension(result);
      if (run.current === current) setStatements(prepared.statements);
    } catch (reason) {
      if (run.current === current)
        setError(
          reason instanceof Error && /^[a-z-]+$/.test(reason.message)
            ? reason.message
            : "pdf-read-failed",
        );
    } finally {
      if (run.current === current) setProgress(null);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("activity:import.santander.title")}</CardTitle>
        <CardDescription>{t("activity:import.santander.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="block space-y-2">
          <span className="text-sm font-medium">{t("activity:import.santander.files")}</span>
          <input
            type="file"
            accept=".pdf,application/pdf"
            multiple
            disabled={progress !== null}
            className="block w-full rounded-md border p-3 text-sm"
            onChange={(event) => void load(Array.from(event.target.files ?? []))}
          />
        </label>
        {progress !== null && (
          <p role="status" className="text-muted-foreground text-sm">
            {t("activity:import.santander.reading", { progress })}
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {t("activity:import.santander.error")} <code>{error}</code>
          </p>
        )}
        {statements.map((statement, index) => (
          <section
            key={`${statement.symbol}-${statement.closingDate}-${index}`}
            className="space-y-3 rounded-lg border p-4"
          >
            <h3 className="text-sm font-medium">
              {statement.name} · {dates.formatDate(statement.closingDate)}
            </h3>
            <p className="text-muted-foreground text-sm">
              {numbers.formatDecimal(Number(statement.closingUnits), { maximumFractionDigits: 5 })}{" "}
              ×{" "}
              {numbers.formatDecimal(Number(statement.closingPrice), {
                minimumFractionDigits: 5,
                maximumFractionDigits: 5,
              })}{" "}
              EUR = {amounts.formatAmount(Number(statement.closingValue), "EUR")}
            </p>
            <div className="space-y-2">
              {statement.drafts
                .filter((draft) => draft.symbol)
                .map((draft) => (
                  <div
                    key={draft.comment}
                    className="flex flex-wrap justify-between gap-2 border-t pt-2 text-sm"
                  >
                    <span className="min-w-0 break-words">
                      {dates.formatDate(draft.activityDate)} · {draft.comment?.split(" [")[0]}
                    </span>
                    <span>{amounts.formatAmount(Number(draft.amount), "EUR")}</span>
                  </div>
                ))}
            </div>
          </section>
        ))}
        {statements.length > 0 && (
          <div className="flex justify-end">
            <Button
              onClick={() => {
                const result = prepareSantanderPension(statements);
                onPrepared(
                  result.drafts,
                  result.statements.map((statement) => ({
                    symbol: statement.symbol,
                    date: statement.closingDate,
                    price: statement.closingPrice,
                    currency: "EUR",
                  })),
                );
              }}
            >
              {t("activity:import.inversis.useActivities")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
