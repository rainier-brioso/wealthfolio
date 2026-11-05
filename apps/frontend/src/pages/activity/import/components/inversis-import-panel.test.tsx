import { AccountType } from "@/lib/constants";
import type { Account } from "@/lib/types";
import { render, screen, waitFor, within } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InversisImportPanel } from "./inversis-import-panel";
import type { MyInvestorParsedFiles } from "../utils/import-sources/source-types";
import type { MyInvestorAiProposal } from "../utils/import-sources/myinvestor-ai";
import type { ReactNode } from "react";

const {
  parseMyInvestorFiles,
  prepareMyInvestorImport,
  matchMyInvestorOperations,
  checkActivitiesImport,
  aiPanel,
} = vi.hoisted(() => ({
  parseMyInvestorFiles: vi.fn(),
  prepareMyInvestorImport: vi.fn(),
  matchMyInvestorOperations: vi.fn(),
  checkActivitiesImport: vi.fn(),
  aiPanel:
    vi.fn<
      (props: {
        onProposals: (proposals: Record<string, MyInvestorAiProposal>) => void;
      }) => ReactNode
    >(),
}));

vi.mock("@/adapters", () => ({ checkActivitiesImport }));
vi.mock("./inversis-ai-matching", () => ({ InversisAiMatching: aiPanel }));

vi.mock("../utils/import-sources/myinvestor", () => ({
  parseMyInvestorFiles,
  prepareMyInvestorImport,
  matchMyInvestorOperations,
}));

