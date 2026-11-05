import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { getAiProviders } from "@/adapters";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { QueryKeys } from "@/lib/query-keys";
import type { AiProvidersResponse, MergedProvider, MergedModel } from "@/lib/types";

import { resolveModelSelection } from "./model-selection";

export const CHAT_MODEL_STORAGE_KEY = "chat_selected_model";

export interface StoredModelSelection {
  providerId: string;
  modelId: string;
}

export interface ChatModelState {
  isLoading: boolean;
  settings: AiProvidersResponse | undefined;
  enabledProviders: MergedProvider[];
  currentProviderId: string | undefined;
  currentModelId: string | undefined;
  currentProvider: MergedProvider | undefined;
  currentModel: MergedModel | undefined;
  selectModel: (providerId: string, modelId: string) => Promise<void>;
  /** Whether the current model supports thinking */
  supportsThinking: boolean;
  /** Whether thinking is enabled for this session (can be toggled by user) */
  thinkingEnabled: boolean;
  /** Toggle thinking on/off */
  toggleThinking: () => void;
}

export function useChatModel(): ChatModelState {
  const { data: settings, isLoading } = useQuery({
    queryKey: [QueryKeys.AI_PROVIDERS],
    queryFn: getAiProviders,
  });

  const [storedSelection, setStoredSelection] = usePersistentState<StoredModelSelection | null>(
    CHAT_MODEL_STORAGE_KEY,
    null,
  );

  // Get enabled providers
  // Local providers (like Ollama) don't require API keys
  // API providers require hasApiKey to be true
  const enabledProviders = useMemo(() => {
    return (
      settings?.providers.filter((p) => {
        if (!p.enabled) return false;
        // Local providers don't need API keys
        if (p.type === "local") return true;
        // API providers require an API key
        return p.hasApiKey;
      }) ?? []
    );
  }, [settings?.providers]);

  const selection = useMemo(
    () => resolveModelSelection(settings, storedSelection),
    [settings, storedSelection],
  );
  const currentProviderId = selection?.providerId;
  const currentModelId = selection?.modelId;

  // Get current provider object
  const currentProvider = useMemo(() => {
    return enabledProviders.find((p) => p.id === currentProviderId);
  }, [enabledProviders, currentProviderId]);

  const adjustedModelId = currentModelId;

  // Get current model object
  const currentModel = useMemo(() => {
    if (!currentProvider || !adjustedModelId) return undefined;
    return currentProvider.models.find((m) => m.id === adjustedModelId);
  }, [currentProvider, adjustedModelId]);

  // Check if current model supports thinking
  const supportsThinking = useMemo(() => {
    return currentModel?.capabilities?.thinking ?? false;
  }, [currentModel]);

  // Thinking enabled state - defaults to model's capability, but can be toggled
  // Reset to model default when model changes
  const [thinkingEnabled, setThinkingEnabled] = useState(supportsThinking);

  // Sync thinking state when model changes
  useEffect(() => {
    setThinkingEnabled(supportsThinking);
  }, [supportsThinking]);

  const toggleThinking = useCallback(() => {
    if (supportsThinking) {
      setThinkingEnabled((prev) => !prev);
    }
  }, [supportsThinking]);

  // Select a model
  const selectModel = useCallback(
    async (providerId: string, modelId: string) => {
      const provider = enabledProviders.find((p) => p.id === providerId);
      if (!provider) return;

      // Check if model is in catalog models or user's favorite models
      const isInCatalog = provider.models.some((m) => m.id === modelId);
      const isInFavorites = provider.favoriteModels?.includes(modelId);
      if (!modelId || (!isInCatalog && !isInFavorites)) return;
      const selectedModel = modelId;
      setStoredSelection({ providerId, modelId: selectedModel });
    },
    [enabledProviders, setStoredSelection],
  );

  return {
    isLoading,
    settings,
    enabledProviders,
    currentProviderId,
    currentModelId: adjustedModelId,
    currentProvider,
    currentModel,
    selectModel,
    supportsThinking,
    thinkingEnabled,
    toggleThinking,
  };
}
