import { render, screen, waitFor } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { SantanderPensionPanel } from "./santander-pension-panel";
const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../utils/import-sources/santander-pension-pdf", () => ({ readSantanderPensionPdf: read }));
vi.mock("../utils/import-sources/santander-pension", () => ({
  parseSantanderPension: (_page: unknown, accountId: string) => ({
    name: "Example pension",
    closingDate: "2026-03-31",
    closingUnits: "10",
    closingPrice: "2",
    closingValue: "20",
    symbol: "SANPP001001",
    drafts: [
      {
        accountId,
        activityDate: "2026-01-01",
        symbol: "SANPP001001",
        comment: "Contribution",
        amount: "20",
      },
    ],
  }),
  prepareSantanderPension: (statements: { drafts: unknown[] }[]) => ({
    statements,
    drafts: statements.flatMap((item) => item.drafts),
  }),
}));
beforeEach(() => {
  read.mockReset();
  read.mockResolvedValue({});
});
it.each(["ltr", "rtl"])(
  "previews the closing value and hands only plan activities to review (%s)",
  async (dir) => {
    const user = userEvent.setup(),
      prepared = vi.fn(),
      reset = vi.fn();
    render(
      <div dir={dir}>
        <SantanderPensionPanel accountId="pension" onPrepared={prepared} onReset={reset} />
      </div>,
    );
    await user.upload(
      screen.getByLabelText("Quarterly statements (.pdf)"),
      new File(["pdf"], "statement.pdf", { type: "application/pdf" }),
    );
    await user.click(await screen.findByRole("button", { name: "Use these activities" }));
    expect(screen.getByText(/2\.00000 EUR/)).toBeInTheDocument();
    expect(reset).toHaveBeenCalled();
    expect(prepared).toHaveBeenCalledWith(
      [expect.objectContaining({ accountId: "pension" })],
      [expect.objectContaining({ date: "2026-03-31", price: "2" })],
    );
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  },
);
it("blocks an unreadable PDF without handing partial activities to the wizard", async () => {
  read.mockRejectedValue(new Error("pdf-layout"));
  const user = userEvent.setup(),
    prepared = vi.fn();
  render(<SantanderPensionPanel accountId="pension" onPrepared={prepared} onReset={vi.fn()} />);
  await user.upload(
    screen.getByLabelText("Quarterly statements (.pdf)"),
    new File(["pdf"], "bad.pdf", { type: "application/pdf" }),
  );
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("pdf-layout"));
  expect(prepared).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Use these activities" })).not.toBeInTheDocument();
});
