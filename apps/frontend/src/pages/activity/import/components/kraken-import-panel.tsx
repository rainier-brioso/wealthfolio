import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Label } from "@wealthfolio/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui/components/ui/select";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { parseCsv } from "@/adapters";
import type { Account } from "@/lib/types";
import type { DraftActivity } from "../context/import-context";
import { createDefaultParseConfig } from "../utils/default-activity-template";
import { getActivityImportProfile } from "../utils/activity-import-profile";
import { prepareKrakenImport, type KrakenBalanceCheck } from "../utils/import-sources/kraken";

export function KrakenImportPanel({
  accounts,
  accountId,
  onPrepared,
  onReset,
}: {
  accounts: Account[];
  accountId: string;
  onPrepared: (drafts: DraftActivity[]) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const sourceAccount = accounts.find((account) => account.id === accountId);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [walletAccountId, setWalletAccountId] = useState("");
  const [balances, setBalances] = useState<KrakenBalanceCheck[]>([]);
  const [purchases, setPurchases] = useState(0);
  const [draftCount, setDraftCount] = useState(0);
  const [preparedDrafts, setPreparedDrafts] = useState<DraftActivity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [ready, setReady] = useState(false);
  const parseRun = useRef(0);
  useEffect(
    () => () => {
      ++parseRun.current;
    },
    [],
  );
  const wallets = accounts.filter(
    (account) =>
      account.id !== accountId &&
      getActivityImportProfile(account).assetResolutionEnabled &&
      account.trackingMode === "TRANSACTIONS" &&
      account.isActive &&
      !account.isArchived,
  );

  const reset = () => {
    ++parseRun.current;
    setReading(false);
    setReady(false);
    setBalances([]);
    setPurchases(0);
    setDraftCount(0);
    setPreparedDrafts([]);
    onReset();
  };

  const load = async (files: File[], targetAccountId = walletAccountId) => {
    setSelectedFiles(files);
    reset();
    const run = parseRun.current;
    setError(null);
    if (files.length < 1 || files.length > 2) {
      if (files.length) setError("file-count");
      return;
    }
    setReading(true);
    try {
      const parsed = await Promise.all(
        files.map(async (file) => {
          const result = await parseCsv(file, {
            ...createDefaultParseConfig(sourceAccount?.currency),
            delimiter: ",",
            decimalSeparator: ".",
            thousandsSeparator: "none",
          });
          return { headers: result.headers, rows: result.rows };
        }),
      );
      if (run !== parseRun.current) return;
      const result = prepareKrakenImport(
        parsed,
        accountId,
        targetAccountId,
        sourceAccount?.currency,
      );
      setBalances(result.balances);
      setPurchases(result.purchases);
      setDraftCount(result.drafts.length);
      setPreparedDrafts(result.drafts);
      setReady(true);
    } catch (reason) {
      if (run !== parseRun.current) return;
      setError(reason instanceof Error ? reason.message : "invalid-file");
    } finally {
      if (run === parseRun.current) setReading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("activity:import.kraken.title")}</CardTitle>
        <CardDescription>{t("activity:import.kraken.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-2">
            <span className="text-sm font-medium">{t("activity:import.kraken.files")}</span>
            <input
              type="file"
              accept=".csv,text/csv"
              multiple
              disabled={reading}
              className="block w-full rounded-md border p-2 text-sm"
              onChange={(event) => void load(Array.from(event.target.files ?? []))}
            />
          </label>
          <div className="space-y-2">
            <Label htmlFor="kraken-wallet-account">
              {t("activity:import.kraken.walletAccount")}
            </Label>
            <Select
              value={walletAccountId}
              disabled={reading}
              onValueChange={(value) => {
                const target = value ?? "";
                setWalletAccountId(target);
                reset();
                setError(null);
                if (selectedFiles.length) void load(selectedFiles, target);
              }}
            >
              <SelectTrigger id="kraken-wallet-account">
                <SelectValue placeholder={t("activity:import.kraken.walletPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {wallets.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              {t("activity:import.kraken.walletHelp")}
            </p>
            {wallets.length === 0 && (
              <p role="status" className="text-muted-foreground text-xs">
                {t("activity:import.kraken.walletEmpty")}
              </p>
            )}
          </div>
        </div>
        {reading && (
          <p role="status" className="text-muted-foreground text-sm">
            {t("activity:import.kraken.reading")}
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {t("activity:import.kraken.error")} <code>{error}</code>
          </p>
        )}
        {ready && (
          <div className="space-y-2 rounded-md border p-3 text-sm">
            <p>{t("activity:import.kraken.prepared", { purchases, total: draftCount })}</p>
            {balances.map((balance) => (
              <p key={balance.asset} className="text-muted-foreground">
                {balance.asset}: {balance.opening} → {balance.closing}
              </p>
            ))}
            <div className="flex justify-end pt-2">
              <Button type="button" onClick={() => onPrepared(preparedDrafts)}>
                {t("activity:import.inversis.useActivities")}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
