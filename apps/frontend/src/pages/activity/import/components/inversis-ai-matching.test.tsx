import { render, screen, waitFor } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { InversisAiMatching } from "./inversis-ai-matching";
import type { MyInvestorParsedFiles } from "../utils/import-sources/source-types";

const { suggest, state, select } = vi.hoisted(() => ({
  suggest: vi.fn(),
  select: vi.fn(),
  state: { provider: "custom", model: "strata", tools: true },
}));
vi.mock("@/adapters", () => ({ suggestImportMatches: suggest }));
vi.mock("@/features/ai-assistant/hooks/use-chat-model", () => ({
  useChatModel: () => ({
    currentProviderId: state.provider,
    currentModelId: state.model,
    currentModel: { capabilities: { tools: state.tools } },
    currentProvider: { name: state.provider },
    isLoading: false,
    enabledProviders: [
      { id: "custom", name: "Custom", favoriteModels: ["strata"], models: [] },
      { id: "ollama", name: "Ollama", favoriteModels: ["gemma"], models: [] },
    ],
    selectModel: select,
  }),
}));

const parsed: MyInvestorParsedFiles = {
  securities: [
    {
      source: { fileName: "s.xls", rowIndex: 0, rowKey: "security" },
      tradeDate: "2026-10-29",
      settlementDate: "2026-11-02",
      operationNumber: "1",
      market: "",
      operation: "SUSCRIPCION",
      isin: "IE0000000001",
      name: "Developed WRD",
      quantity: "2",
      unitPrice: "50",
      amount: "100",
      currency: "EUR",
      activityType: "BUY",
    },
  ],
  movements: [
    {
      source: { fileName: "m.xls", rowIndex: 0, rowKey: "cash" },
      date: "2026-10-29",
      valueDate: "2026-11-02",
      operation: "SUSCRIPCION IIC",
      concept: "Different abbreviation",
      amount: "-100",
      currency: "EUR",
    },
  ],
  controls: [],
  diagnostics: [],
};
const response = {
  proposals: [{ operationId: "S1", movementId: "C1", reason: "Dates and amount agree" }],
  rejectedCount: 0,
  abstainedCount: 0,
};
function props() {
  return {
    parsed,
    manual: {},
    resetKey: "account",
    disabled: false,
    onProposals: vi.fn(),
    onBusy: vi.fn(),
  };
}

describe("explicit AI matching", () => {
  it("offers configured models across providers before sending any request", async () => {
    render(<InversisAiMatching {...props()} />);
    await userEvent.click(screen.getByRole("combobox", { name: "AI model" }));
    await userEvent.click(await screen.findByRole("option", { name: "Ollama · gemma" }));
    expect(select).toHaveBeenCalledWith("ollama", "gemma");
    expect(suggest).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    state.provider = "custom";
    state.model = "strata";
    state.tools = true;
    suggest.mockResolvedValue(response);
  });
  it.each(["ltr", "rtl"])(
    "uses the displayed custom model only after a click in %s",
    async (dir) => {
      const p = props();
      render(
        <div dir={dir}>
          <InversisAiMatching {...p} />
        </div>,
      );
      expect(suggest).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole("button", { name: "Analyze with AI" }));
      await waitFor(() =>
        expect(p.onProposals).toHaveBeenCalledWith({
          security: { movementKey: "cash", reason: response.proposals[0].reason },
        }),
      );
      expect(suggest.mock.calls[0][0]).toMatchObject({ providerId: "custom", modelId: "strata" });
      expect(screen.getByRole("status")).toHaveTextContent("Suggestions: 1");
    },
  );
  it("allows structured matching when chat tools are disabled", async () => {
    state.tools = false;
    render(<InversisAiMatching {...props()} />);
    expect(screen.getByRole("region", { name: "Analyze with AI" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analyze with AI" })).toBeEnabled();
    expect(suggest).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Analyze with AI" }));
    await waitFor(() => expect(suggest).toHaveBeenCalledOnce());
  });
  it("ignores a late response after manual edits", async () => {
    let finish!: (r: typeof response) => void;
    suggest.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const p = props();
    const view = render(<InversisAiMatching {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "Analyze with AI" }));
    view.rerender(<InversisAiMatching {...p} manual={{ security: "" }} />);
    finish(response);
    await waitFor(() => expect(p.onBusy).toHaveBeenLastCalledWith(false));
    expect(p.onProposals).not.toHaveBeenCalled();
  });
  it("ignores a late response after changing provider", async () => {
    let finish!: (r: typeof response) => void;
    suggest.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const p = props();
    const view = render(<InversisAiMatching {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "Analyze with AI" }));
    state.provider = "ollama";
    state.model = "gemma";
    view.rerender(<InversisAiMatching {...p} />);
    finish(response);
    await waitFor(() => expect(p.onBusy).toHaveBeenLastCalledWith(false));
    expect(p.onProposals).toHaveBeenCalledWith({});
    expect(p.onProposals).not.toHaveBeenCalledWith(
      expect.objectContaining({ security: expect.anything() }),
    );
  });
  it.each(["provider failure", "invalid ids"])("preserves selections on %s", async (kind) => {
    if (kind === "provider failure") suggest.mockRejectedValue(new Error("unavailable"));
    else
      suggest.mockResolvedValue({
        ...response,
        proposals: [{ ...response.proposals[0], movementId: "invented" }],
      });
    const p = props();
    render(<InversisAiMatching {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "Analyze with AI" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your selections were preserved");
    expect(p.onProposals).not.toHaveBeenCalled();
  });
  it.each([
    ["AI_MATCH_TIMEOUT", "exceeded the time limit"],
    ["AI_MATCH_INVALID_RESPONSE", "incomplete or invalid proposals"],
    ["AI_MATCH_HTTP_503", "provider request failed"],
  ])("shows the safe diagnostic from a Tauri error object: %s", async (code, message) => {
    suggest.mockRejectedValue({ ServiceError: `Provider error: private provider text [${code}]` });
    const p = props();
    render(<InversisAiMatching {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "Analyze with AI" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(alert).toHaveTextContent(code);
    expect(alert).not.toHaveTextContent("private provider text");
    expect(p.onProposals).not.toHaveBeenCalled();
  });
});
