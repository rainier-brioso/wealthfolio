import { render, screen } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftActivity } from "../context";
import { ReviewStep } from "./review-step";

const { useImportContextMock, gridMock } = vi.hoisted(() => ({
  useImportContextMock: vi.fn(),
  gridMock: vi.fn<(props: { drafts: DraftActivity[] }) => void>(),
}));

vi.mock("../context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../context")>()),
  useImportContext: useImportContextMock,
}));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ accounts: [] }) }));
vi.mock("../components/import-review-grid", () => ({
  ImportReviewGrid: (props: { drafts: DraftActivity[] }) => {
    gridMock(props);
    return <div data-testid="review-grid">{props.drafts.length} prepared activities</div>;
  },
}));

describe("ReviewStep import sources", () => {
  const draft: DraftActivity = {
    rowIndex: 0,
    rawRow: [],
    activityDate: "2026-07-01",
    currency: "EUR",
    activityType: "BUY",
    accountId: "funds",
    symbol: "IE000ZYRH0Q7",
    status: "warning",
    errors: {},
    warnings: {},
    isEdited: false,
  };

  function setState(overrides: Record<string, unknown> = {}) {
    useImportContextMock.mockReturnValue({
      state: {
        sourceImport: { sourceId: "myinvestor-inversis" },
        parsedRows: [],
        mapping: null,
        draftActivities: [draft],
        draftRevision: 1,
        lastValidatedRevision: 1,
        ...overrides,
      },
      dispatch: vi.fn(),
      validateDrafts: vi.fn(),
    });
  }

  beforeEach(() => {
    gridMock.mockClear();
    setState();
  });

  it.each(["ltr", "rtl"])(
    "reviews prepared Inversis activities without CSV rows or mapping (%s)",
    (dir) => {
      render(
        <div dir={dir}>
          <ReviewStep />
        </div>,
      );
      expect(screen.getByTestId("review-grid")).toHaveTextContent("1 prepared activities");
      expect(gridMock.mock.lastCall?.[0].drafts).toEqual([draft]);
      expect(screen.queryByText("No Data")).not.toBeInTheDocument();
    },
  );

  it("keeps the empty-source guard", () => {
    setState({ draftActivities: [] });
    render(<ReviewStep />);
    expect(screen.getByText("No Data")).toBeInTheDocument();
    expect(gridMock).not.toHaveBeenCalled();
  });

  it("still requires CSV data for CSV imports", () => {
    setState({ sourceImport: null });
    render(<ReviewStep />);
    expect(screen.getByText("No Data")).toBeInTheDocument();
  });

  it("still requires mapping for CSV imports", () => {
    setState({ sourceImport: null, parsedRows: [["2026-07-01", "BUY"]] });
    render(<ReviewStep />);
    expect(screen.queryByTestId("review-grid")).not.toBeInTheDocument();
    expect(gridMock).not.toHaveBeenCalled();
    expect(screen.queryByText("No Data")).not.toBeInTheDocument();
  });
});