const account: Account = {
  id: "funds",
  name: "MyInvestor funds",
  accountType: AccountType.SECURITIES,
  balance: 0,
  currency: "EUR",
  isDefault: false,
  isActive: true,
  isArchived: false,
  trackingMode: "TRANSACTIONS",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const cashAccount: Account = {
  ...account,
  id: "cash",
  name: "Daily cash",
  accountType: AccountType.CASH,
};

const legacyTransferDraft = {
  rowIndex: 8,
  rawRow: [],
  activityDate: "2026-09-12",
  activityType: "TRANSFER_OUT",
  amount: "25.00",
  currency: "EUR",
  accountId: "cash",
  status: "valid",
  errors: {},
  warnings: {},
  isEdited: false,
};

const preparedWithLegacyProbe = {
  drafts: [legacyTransferDraft],
  legacyTransferDrafts: [legacyTransferDraft],
  diagnostics: [],
  controls: [],
  matchSuggestions: [],
  settlementChecks: [
    { accountId: "cash", currency: "EUR", expected: "75.00", actual: "75.00", isBalanced: true },
  ],
};

function makeXlsFile(name = "operations.xls", content = "xls bytes") {
  const file = new File([content], name);
  file.arrayBuffer = vi.fn().mockResolvedValue(new TextEncoder().encode(content).buffer);
  return file;
}

describe("InversisImportPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aiPanel.mockReset().mockReturnValue(null);
    checkActivitiesImport.mockResolvedValue([]);
    parseMyInvestorFiles.mockReturnValue({
      securities: [],
      movements: [],
      controls: [],
      diagnostics: [],
    });
    prepareMyInvestorImport.mockReturnValue({
      drafts: [],
      diagnostics: [],
      controls: [],
      matchSuggestions: [],
    });
    matchMyInvestorOperations.mockReturnValue({ matches: {}, proposals: {}, suggestions: [] });
  });

  it.each(["ltr", "rtl"])(
    "shows source arithmetic warnings without blocking preparation (%s)",
    async (direction) => {
      const user = userEvent.setup();
      const onPrepared = vi.fn();
      prepareMyInvestorImport.mockReturnValue({
        ...preparedWithLegacyProbe,
        legacyTransferDrafts: [],
        diagnostics: [
          {
            severity: "warning",
            code: "trade-total-review",
            message: "Fallback arithmetic warning",
            fileName: "operations.xls",
            rowIndex: 3,
            values: {
              isin: "IE000ZYRH0Q7",
              quantity: "2",
              price: "20",
              amount: "50",
              currency: "EUR",
              difference: "10",
            },
          },
        ],
      });
      render(
        <div dir={direction}>
          <InversisImportPanel
            accounts={[account]}
            fundsAccountId={account.id}
            onPrepared={onPrepared}
            onReset={vi.fn()}
          />
        </div>,
      );
      await user.upload(screen.getByLabelText(/Inversis exports/), makeXlsFile());
      await user.click(screen.getByRole("button", { name: "Prepare activities" }));
      expect(
        await screen.findByText(/quantity 2 × price 20 differs from net amount 50 EUR/),
      ).toBeVisible();
      expect(screen.getByText(/difference: 10/)).toHaveTextContent("operations.xls · 4");
      await user.click(screen.getByRole("button", { name: "Use these activities" }));
      expect(onPrepared).toHaveBeenCalled();
    },
  );

  it("preselects AI suggestions for preparation and preserves explicit clears and other suggestions", async () => {
    const parsed: MyInvestorParsedFiles = {
      securities: [1, 2].map((i) => ({
        source: { fileName: "s.xls", rowIndex: i, rowKey: `s${i}` },
        tradeDate: "2026-10-29",
        settlementDate: "2026-11-02",
        operationNumber: String(i),
        market: "",
        operation: "SUSCRIPCION",
        isin: `IE${i}`,
        name: `AI Fund ${i}`,
        quantity: "2",
        unitPrice: "50",
        amount: "100",
        currency: "EUR",
        activityType: "BUY",
      })),
      movements: [1, 2].map((i) => ({
        source: { fileName: "m.xls", rowIndex: i, rowKey: `c${i}` },
        date: "2026-10-29",
        valueDate: "2026-11-02",
        operation: "SUSCRIPCION IIC",
        concept: `Cash ${i}`,
        amount: "-100",
        currency: "EUR",
      })),
      controls: [],
      diagnostics: [],
    };
    parseMyInvestorFiles.mockReturnValue(parsed);
    matchMyInvestorOperations.mockImplementation(
      (_parsed: unknown, manual: Record<string, string> = {}) => ({
        matches: manual,
        proposals: {},
        suggestions: parsed.securities.map((s, i) => ({
          security: s.source,
          candidates: [
            {
              movement: parsed.movements[i].source,
              criteria: [],
              evidence: { dateRelation: "settlement-value", nameMatch: "different", nameScore: 0 },
            },
            {
              movement: parsed.movements[1 - i].source,
              criteria: [],
              evidence: { dateRelation: "settlement-value", nameMatch: "different", nameScore: 0 },
            },
          ],
        })),
      }),
    );
    aiPanel.mockImplementation(({ onProposals }) => (
      <>
        <button
          onClick={() =>
            onProposals({
              s1: { movementKey: "c1", reason: "Evidence one" },
              s2: { movementKey: "c2", reason: "Evidence two" },
            })
          }
        >
          AI fixture
        </button>
        <button onClick={() => onProposals({})}>Clear AI fixture</button>
      </>
    ));
    const onPrepared = vi.fn();
    const user = userEvent.setup();
    render(
      <InversisImportPanel
        accounts={[account]}
        fundsAccountId={account.id}
        onPrepared={onPrepared}
        onReset={vi.fn()}
      />,
    );
    await user.upload(screen.getByLabelText(/Inversis exports/), makeXlsFile());
    await user.click(await screen.findByRole("button", { name: "AI fixture" }));
    expect(screen.getByRole("group", { name: "AI Fund 1: Matched" })).toHaveClass(
      "border-s-success",
    );
    expect(screen.getByRole("group", { name: "AI Fund 2: Matched" })).toHaveClass(
      "border-s-success",
    );
    expect(onPrepared).not.toHaveBeenCalled();
    expect(prepareMyInvestorImport).not.toHaveBeenCalled();
    const pendingCard = screen.getByRole("group", { name: "AI Fund 1: Matched" });
    expect(within(pendingCard).getByText("Suggested cash movement")).toBeVisible();
    expect(within(pendingCard).getByText("Cash 1")).toBeVisible();
    expect(within(pendingCard).getByText(/Evidence one/)).not.toBeVisible();
    await user.click(within(pendingCard).getByText("Details"));
    expect(within(pendingCard).getByText(/Evidence one/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Confirm match" })).not.toBeInTheDocument();
    expect(screen.getByText("Matched: 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Prepare activities" }));
    expect(prepareMyInvestorImport).toHaveBeenLastCalledWith(parsed, {
      fundsAccountId: "funds",
      matches: { s1: "c1", s2: "c2" },
    });
    await user.click(within(pendingCard).getByRole("combobox"));
    expect(screen.getByRole("option", { name: /Cash 2/ })).toHaveAttribute("aria-disabled", "true");
    await user.click(await screen.findByRole("option", { name: "Select the cash movement" }));
    expect(screen.getByRole("group", { name: "AI Fund 1: Needs selection" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "AI Fund 2: Matched" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Prepare activities" }));
    expect(prepareMyInvestorImport).toHaveBeenLastCalledWith(parsed, {
      fundsAccountId: "funds",
      matches: { s2: "c2" },
    });
    await user.click(within(pendingCard).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: /Cash 1/ }));
    expect(within(pendingCard).queryByText("AI suggestion")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Prepare activities" }));
    expect(prepareMyInvestorImport).toHaveBeenLastCalledWith(parsed, {
      fundsAccountId: "funds",
      matches: { s1: "c1", s2: "c2" },
    });
    expect(onPrepared).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Prepared import" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear AI fixture" }));
    expect(screen.queryByRole("heading", { name: "Prepared import" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "AI Fund 1: Matched" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "AI Fund 2: Needs selection" })).toBeInTheDocument();
  });

  it.each(["ltr", "rtl"])(
    "puts unresolved rows before proposals and matches in %s",
    async (direction) => {
      const user = userEvent.setup();
      const names = ["Fund Auto", "Fund Proposal", "Fund Manual A", "Fund Manual B"];
      const parsed: MyInvestorParsedFiles = {
        securities: names.map((name, rowIndex) => ({
          source: { fileName: "securities.xls", rowIndex, rowKey: name },
          tradeDate: "2026-09-12",
          settlementDate: "2026-09-14",
          operationNumber: String(rowIndex),
          market: "ES",
          operation: "SUSCRIPCION",
          isin: `ES${rowIndex}`,
          name,
          quantity: "1",
          currency: "EUR",
          unitPrice: "25",
          amount: "25",
          activityType: "BUY",
        })),
        movements: ["auto-cash", "proposal-cash"].map((rowKey, rowIndex) => ({
          source: { fileName: "movements.xls", rowIndex, rowKey },
          date: "2026-09-12",
          valueDate: "2026-09-14",
          operation: "SUSCRIPCION IIC",
          concept: rowKey,
          amount: "-25",
          currency: "EUR",
        })),
        controls: [],
        diagnostics: [],
      };
      parseMyInvestorFiles.mockReturnValue(parsed);
      matchMyInvestorOperations.mockImplementation(
        (_parsed: unknown, manual: Record<string, string> = {}) => ({
          matches: { "Fund Auto": "auto-cash", ...manual },
          proposals: Object.hasOwn(manual, "Fund Proposal")
            ? {}
            : { "Fund Proposal": "proposal-cash" },
          suggestions: parsed.securities.map((security) => ({
            security: security.source,
            candidates: [],
          })),
        }),
      );
      render(
        <div dir={direction}>
          <InversisImportPanel
            accounts={[account]}
            fundsAccountId={account.id}
            onPrepared={vi.fn()}
            onReset={vi.fn()}
          />
        </div>,
      );
      await user.upload(screen.getByLabelText(/Inversis exports/), makeXlsFile());
      const unresolved = await screen.findByRole("group", {
        name: "Fund Manual A: Needs selection",
      });
      expect(unresolved).toHaveClass("border-s-destructive");
      expect(screen.getByRole("group", { name: "Fund Proposal: Matched" })).toHaveClass(
        "border-s-success",
      );
      expect(screen.getByRole("group", { name: "Fund Auto: Matched" })).toHaveClass(
        "border-s-success",
      );
      const order = () =>
        screen
          .getAllByRole("group", { name: /^Fund / })
          .map((element) => element.getAttribute("aria-label"));
      expect(order()).toEqual([
        "Fund Manual A: Needs selection",
        "Fund Manual B: Needs selection",
        "Fund Proposal: Matched",
        "Fund Auto: Matched",
      ]);
      expect(screen.getByText("Needs selection: 2")).toBeInTheDocument();
      await user.click(
        within(screen.getByRole("group", { name: "Fund Proposal: Matched" })).getByRole("combobox"),
      );
      await user.click(await screen.findByRole("option", { name: "Select the cash movement" }));
      expect(order()).toEqual([
        "Fund Proposal: Needs selection",
        "Fund Manual A: Needs selection",
        "Fund Manual B: Needs selection",
        "Fund Auto: Matched",
      ]);
      expect(screen.getByText("Matched: 1")).toBeInTheDocument();
      expect(parsed.securities.map((security) => security.name)).toEqual(names);
    },
  );

  it("parses selected XLS files locally and resets prepared source data when replaced", async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    const onPrepared = vi.fn();
    const file = new File(["xls bytes"], "operations.xls");
    file.arrayBuffer = vi.fn().mockResolvedValue(new TextEncoder().encode("xls bytes").buffer);

    render(
      <InversisImportPanel
        accounts={[account]}
        fundsAccountId={account.id}
        onPrepared={onPrepared}
        onReset={onReset}
      />,
    );

    await user.upload(screen.getByLabelText(/Inversis exports/), file);
    await waitFor(() =>
      expect(parseMyInvestorFiles).toHaveBeenCalledWith([
        { name: "operations.xls", content: "xls bytes" },
      ]),
    );
    await user.click(screen.getByRole("button", { name: "Prepare activities" }));
    expect(prepareMyInvestorImport).toHaveBeenCalledWith(
      { securities: [], movements: [], controls: [], diagnostics: [] },
      { fundsAccountId: "funds", matches: {} },
    );

    const replacement = new File(["new bytes"], "replacement.xls");
    replacement.arrayBuffer = vi
      .fn()
      .mockResolvedValue(new TextEncoder().encode("new bytes").buffer);
    await user.upload(screen.getByLabelText(/Inversis exports/), replacement);
    expect(onReset).toHaveBeenCalledTimes(3);
    expect(onPrepared).not.toHaveBeenCalled();
  });

  it("does not prepare with an unsupported funds account", async () => {
    const user = userEvent.setup();
    const file = new File(["xls bytes"], "operations.xls");
    file.arrayBuffer = vi.fn().mockResolvedValue(new TextEncoder().encode("xls bytes").buffer);
    render(
      <InversisImportPanel
        accounts={[{ ...account, currency: "USD" }]}
        fundsAccountId={account.id}
        onPrepared={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    await user.upload(screen.getByLabelText(/Inversis exports/), file);
    await waitFor(() => expect(parseMyInvestorFiles).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Prepare activities" })).toBeDisabled();
    expect(prepareMyInvestorImport).not.toHaveBeenCalled();
  });

  it("shows readable exact matches and preserves an explicit unmatch", async () => {
    const user = userEvent.setup();
    const movement = {
      source: { fileName: "movements.xls", rowIndex: 4, rowKey: "cash-key" },
      date: "2026-09-12",
      valueDate: "2026-09-12",
      operation: "COMPRA FONDOS",
      concept: "Fondo indexado",
      amount: "-25.00",
      currency: "EUR",
    };
    const security = {
      source: { fileName: "securities.xls", rowIndex: 2, rowKey: "security-key" },
      tradeDate: "2026-09-12",
      settlementDate: "2026-09-12",
      operationNumber: "1",
      market: "ES",
      operation: "Suscripción",
      isin: "ES0000000001",
      name: "Fondo indexado",
      quantity: "1.25",
      currency: "EUR",
      unitPrice: "20.00",
      amount: "25.00",
      activityType: "BUY",
    };
    const parsed = { securities: [security], movements: [movement], controls: [], diagnostics: [] };
    parseMyInvestorFiles.mockReturnValue(parsed);
    matchMyInvestorOperations.mockImplementation((_parsed, manualMatches = {}) => ({
      matches: Object.hasOwn(manualMatches, "security-key")
        ? manualMatches["security-key"]
          ? { "security-key": manualMatches["security-key"] }
          : {}
        : { "security-key": "cash-key" },
      proposals: {},
      suggestions: [
        {
          security: security.source,
          candidates: [
            {
              movement: movement.source,
              criteria: ["same-date", "same-amount"],
              evidence: {
                dateRelation: "settlement-value",
                nameMatch: "similar",
                nameScore: 0.82,
                amountDifference: "1.00",
                fxRate: "1.1",
              },
            },
          ],
        },
      ],
    }));
    const file = new File(["xls bytes"], "operations.xls");
    file.arrayBuffer = vi.fn().mockResolvedValue(new TextEncoder().encode("xls bytes").buffer);
    render(
      <InversisImportPanel
        accounts={[account]}
        fundsAccountId={account.id}
        onPrepared={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    await user.upload(screen.getByLabelText(/Inversis exports/), file);
    expect(
      await screen.findByRole("combobox", { name: /Match security operation/ }),
    ).toHaveTextContent("Change movement");
    expect(await screen.findByText("Matched automatically")).toBeInTheDocument();
    expect(screen.getAllByText("Fondo indexado")).toHaveLength(2);
    expect(screen.getByText("COMPRA FONDOS")).toBeInTheDocument();
    expect(screen.getByText(/Trade:.*Settlement:/)).toBeInTheDocument();
    expect(screen.getByText(/Operation:.*Value:/)).toBeInTheDocument();
    expect(screen.getByText(/securities\.xls.*Row 3/)).toBeInTheDocument();
    expect(screen.getByText(/movements\.xls.*Row 5/)).toBeInTheDocument();
    expect(screen.getByText(/Settlement date matches cash value date/)).toBeInTheDocument();
    expect(screen.getByText(/Similar instrument name/)).toBeInTheDocument();
    expect(screen.getByText(/Difference:/)).toBeInTheDocument();
    expect(screen.getByText(/Settlement exchange rate: 1 .+ = .+ /)).toBeInTheDocument();
    expect(screen.getAllByRole("combobox")[0]).not.toHaveTextContent("__single_account__");
    expect(screen.getByRole("combobox", { name: /Match security operation/ })).toHaveTextContent(
      "Change movement",
    );

    await user.click(screen.getByRole("combobox", { name: /Match security operation/ }));
    await user.click(await screen.findByRole("option", { name: /Select the cash movement/ }));
    await waitFor(() =>
      expect(matchMyInvestorOperations).toHaveBeenLastCalledWith(parsed, {
        "security-key": "",
      }),
    );
    expect(screen.queryByText("Matched automatically")).not.toBeInTheDocument();

    // A legacy heuristic could have promoted this apparently exact candidate despite the
    // explicit empty manual match. The preparation path must trust only deterministic matches.
    prepareMyInvestorImport.mockReturnValueOnce({
      drafts: [],
      diagnostics: [],
      controls: [],
      matchSuggestions: [
        {
          security: security.source,
          candidates: [
            {
              movement: movement.source,
              criteria: ["same-date", "same-amount", "same-name"],
            },
          ],
        },
      ],
    });
    await user.click(screen.getByRole("button", { name: "Prepare activities" }));
    expect(prepareMyInvestorImport).toHaveBeenCalledOnce();
    expect(prepareMyInvestorImport).toHaveBeenCalledWith(parsed, {
      fundsAccountId: "funds",
      matches: {},
    });
  });

  it("preselects rule proposals and allows clearing them before preparation", async () => {
    const user = userEvent.setup();
    const movement = {
      source: { fileName: "movements.xls", rowIndex: 4, rowKey: "cash-key" },
      date: "2026-09-12",
      valueDate: "2026-09-12",
      operation: "COMPRA FONDOS",
      concept: "Fondo indexado",
      amount: "-24.00",
      currency: "EUR",
    };
    const security = {
      source: { fileName: "securities.xls", rowIndex: 2, rowKey: "security-key" },
      tradeDate: "2026-09-12",
      settlementDate: "2026-09-12",
      operationNumber: "1",
      market: "ES",
      operation: "Suscripción",
      isin: "ES0000000001",
      name: "Fondo indexado",
      quantity: "1.25",
      currency: "EUR",
      unitPrice: "20.00",
      amount: "25.00",
      activityType: "BUY",
    };
    const parsed = { securities: [security], movements: [movement], controls: [], diagnostics: [] };
    parseMyInvestorFiles.mockReturnValue(parsed);
    matchMyInvestorOperations.mockImplementation((_parsed, manualMatches = {}) => ({
      matches: manualMatches["security-key"]
        ? { "security-key": manualMatches["security-key"] }
        : {},
      proposals: Object.hasOwn(manualMatches, "security-key") ? {} : { "security-key": "cash-key" },
      suggestions: [
        {
          security: security.source,
          candidates: [{ movement: movement.source, criteria: ["same-date", "same-name"] }],
        },
      ],
    }));
    const file = new File(["xls bytes"], "operations.xls");
    file.arrayBuffer = vi.fn().mockResolvedValue(new TextEncoder().encode("xls bytes").buffer);
    render(
      <InversisImportPanel
        accounts={[account]}
        fundsAccountId={account.id}
        onPrepared={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    await user.upload(screen.getByLabelText(/Inversis exports/), file);
    expect(await screen.findByText("Suggested cash movement")).toBeInTheDocument();
    expect(screen.getAllByText("Fondo indexado")).toHaveLength(2);
    const prepareButton = screen.getByRole("button", { name: "Prepare activities" });
    expect(screen.getByText("Rule suggestion")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Confirm match" })).not.toBeInTheDocument();
    await user.click(prepareButton);
    expect(prepareMyInvestorImport).toHaveBeenLastCalledWith(parsed, {
      fundsAccountId: "funds",
      matches: { "security-key": "cash-key" },
    });
    await user.click(screen.getByRole("combobox", { name: /Match security operation/ }));
    await user.click(await screen.findByRole("option", { name: "Select the cash movement" }));
    await user.click(prepareButton);
    expect(prepareMyInvestorImport).toHaveBeenLastCalledWith(parsed, {
      fundsAccountId: "funds",
      matches: {},
    });
  });

  it("blocks a legacy transfer conflict and renders calculated settlement checks", async () => {
    const user = userEvent.setup();
    const onPrepared = vi.fn();
    parseMyInvestorFiles.mockReturnValue({
      securities: [],
      movements: [],
      controls: [],
      diagnostics: [],
    });
    prepareMyInvestorImport.mockReturnValue(preparedWithLegacyProbe);
    checkActivitiesImport.mockResolvedValue([
      {
        lineNumber: 9,
        duplicateOfId: "existing-transfer",
        isValid: false,
        warnings: { _duplicate: ["duplicate"] },
      },
    ]);
    render(
      <InversisImportPanel
        accounts={[account, cashAccount]}
        fundsAccountId={account.id}
        onPrepared={onPrepared}
        onReset={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Cash account" }));
    await user.click(await screen.findByRole("option", { name: "Daily cash" }));
    await user.upload(screen.getByLabelText(/Inversis exports/), makeXlsFile());
    await screen.findByText("1 files selected");
    await user.click(screen.getByRole("button", { name: "Prepare activities" }));

    expect(
      await screen.findByText(/Existing transfers match the previous import format/),
    ).toBeInTheDocument();
    expect(screen.getByText(/€75\.00/)).toBeInTheDocument();
    expect(checkActivitiesImport).toHaveBeenCalledWith({
      activities: [
        expect.objectContaining({
          accountId: "cash",
          activityType: "TRANSFER_OUT",
          lineNumber: 9,
        }),
      ],
    });
    expect(screen.getByRole("button", { name: "Use these activities" })).toBeDisabled();
    expect(onPrepared).not.toHaveBeenCalled();
  });

  it.each([{}, null, undefined])(
    "allows an unconflicted legacy transfer with absent warnings (%s)",
    async (warnings) => {
      const user = userEvent.setup();
      const onPrepared = vi.fn();
      parseMyInvestorFiles.mockReturnValue({
        securities: [],
        movements: [],
        controls: [],
        diagnostics: [],
      });
      prepareMyInvestorImport.mockReturnValue(preparedWithLegacyProbe);
      checkActivitiesImport.mockResolvedValue([
        { lineNumber: 9, isValid: true, errors: null, warnings },
      ]);
      render(
        <InversisImportPanel
          accounts={[account, cashAccount]}
          fundsAccountId={account.id}
          onPrepared={onPrepared}
          onReset={vi.fn()}
        />,
      );

      await user.click(screen.getByRole("combobox", { name: "Cash account" }));
      await user.click(await screen.findByRole("option", { name: "Daily cash" }));
      await user.upload(screen.getByLabelText(/Inversis exports/), makeXlsFile());
      await screen.findByText("1 files selected");
      await user.click(screen.getByRole("button", { name: "Prepare activities" }));
      await user.click(await screen.findByRole("button", { name: "Use these activities" }));

      expect(onPrepared).toHaveBeenCalledWith(preparedWithLegacyProbe.drafts);
    },
  );

  it("fails closed when the legacy duplicate check fails", async () => {
    const user = userEvent.setup();
    const onPrepared = vi.fn();
    parseMyInvestorFiles.mockReturnValue({
      securities: [],
      movements: [],
      controls: [],
      diagnostics: [],
    });
    prepareMyInvestorImport.mockReturnValue(preparedWithLegacyProbe);
    checkActivitiesImport.mockRejectedValue(new Error("backend unavailable"));
    render(
      <InversisImportPanel
        accounts={[account, cashAccount]}
        fundsAccountId={account.id}
        onPrepared={onPrepared}
        onReset={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Cash account" }));
    await user.click(await screen.findByRole("option", { name: "Daily cash" }));
    await user.upload(screen.getByLabelText(/Inversis exports/), makeXlsFile());
    await screen.findByText("1 files selected");
    await user.click(screen.getByRole("button", { name: "Prepare activities" }));

    expect(await screen.findByText(/Previous transfers could not be checked/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use these activities" })).toBeDisabled();
    expect(onPrepared).not.toHaveBeenCalled();
  });

  it("fails closed when a validation row omits isValid", async () => {
    const user = userEvent.setup();
    parseMyInvestorFiles.mockReturnValue({
      securities: [],
      movements: [],
      controls: [],
      diagnostics: [],
    });
    prepareMyInvestorImport.mockReturnValue(preparedWithLegacyProbe);
    checkActivitiesImport.mockResolvedValue([
      { lineNumber: 9, errors: {}, warnings: { _duplicate: [] } },
    ]);
    render(
      <InversisImportPanel
        accounts={[account, cashAccount]}
        fundsAccountId={account.id}
        onPrepared={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Cash account" }));
    await user.click(await screen.findByRole("option", { name: "Daily cash" }));
    await user.upload(screen.getByLabelText(/Inversis exports/), makeXlsFile());
    await screen.findByText("1 files selected");
    await user.click(screen.getByRole("button", { name: "Prepare activities" }));

    expect(await screen.findByText(/Previous transfers could not be checked/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use these activities" })).toBeDisabled();
  });

  it("ignores a late duplicate-check response after the files change", async () => {
    const user = userEvent.setup();
    const onPrepared = vi.fn();
    let resolvePreflight: ((value: unknown) => void) | undefined;
    checkActivitiesImport.mockImplementation(
      () => new Promise((resolve) => (resolvePreflight = resolve)),
    );
    parseMyInvestorFiles.mockReturnValue({
      securities: [],
      movements: [],
      controls: [],
      diagnostics: [],
    });
    prepareMyInvestorImport.mockReturnValue(preparedWithLegacyProbe);
    render(
      <InversisImportPanel
        accounts={[account, cashAccount]}
        fundsAccountId={account.id}
        onPrepared={onPrepared}
        onReset={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Cash account" }));
    await user.click(await screen.findByRole("option", { name: "Daily cash" }));
    await user.upload(screen.getByLabelText(/Inversis exports/), makeXlsFile());
    await screen.findByText("1 files selected");
    await user.click(screen.getByRole("button", { name: "Prepare activities" }));
    await waitFor(() => expect(checkActivitiesImport).toHaveBeenCalled());

    await user.upload(
      screen.getByLabelText(/Inversis exports/),
      makeXlsFile("replacement.xls", "new bytes"),
    );
    resolvePreflight?.([{ lineNumber: 9, isValid: true, errors: {}, warnings: {} }]);
    await screen.findByText("1 files selected");
    expect(screen.queryByRole("button", { name: "Use these activities" })).not.toBeInTheDocument();
    expect(onPrepared).not.toHaveBeenCalled();
  });

  it("ignores a late duplicate-check response after a match association changes", async () => {
    const user = userEvent.setup();
    let resolvePreflight: ((value: unknown) => void) | undefined;
    checkActivitiesImport.mockImplementation(
      () => new Promise((resolve) => (resolvePreflight = resolve)),
    );
    const movement = {
      source: { fileName: "movements.xls", rowIndex: 4, rowKey: "cash-key" },
      date: "2026-09-12",
      valueDate: "2026-09-12",
      operation: "COMPRA FONDOS",
      concept: "Fondo indexado",
      amount: "-25.00",
      currency: "EUR",
    };
    const security = {
      source: { fileName: "securities.xls", rowIndex: 2, rowKey: "security-key" },
      tradeDate: "2026-09-12",
      settlementDate: "2026-09-12",
      operationNumber: "1",
      market: "ES",
      operation: "Suscripción",
      isin: "ES0000000001",
      name: "Fondo indexado",
      quantity: "1.25",
      currency: "EUR",
      unitPrice: "20.00",
      amount: "25.00",
      activityType: "BUY",
    };
    const parsed = { securities: [security], movements: [movement], controls: [], diagnostics: [] };
    parseMyInvestorFiles.mockReturnValue(parsed);
    prepareMyInvestorImport.mockReturnValue(preparedWithLegacyProbe);
    matchMyInvestorOperations.mockImplementation((_parsed, manualMatches = {}) => ({
      matches: Object.hasOwn(manualMatches, "security-key")
        ? manualMatches["security-key"]
          ? { "security-key": manualMatches["security-key"] }
          : {}
        : { "security-key": "cash-key" },
      proposals: {},
      suggestions: [
        {
          security: security.source,
          candidates: [
            {
              movement: movement.source,
              criteria: ["same-date", "same-amount", "same-name"],
              evidence: {
                dateRelation: "settlement-value",
                nameMatch: "exact",
                nameScore: 1,
              },
            },
          ],
        },
      ],
    }));
    render(
      <InversisImportPanel
        accounts={[account, cashAccount]}
        fundsAccountId={account.id}
        onPrepared={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Cash account" }));
    await user.click(await screen.findByRole("option", { name: "Daily cash" }));
    await user.upload(screen.getByLabelText(/Inversis exports/), makeXlsFile());
    await screen.findByText("1 files selected");
    await user.click(screen.getByRole("button", { name: "Prepare activities" }));
    await waitFor(() => expect(checkActivitiesImport).toHaveBeenCalled());

    await user.click(screen.getByRole("combobox", { name: /Match security operation/ }));
    await user.click(await screen.findByRole("option", { name: /Select the cash movement/ }));
    resolvePreflight?.([{ lineNumber: 9, isValid: true, errors: {}, warnings: {} }]);
    expect(screen.queryByRole("button", { name: "Use these activities" })).not.toBeInTheDocument();
  });
});
