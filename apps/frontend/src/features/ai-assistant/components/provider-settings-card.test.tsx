import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MergedProvider } from "../types";
import { ProviderSettingsCard } from "./provider-settings-card";

const custom: MergedProvider = {
  id: "custom",
  name: "Custom (OpenAI-compatible)",
  type: "local",
  icon: "Bot",
  description: "Compatible server",
  envKey: "",
  models: [],
  defaultModel: "",
  documentationUrl: "",
  connectionFields: [
    {
      key: "baseUrl",
      label: "Endpoint",
      type: "text",
      placeholder: "http://127.0.0.1:8080/v1",
      required: true,
    },
    { key: "apiKey", label: "API key", type: "password", placeholder: "", required: false },
  ],
  enabled: true,
  favorite: false,
  priority: 15,
  favoriteModels: [],
  modelCapabilityOverrides: {},
  hasApiKey: false,
  isDefault: false,
  supportsModelListing: true,
};

describe("custom provider settings", () => {
  it.each(["ltr", "rtl"])(
    "allows model discovery without credentials and optional key storage in %s",
    async (dir) => {
      const refresh = vi.fn(),
        saveKey = vi.fn();
      render(
        <div dir={dir}>
          <ProviderSettingsCard
            provider={custom}
            onToggleEnabled={vi.fn()}
            onSetDefault={vi.fn()}
            onSaveApiKey={saveKey}
            onDeleteApiKey={vi.fn()}
            onRevealApiKey={async () => null}
            onSetFavoriteModels={vi.fn()}
            onRefreshModels={refresh}
          />{" "}
        </div>,
      );
      fireEvent.click(screen.getByRole("button", { name: /custom.*settings/i }));
      const input = await screen.findByLabelText("API key (optional)");
      const refreshButton = screen.getByRole("button", { name: /refresh/i });
      expect(refreshButton).toBeEnabled();
      fireEvent.click(refreshButton);
      expect(refresh).toHaveBeenCalledOnce();
      fireEvent.change(input, { target: { value: "test-token" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(saveKey).toHaveBeenCalledWith("test-token");
    },
  );
});
