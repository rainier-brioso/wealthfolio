import type { AiProvidersResponse, MergedProvider } from "@/lib/types";
import type { StoredModelSelection } from "./use-chat-model";

export function availableProviderModels(provider: MergedProvider): string[] {
  return provider.favoriteModels.length > 0
    ? provider.favoriteModels.filter(Boolean)
    : provider.models.map((model) => model.id).filter(Boolean);
}

export function resolveModelSelection(
  settings: AiProvidersResponse | undefined,
  stored: StoredModelSelection | null,
): StoredModelSelection | undefined {
  const providers =
    settings?.providers.filter(
      (provider) => provider.enabled && (provider.type === "local" || provider.hasApiKey),
    ) ?? [];
  const ordered = [...providers].sort((a, b) => {
    const priority = (provider: MergedProvider) =>
      provider.id === stored?.providerId ? 0 : provider.id === settings?.defaultProvider ? 1 : 2;
    return priority(a) - priority(b);
  });
  for (const provider of ordered) {
    const models = availableProviderModels(provider);
    const preferred = [
      provider.id === stored?.providerId ? stored.modelId : undefined,
      provider.selectedModel,
      provider.defaultModel,
    ];
    const modelId = preferred.find((id) => !!id && models.includes(id)) ?? models[0];
    if (modelId) return { providerId: provider.id, modelId };
  }
  return undefined;
}
