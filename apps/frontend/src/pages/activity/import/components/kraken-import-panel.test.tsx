import { AccountType } from "@/lib/constants";
import type { Account } from "@/lib/types";
import { act, render, screen, waitFor } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KrakenImportPanel } from "./kraken-import-panel";

const { parseCsv, prepareKrakenImport } = vi.hoisted(() => ({
  parseCsv: vi.fn(),
  prepareKrakenImport: vi.fn(),
}));
vi.mock("@/adapters", () => ({ parseCsv }));
vi.mock("../utils/import-sources/kraken", () => ({ prepareKrakenImport }));

const account: Account = {
  id: "kraken",
  name: "Kraken",
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
const wallet = { ...account, id: "wallet", name: "My wallet" };

describe("KrakenImportPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prepareKrakenImport.mockReturnValue({ drafts: [], balances: [], purchases: 0 });
  });

  it.each(["ltr", "rtl"])(
    "locks the destination until parsing completes (%s)",
    async (direction) => {
      const user = userEvent.setup();
      let complete!: (value: { headers: string[]; rows: string[][] }) => void;
      parseCsv.mockReturnValue(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      render(
        <div dir={direction}>
          <KrakenImportPanel
            accounts={[account, wallet]}
            accountId={account.id}
            onPrepared={vi.fn()}
            onReset={vi.fn()}
          />
        </div>,
      );
      await user.click(screen.getByRole("combobox"));
      await user.click(await screen.findByRole("option", { name: wallet.name }));
      await user.upload(
        screen.getByLabelText(/CSV/),
        new File(["csv"], "ledger.csv", { type: "text/csv" }),
      );
      expect(screen.getByRole("combobox")).toBeDisabled();
      await act(async () => {
        complete({ headers: [], rows: [] });
        await Promise.resolve();
      });
      await waitFor(() => expect(screen.getByRole("combobox")).not.toBeDisabled());
      expect(prepareKrakenImport).toHaveBeenCalledWith(
        [{ headers: [], rows: [] }],
        account.id,
        wallet.id,
        account.currency,
      );
    },
  );

  it("passes the selected account currency and does not require a wallet before reading", async () => {
    const user = userEvent.setup();
    const usdAccount = { ...account, currency: "USD" };
    parseCsv.mockResolvedValue({ headers: [], rows: [] });
    render(
      <KrakenImportPanel
        accounts={[usdAccount, wallet]}
        accountId={account.id}
        onPrepared={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    await user.upload(
      screen.getByLabelText(/CSV/),
      new File(["csv"], "ledger.csv", { type: "text/csv" }),
    );
    await waitFor(() =>
      expect(prepareKrakenImport).toHaveBeenCalledWith(
        [{ headers: [], rows: [] }],
        account.id,
        "",
        "USD",
      ),
    );
    await user.click(screen.getByRole("combobox"));
    expect(await screen.findByRole("option", { name: wallet.name })).toBeVisible();
  });

  it.each(["success", "failure"])(
    "ignores an old parse %s after leaving the account",
    async (outcome) => {
      const user = userEvent.setup();
      let fail!: (reason: Error) => void;
      let complete!: (value: { headers: string[]; rows: string[][] }) => void;
      parseCsv.mockReturnValue(
        new Promise((resolve, reject) => {
          complete = resolve;
          fail = reject;
        }),
      );
      const onReset = vi.fn();
      const { unmount } = render(
        <KrakenImportPanel
          accounts={[account, wallet]}
          accountId={account.id}
          onPrepared={vi.fn()}
          onReset={onReset}
        />,
      );
      await user.click(screen.getByRole("combobox"));
      await user.click(await screen.findByRole("option", { name: wallet.name }));
      await user.upload(
        screen.getByLabelText(/CSV/),
        new File(["csv"], "ledger.csv", { type: "text/csv" }),
      );
      const resets = onReset.mock.calls.length;
      unmount();
      await act(async () => {
        if (outcome === "success") complete({ headers: [], rows: [] });
        else fail(new Error("old-account-error"));
        await Promise.resolve();
      });
      expect(onReset).toHaveBeenCalledTimes(resets);
      expect(prepareKrakenImport).not.toHaveBeenCalled();
    },
  );
});
