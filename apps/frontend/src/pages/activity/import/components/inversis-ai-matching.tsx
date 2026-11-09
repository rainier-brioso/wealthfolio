import { suggestImportMatches } from "@/adapters";
import { useChatModel } from "@/features/ai-assistant/hooks/use-chat-model";
import { availableProviderModels } from "@/features/ai-assistant/hooks/model-selection";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { useNumberFormatting } from "@wealthfolio/ui";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui/components/ui/select";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  buildMyInvestorAiPacket,
  validateMyInvestorAiResponse,
  type MyInvestorAiProposal,
} from "../utils/import-sources/myinvestor-ai";
import type { MyInvestorParsedFiles } from "../utils/import-sources/source-types";

interface InversisAiMatchingProps {
  parsed: MyInvestorParsedFiles;
  manual: Record<string, string>;
  resetKey: string;
  disabled: boolean;
  onProposals: (proposals: Record<string, MyInvestorAiProposal>) => void;
  onBusy: (busy: boolean) => void;
}

export function InversisAiMatching({
  parsed,
  manual,
  resetKey,
  disabled,
  onProposals,
  onBusy,
}: InversisAiMatchingProps) {
  const { t } = useTranslation();
  const numbers = useNumberFormatting();
  const model = useChatModel();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{
    key: "aiTimeout" | "aiInvalidResponse" | "aiProviderFailure";
    code: string;
  } | null>(null);
  const [summary, setSummary] = useState<{
    accepted: number;
    rejected: number;
    abstained: number;
  } | null>(null);
  const packet = useMemo(() => buildMyInvestorAiPacket(parsed, manual), [parsed, manual]);
  const providerIdentity = JSON.stringify([
    model.currentProviderId,
    model.currentModelId,
    model.currentProvider?.customUrl,
    model.currentModel?.capabilities,
    model.currentProvider?.resolvedTuning,
  ]);
  const identity = useMemo(
    () => ({
      parsed,
      manual,
      resetKey,
      provider: model.currentProviderId,
      model: model.currentModelId,
      providerIdentity,
    }),
    [parsed, manual, resetKey, model.currentProviderId, model.currentModelId, providerIdentity],
  );
  const current = useRef(identity);
  current.current = identity;
  const generation = useRef(0);
  const callbacks = useRef({ onProposals, onBusy });
  callbacks.current = { onProposals, onBusy };
  const lastProvider = useRef(providerIdentity);
  useEffect(() => {
    generation.current++;
    setBusy(false);
    setError(null);
    setSummary(null);
    callbacks.current.onBusy(false);
    if (lastProvider.current !== providerIdentity) {
      callbacks.current.onProposals({});
      lastProvider.current = providerIdentity;
    }
    return () => {
      generation.current++;
      callbacks.current.onBusy(false);
    };
  }, [identity, providerIdentity]);
  const choices = model.enabledProviders.flatMap((provider) =>
    availableProviderModels(provider).map((id) => ({
      value: JSON.stringify([provider.id, id]),
      label: `${provider.name} · ${provider.models.find((m) => m.id === id)?.name ?? id}`,
      providerId: provider.id,
      modelId: id,
    })),
  );
  const value =
    model.currentProviderId && model.currentModelId
      ? JSON.stringify([model.currentProviderId, model.currentModelId])
      : null;
  const ready = !!value;
  const analyze = async () => {
    if (
      !ready ||
      disabled ||
      !model.currentProviderId ||
      !model.currentModelId ||
      packet.context.candidates.length === 0
    )
      return;
    const run = ++generation.current;
    const snapshot = identity;
    setBusy(true);
    onBusy(true);
    setError(null);
    setSummary(null);
    let receivedResponse = false;
    try {
      const response = await suggestImportMatches({
        providerId: model.currentProviderId,
        modelId: model.currentModelId,
        context: packet.context,
      });
      if (run !== generation.current || current.current !== snapshot) return;
      receivedResponse = true;
      const checked = validateMyInvestorAiResponse(packet, response);
      onProposals(checked.proposals);
      setSummary({
        accepted: Object.keys(checked.proposals).length,
        rejected: checked.rejectedCount,
        abstained: response.abstainedCount,
      });
    } catch (cause: unknown) {
      if (run === generation.current && current.current === snapshot) {
        const message =
          cause instanceof Error
            ? cause.message
            : typeof cause === "object" && cause !== null && "ServiceError" in cause
              ? String(cause.ServiceError)
              : typeof cause === "string"
                ? cause
                : "";
        // Only show our bounded diagnostic codes, never raw provider output.
        const code = receivedResponse
          ? "AI_MATCH_INVALID_RESPONSE"
          : (/\bAI_MATCH_(?:TIMEOUT|INVALID_RESPONSE|PROVIDER_ERROR|HTTP_[1-5]\d{2})\b/.exec(
              message,
            )?.[0] ?? "AI_MATCH_PROVIDER_ERROR");
        setError({
          code,
          key:
            code === "AI_MATCH_TIMEOUT"
              ? "aiTimeout"
              : code === "AI_MATCH_INVALID_RESPONSE"
                ? "aiInvalidResponse"
                : "aiProviderFailure",
        });
      }
    } finally {
      if (run === generation.current && current.current === snapshot) {
        setBusy(false);
        onBusy(false);
      }
    }
  };
  return (
    <section
      aria-labelledby="inversis-ai-heading"
      className="bg-primary/5 border-primary/20 space-y-3 rounded-lg border p-4"
    >
      <h3 id="inversis-ai-heading" className="flex items-center gap-2 text-sm font-medium">
        <Icons.Sparkles aria-hidden="true" className="text-primary size-4" />
        {t("activity:import.inversis.aiAnalyze")}
      </h3>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 space-y-2">
          <Label htmlFor="inversis-ai-model">{t("activity:import.inversis.aiModel")}</Label>
          <Select
            items={choices}
            value={value}
            onValueChange={(value) => {
              const choice = choices.find((c) => c.value === value);
              if (choice) void model.selectModel(choice.providerId, choice.modelId);
            }}
          >
            <SelectTrigger id="inversis-ai-model">
              <SelectValue placeholder={t("activity:import.inversis.aiNoModel")} />
            </SelectTrigger>
            <SelectContent>
              {choices.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          className="shrink-0"
          disabled={
            !ready ||
            disabled ||
            busy ||
            model.isLoading ||
            packet.context.candidates.length === 0 ||
            parsed.diagnostics.some((d) => d.severity === "error")
          }
          onClick={() => void analyze()}
        >
          {t(busy ? "activity:import.inversis.aiAnalyzing" : "activity:import.inversis.aiAnalyze")}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        {value
          ? t("activity:import.inversis.aiPrivacy", {
              provider: model.currentProvider?.name,
              model: model.currentModelId,
            })
          : t("activity:import.inversis.aiNoModel")}
      </p>
      {summary && (
        <p role="status" className="text-muted-foreground text-sm">
          {t("activity:import.inversis.aiResult", {
            accepted: numbers.formatQuantity(summary.accepted),
            rejected: numbers.formatQuantity(summary.rejected),
            abstained: numbers.formatQuantity(summary.abstained),
          })}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {t(`activity:import.inversis.${error.key}`)}{" "}
          <span className="font-mono">{error.code}</span>
        </p>
      )}
    </section>
  );
}
