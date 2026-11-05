import { AccountType } from "@/lib/constants";
import { checkActivitiesImport } from "@/adapters";
import type { Account } from "@/lib/types";
import { cn } from "@/lib/utils";
import { InversisMatchCard } from "./inversis-match-card";
import { INVERSIS_MATCH_STATES as MATCH_STATES } from "./inversis-match-states";
import type {
  ControlBalance,
  SettlementCheck,
  SourceDiagnostic,
} from "../utils/import-sources/source-types";
import { useAmountFormatting, useDateFormatting, useNumberFormatting } from "@wealthfolio/ui";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import { Label } from "@wealthfolio/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui/components/ui/select";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { draftToActivityImport } from "../utils/draft-utils";
import {
  matchMyInvestorOperations,
  parseMyInvestorFiles,
  prepareMyInvestorImport,
} from "../utils/import-sources/myinvestor";
import type { MyInvestorParsedFiles } from "../utils/import-sources/source-types";
import type { DraftActivity } from "../context/import-context";
import { InversisAiMatching } from "./inversis-ai-matching";
import type { MyInvestorAiProposal } from "../utils/import-sources/myinvestor-ai";

interface InversisImportPanelProps {
  accounts: Account[];
  fundsAccountId: string;
  onPrepared: (drafts: DraftActivity[]) => void;
  onReset: () => void;
}

const NO_CASH_ACCOUNT = "__single_account__";

function readWindows1252(file: File): Promise<string> {
  return file.arrayBuffer().then((buffer) => new TextDecoder("windows-1252").decode(buffer));
}

