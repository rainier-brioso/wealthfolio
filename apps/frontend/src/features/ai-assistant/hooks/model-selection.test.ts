import { describe, it, expect } from "vitest";
import { resolveModelSelection } from "./model-selection";
import type { AiProvidersResponse, MergedProvider } from "@/lib/types";

function provider(id: string, overrides: Partial<MergedProvider> = {}): MergedProvider {
  return {
    id,
    name: id,
    type: "local",
    icon: "",
    description: "",
    envKey: "",
    connectionFields: [],
    models: [],
    defaultModel: "",
    documentationUrl: "",
    enabled: true,
    favorite: true,
    priority: 0,
    favoriteModels: [],
    modelCapabilityOverrides: {},
    hasApiKey: false,
    isDefault: false,
    supportsModelListing: true,
    ...overrides,
  };
}
describe("model selection", () => {
  it("falls back from disabled Ollama to a custom favorite with no catalog default", () => {
    const settings: AiProvidersResponse = {
      providers: [
        provider("ollama", { enabled: false, defaultModel: "old" }),
        provider("custom", { favoriteModels: ["qwen-local"] }),
      ],
      capabilities: {},
    };
    expect(resolveModelSelection(settings, { providerId: "ollama", modelId: "old" })).toEqual({
      providerId: "custom",
      modelId: "qwen-local",
    });
  });
  it("preserves an explicit selected model and does not choose an unconfigured empty provider", () => {
    const settings: AiProvidersResponse = {
      providers: [provider("empty"), provider("custom", { favoriteModels: ["first", "chosen"] })],
      capabilities: {},
    };
    expect(
      resolveModelSelection(settings, { providerId: "custom", modelId: "chosen" })?.modelId,
    ).toBe("chosen");
    expect(resolveModelSelection(settings, null)?.modelId).toBe("first");
  });
  it("does not use disabled providers or API providers without credentials", () => {
    const settings: AiProvidersResponse = {
      providers: [
        provider("disabled", { enabled: false, favoriteModels: ["x"] }),
        provider("api", { type: "api", favoriteModels: ["y"] }),
      ],
      capabilities: {},
    };
    expect(resolveModelSelection(settings, null)).toBeUndefined();
  });
});