export function InversisImportPanel({
  accounts,
  fundsAccountId,
  onPrepared,
  onReset,
}: InversisImportPanelProps) {
  const { t } = useTranslation();
  const amountFormatting = useAmountFormatting();
  const dateFormatting = useDateFormatting();
  const numberFormatting = useNumberFormatting();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const parseRun = useRef(0);
  const [files, setFiles] = useState<File[]>([]);
  const [parsed, setParsed] = useState<MyInvestorParsedFiles | null>(null);
  const [cashAccountId, setCashAccountId] = useState(NO_CASH_ACCOUNT);
  const [matches, setMatches] = useState<Record<string, string>>({});
  const [aiProposals, setAiProposals] = useState<Record<string, MyInvestorAiProposal>>({});
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [diagnostics, setDiagnostics] = useState<SourceDiagnostic[]>([]);
  const [controls, setControls] = useState<ControlBalance[]>([]);
  const [settlementChecks, setSettlementChecks] = useState<SettlementCheck[]>([]);
  const [drafts, setDrafts] = useState<DraftActivity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [resultReady, setResultReady] = useState(false);
  useEffect(
    () => () => {
      parseRun.current += 1;
    },
    [],
  );

  const fundsAccount = accounts.find((account) => account.id === fundsAccountId);
  const fundsAccountIdentity = `${fundsAccountId}:${fundsAccount?.accountType}:${fundsAccount?.trackingMode}:${fundsAccount?.currency}:${fundsAccount?.isActive}:${fundsAccount?.isArchived}`;
  const fundsAccountIdentityRef = useRef(fundsAccountIdentity);
  const onResetRef = useRef(onReset);
  onResetRef.current = onReset;
  const handleAiBusy = useCallback((busy: boolean) => {
    setIsAnalyzing(busy);
    if (busy) {
      ++parseRun.current;
      setDrafts([]);
      setResultReady(false);
      setDiagnostics([]);
      setControls([]);
      setSettlementChecks([]);
      onResetRef.current();
    }
  }, []);
  const handleAiProposals = useCallback((next: Record<string, MyInvestorAiProposal>) => {
    ++parseRun.current;
    setIsPreparing(false);
    setAiProposals(next);
    setDrafts([]);
    setResultReady(false);
    setDiagnostics([]);
    setControls([]);
    setSettlementChecks([]);
    onResetRef.current();
  }, []);
  const validFundsAccount =
    fundsAccount?.accountType === AccountType.SECURITIES &&
    fundsAccount.trackingMode === "TRANSACTIONS" &&
    fundsAccount.currency.toUpperCase() === "EUR" &&
    fundsAccount.isActive &&
    !fundsAccount.isArchived;
  const availableCashAccounts = accounts.filter(
    (account) =>
      account.id !== fundsAccountId &&
      account.accountType === AccountType.CASH &&
      account.trackingMode === "TRANSACTIONS" &&
      account.currency.toUpperCase() === "EUR" &&
      account.isActive &&
      !account.isArchived,
  );

  useEffect(() => {
    if (fundsAccountIdentityRef.current === fundsAccountIdentity) return;
    fundsAccountIdentityRef.current = fundsAccountIdentity;
    ++parseRun.current;
    setIsPreparing(false);
    setIsReading(false);
    setMatches({});
    setAiProposals({});
    setDiagnostics([]);
    setControls([]);
    setSettlementChecks([]);
    setDrafts([]);
    setResultReady(false);
    setError(null);
    onResetRef.current();
  }, [fundsAccountIdentity]);
  const operationMatches = useMemo(
    () => (parsed ? matchMyInvestorOperations(parsed, matches) : null),
    [matches, parsed],
  );
  const proposals = useMemo(() => {
    const rules = operationMatches?.proposals ?? {};
    const used = new Set([
      ...Object.values(operationMatches?.matches ?? {}),
      ...Object.values(rules),
    ]);
    const extra = Object.fromEntries(
      Object.entries(aiProposals)
        .filter(
          ([key, p]) =>
            !Object.hasOwn(matches, key) &&
            !operationMatches?.matches[key] &&
            !rules[key] &&
            !used.has(p.movementKey),
        )
        .map(([key, p]) => [key, p.movementKey]),
    );
    return { ...extra, ...rules };
  }, [operationMatches, aiProposals, matches]);
  const selectedMatches = useMemo(
    () =>
      Object.fromEntries(
        Object.entries({ ...proposals, ...operationMatches?.matches }).filter(([, key]) => !!key),
      ),
    [proposals, operationMatches],
  );
  const movementsByKey = useMemo(
    () => new Map((parsed?.movements ?? []).map((movement) => [movement.source.rowKey, movement])),
    [parsed],
  );
  const orderedOperations = useMemo(
    () =>
      (parsed?.securities ?? [])
        .map((security, sourceIndex) => {
          const key = security.source.rowKey;
          const matchState = selectedMatches[key] ? "matched" : "unmatched";
          const reviewPriority = matchState === "unmatched" ? 0 : proposals[key] ? 1 : 2;
          return { security, sourceIndex, matchState, reviewPriority } as const;
        })
        .sort((a, b) => a.reviewPriority - b.reviewPriority || a.sourceIndex - b.sourceIndex),
    [selectedMatches, parsed, proposals],
  );

  const formatMovementLabel = (movementKey: string) => {
    const movement = movementsByKey.get(movementKey);
    if (!movement) return t("activity:import.inversis.chooseMatch");
    return `${dateFormatting.formatDate(movement.date)} · ${movement.operation} · ${movement.concept} · ${amountFormatting.formatAmount(Math.abs(Number(movement.amount)), movement.currency)}`;
  };

  const getEvidence = (securityKey: string, movementKey?: string) => {
    if (!movementKey) return undefined;
    return operationMatches?.suggestions
      .find((item) => item.security.rowKey === securityKey)
      ?.candidates.find((candidate) => candidate.movement.rowKey === movementKey)?.evidence;
  };

  const handleFilesChanged = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    event.currentTarget.value = "";
    const run = ++parseRun.current;
    setFiles(selected);
    setParsed(null);
    setDiagnostics([]);
    setControls([]);
    setSettlementChecks([]);
    setDrafts([]);
    setMatches({});
    setAiProposals({});
    setIsReading(false);
    setIsPreparing(false);
    setResultReady(false);
    setError(null);
    onReset();
    if (selected.length === 0) return;
    if (selected.some((file) => !file.name.toLowerCase().endsWith(".xls"))) {
      setError(t("activity:import.inversis.invalidFiles"));
      return;
    }

    setIsReading(true);
    try {
      const contents = await Promise.all(
        selected.map(async (file) => ({ name: file.name, content: await readWindows1252(file) })),
      );
      if (run !== parseRun.current) return;
      setParsed(parseMyInvestorFiles(contents));
    } catch {
      if (run === parseRun.current) setError(t("activity:import.inversis.invalidFiles"));
    } finally {
      if (run === parseRun.current) setIsReading(false);
    }
  };

  const handlePrepare = async () => {
    if (!parsed || !validFundsAccount || isAnalyzing) return;
    const run = ++parseRun.current;
    setError(null);
    setResultReady(false);
    setIsPreparing(true);
    setDiagnostics([]);
    setControls([]);
    setSettlementChecks([]);
    setDrafts([]);
    onReset();
    let checkingLegacyTransfers = false;
    try {
      const options = {
        fundsAccountId,
        ...(cashAccountId !== NO_CASH_ACCOUNT ? { cashAccountId } : {}),
        matches: selectedMatches,
      };
      const result = prepareMyInvestorImport(parsed, options);
      const nextDiagnostics = [...result.diagnostics];
      if (
        !nextDiagnostics.some((diagnostic) => diagnostic.severity === "error") &&
        cashAccountId !== NO_CASH_ACCOUNT &&
        (result.legacyTransferDrafts?.length ?? 0) > 0
      ) {
        const probes = result.legacyTransferDrafts ?? [];
        checkingLegacyTransfers = true;
        const expectedLineNumbers = probes.map((draft) => draft.rowIndex + 1);
        if (new Set(expectedLineNumbers).size !== expectedLineNumbers.length) {
          throw new Error("duplicate probe line number");
        }
        const validated = await checkActivitiesImport({
          activities: probes.map(draftToActivityImport),
        });
        if (run !== parseRun.current) return;
        if (!Array.isArray(validated) || validated.length !== probes.length) {
          throw new Error("incomplete duplicate response");
        }
        const resultByLine = new Map<number, (typeof validated)[number]>();
        for (const item of validated) {
          if (
            typeof item.lineNumber !== "number" ||
            !Number.isInteger(item.lineNumber) ||
            resultByLine.has(item.lineNumber)
          ) {
            throw new Error("invalid duplicate response line");
          }
          resultByLine.set(item.lineNumber, item);
        }
        for (const lineNumber of expectedLineNumbers) {
          const item = resultByLine.get(lineNumber);
          if (!item || item.duplicateOfLineNumber !== undefined) {
            throw new Error("unverified duplicate response line");
          }
          const warnings = item.warnings as Record<string, unknown> | undefined;
          if (
            item.warnings != null &&
            (typeof item.warnings !== "object" || Array.isArray(item.warnings))
          ) {
            throw new Error("malformed validation warnings");
          }
          if (
            item.errors !== undefined &&
            item.errors !== null &&
            (typeof item.errors !== "object" || Array.isArray(item.errors))
          ) {
            throw new Error("malformed validation errors");
          }
          const duplicateWarning = warnings?._duplicate;
          const hasDuplicateWarning =
            (Array.isArray(duplicateWarning) &&
              duplicateWarning.some((warning) => typeof warning === "string" && warning.trim())) ||
            (typeof duplicateWarning === "string" && duplicateWarning.trim().length > 0);
          if (
            duplicateWarning !== undefined &&
            Array.isArray(duplicateWarning) &&
            duplicateWarning.some((warning) => typeof warning !== "string")
          ) {
            throw new Error("malformed duplicate warning");
          }
          if (
            duplicateWarning !== undefined &&
            !Array.isArray(duplicateWarning) &&
            typeof duplicateWarning !== "string"
          ) {
            throw new Error("malformed duplicate warning");
          }
          if (
            (item.duplicateOfId !== undefined &&
              item.duplicateOfId !== null &&
              item.duplicateOfId !== "") ||
            hasDuplicateWarning
          ) {
            nextDiagnostics.push({
              severity: "error",
              code: "legacy-transfer-conflict",
              message: "A previous MyInvestor transfer may already be imported.",
            });
          } else if (
            item.isValid !== true ||
            (item.errors && Object.keys(item.errors).length > 0)
          ) {
            throw new Error("duplicate preflight validation failed");
          }
        }
      }
      if (run !== parseRun.current) return;
      setDiagnostics(nextDiagnostics);
      setControls(result.controls);
      setSettlementChecks(result.settlementChecks ?? []);
      setDrafts(result.drafts);
      setResultReady(true);
    } catch {
      if (run !== parseRun.current) return;
      setDiagnostics((current) =>
        checkingLegacyTransfers
          ? [
              ...current,
              {
                severity: "error",
                code: "legacy-check-failed",
                message: "Existing MyInvestor transfers could not be checked safely.",
              },
            ]
          : current,
      );
      if (checkingLegacyTransfers) {
        setControls([]);
        setSettlementChecks([]);
        setDrafts([]);
        setResultReady(true);
      } else {
        setError(t("activity:import.inversis.invalidFiles"));
      }
    } finally {
      if (run === parseRun.current) setIsPreparing(false);
    }
  };

  const handleUseDrafts = () => {
    if (drafts.length === 0 || hasBlockingDiagnostics || !validFundsAccount) return;
    onPrepared(drafts);
  };

  const hasBlockingDiagnostics = diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const counts = drafts.reduce<Record<string, number>>((result, draft) => {
    const activityType = draft.activityType ?? "UNKNOWN";
    result[activityType] = (result[activityType] ?? 0) + 1;
    return result;
  }, {});

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("activity:import.inversis.title")}</CardTitle>
        <CardDescription>{t("activity:import.inversis.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="inversis-files">{t("activity:import.inversis.files")}</Label>
            <input
              ref={fileInputRef}
              id="inversis-files"
              type="file"
              accept=".xls,application/vnd.ms-excel"
              multiple
              className="file:bg-primary file:text-primary-foreground hover:file:bg-primary/90 block w-full cursor-pointer rounded-md border p-2 text-sm file:me-3 file:rounded file:border-0 file:px-3 file:py-1.5"
              onChange={handleFilesChanged}
            />
            {files.length > 0 && (
              <p className="text-muted-foreground text-xs">
                {t("activity:import.inversis.fileCount", { total: files.length })}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="inversis-cash-account">
              {t("activity:import.inversis.cashAccount")}
            </Label>
            <Select
              value={cashAccountId}
              items={[
                {
                  value: NO_CASH_ACCOUNT,
                  label: t("activity:import.inversis.singleAccount", {
                    account: fundsAccount?.name,
                  }),
                },
                ...availableCashAccounts.map((account) => ({
                  value: account.id,
                  label: account.name,
                })),
              ]}
              onValueChange={(value) => {
                setCashAccountId(value ?? NO_CASH_ACCOUNT);
                ++parseRun.current;
                setIsPreparing(false);
                setMatches({});
                setAiProposals({});
                setDrafts([]);
                setDiagnostics([]);
                setControls([]);
                setSettlementChecks([]);
                setResultReady(false);
                onReset();
              }}
            >
              <SelectTrigger id="inversis-cash-account">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CASH_ACCOUNT}>
                  {t("activity:import.inversis.singleAccount", { account: fundsAccount?.name })}
                </SelectItem>
                {availableCashAccounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              {t("activity:import.inversis.cashAccountHelp")}
            </p>
          </div>
        </div>

        {parsed && parsed.securities.length > 0 && parsed.movements.length > 0 && (
          <div className="space-y-3">
            <InversisAiMatching
              parsed={parsed}
              manual={matches}
              resetKey={`${fundsAccountIdentity}:${cashAccountId}`}
              disabled={isReading || isPreparing || !validFundsAccount}
              onProposals={handleAiProposals}
              onBusy={handleAiBusy}
            />
            <div className="space-y-3 border-t pt-5">
              <h3 className="text-sm font-medium">{t("activity:import.inversis.matchSecurity")}</h3>
              <p className="text-muted-foreground text-xs">
                {t("activity:import.inversis.attentionOrder")}
              </p>
              <p className="text-muted-foreground text-xs">
                {t("activity:import.inversis.selectionHelp")}
              </p>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(MATCH_STATES) as (keyof typeof MATCH_STATES)[]).map((state) => {
                  const StateIcon = MATCH_STATES[state].icon;
                  return (
                    <Badge
                      key={state}
                      variant="outline"
                      className={cn("gap-1.5", MATCH_STATES[state].badge)}
                    >
                      <StateIcon aria-hidden="true" className="size-3.5" />
                      {t(`activity:import.inversis.matchStatus.${state}`)}:{" "}
                      {numberFormatting.formatQuantity(
                        orderedOperations.filter((item) => item.matchState === state).length,
                      )}
                    </Badge>
                  );
                })}
              </div>
            </div>
            {orderedOperations.map(({ security, matchState }) => {
              const securityKey = security.source.rowKey;
              const acceptedMatch = operationMatches?.matches[securityKey] ?? "";
              const proposal = proposals[securityKey];
              const suggestion = operationMatches?.suggestions.find(
                (item) => item.security.rowKey === securityKey,
              );
              const movementKey = acceptedMatch || proposal;
              const selected = movementKey || "__unmatched__";
              const movement = movementKey ? movementsByKey.get(movementKey) : undefined;
              const options = [
                { value: "__unmatched__", label: t("activity:import.inversis.chooseMatch") },
                ...(suggestion?.candidates.map((candidate) => ({
                  value: candidate.movement.rowKey,
                  label: formatMovementLabel(candidate.movement.rowKey),
                })) ?? []),
              ];
              return (
                <InversisMatchCard
                  key={security.source.rowKey}
                  security={security}
                  movement={movement}
                  matchState={matchState}
                  automatic={!!acceptedMatch && !Object.hasOwn(matches, securityKey)}
                  suggestionSource={
                    proposal && !acceptedMatch
                      ? aiProposals[securityKey]?.movementKey === proposal
                        ? "ai"
                        : "rules"
                      : undefined
                  }
                  evidence={getEvidence(securityKey, movementKey)}
                  aiReason={
                    aiProposals[securityKey]?.movementKey === proposal
                      ? aiProposals[securityKey]?.reason
                      : undefined
                  }
                >
                  <Select
                    items={options}
                    value={selected || "__unmatched__"}
                    onValueChange={(value) => {
                      ++parseRun.current;
                      setIsPreparing(false);
                      setMatches((current) => {
                        const next = { ...current };
                        next[securityKey] = value && value !== "__unmatched__" ? value : "";
                        return next;
                      });
                      setDrafts([]);
                      setResultReady(false);
                      onReset();
                    }}
                  >
                    <SelectTrigger
                      className={
                        movement ? "h-8 w-auto max-w-full bg-transparent text-xs" : undefined
                      }
                      aria-label={`${t("activity:import.inversis.matchSecurity")} ${security.source.rowIndex + 1}`}
                    >
                      {movement ? (
                        <span>{t("activity:import.inversis.changeMovement")}</span>
                      ) : (
                        <SelectValue placeholder={t("activity:import.inversis.chooseMatch")} />
                      )}
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__unmatched__">
                        {t("activity:import.inversis.chooseMatch")}
                      </SelectItem>
                      {(suggestion?.candidates ?? []).map((candidate) => {
                        const movement = movementsByKey.get(candidate.movement.rowKey);
                        if (!movement) return null;
                        return (
                          <SelectItem
                            key={candidate.movement.rowKey}
                            value={candidate.movement.rowKey}
                            disabled={Object.entries(selectedMatches).some(
                              ([securityKey, movementKey]) =>
                                movementKey === candidate.movement.rowKey &&
                                securityKey !== security.source.rowKey,
                            )}
                          >
                            {formatMovementLabel(candidate.movement.rowKey)}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </InversisMatchCard>
              );
            })}
          </div>
        )}

        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            onClick={handlePrepare}
            disabled={!parsed || isReading || isPreparing || isAnalyzing || !validFundsAccount}
          >
            {isReading || isPreparing
              ? t("activity:import.inversis.reading")
              : t("activity:import.inversis.prepare")}
          </Button>
        </div>

        {resultReady && (
          <div className="space-y-4 rounded-md border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium">{t("activity:import.inversis.preview")}</h3>
              <Badge variant="secondary">
                {t("activity:import.inversis.activitiesCount", { total: drafts.length })}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(counts).map(([activityType, count]) => (
                <Badge key={activityType} variant="outline">
                  {activityType}: {numberFormatting.formatQuantity(count)}
                </Badge>
              ))}
            </div>
            {controls.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium">{t("activity:import.inversis.controls")}</h4>
                {controls.map((control, index) => (
                  <p key={`${control.date}-${index}`} className="text-muted-foreground text-sm">
                    {control.fileName} · {t(`activity:import.inversis.${control.kind}`)} ·{" "}
                    {control.date}:{" "}
                    {amountFormatting.formatAmount(Number(control.amount), control.currency)}
                  </p>
                ))}
              </div>
            )}
            {settlementChecks.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium">
                  {t("activity:import.inversis.settlementChecks")}
                </h4>
                {settlementChecks.map((check, index) => (
                  <p
                    key={`${check.accountId}-${check.currency}-${index}`}
                    className="text-muted-foreground text-sm"
                  >
                    {accounts.find((account) => account.id === check.accountId)?.name ??
                      check.accountId}{" "}
                    · {check.currency}: {t("activity:import.inversis.settlementExpected")}{" "}
                    {amountFormatting.formatAmount(Number(check.expected), check.currency)} ·{" "}
                    {t("activity:import.inversis.settlementActual")}{" "}
                    {amountFormatting.formatAmount(Number(check.actual), check.currency)} ·{" "}
                    {t(
                      check.isBalanced
                        ? "activity:import.inversis.settlementBalanced"
                        : "activity:import.inversis.settlementMismatch",
                    )}
                  </p>
                ))}
              </div>
            )}
            {diagnostics.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium">{t("activity:import.inversis.diagnostics")}</h4>
                <ul className="text-muted-foreground list-inside list-disc space-y-1 text-sm">
                  {diagnostics.map((diagnostic, index) => (
                    <li key={`${index}-${diagnostic.code}`}>
                      {t(`activity:import.inversis.errors.${diagnostic.code}`, {
                        defaultValue: diagnostic.message,
                        ...diagnostic.values,
                      })}
                      {diagnostic.fileName && ` · ${diagnostic.fileName}`}
                      {diagnostic.rowIndex !== undefined && ` · ${diagnostic.rowIndex + 1}`}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {drafts.length === 0 && (
              <p className="text-muted-foreground text-sm">
                {t("activity:import.inversis.noActivities")}
              </p>
            )}
            <div className="flex justify-end">
              <Button
                onClick={handleUseDrafts}
                disabled={drafts.length === 0 || hasBlockingDiagnostics || !validFundsAccount}
              >
                {t("activity:import.inversis.useActivities")}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
