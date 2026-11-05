import { openUrlInBrowser } from "@/adapters";
import { sourceReconciliationFixture } from "@/test/fixtures/source-reconciliation";
import { render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivitySourceReconciliation } from "./activity-source-reconciliation";

const state = vi.hoisted(() => ({ hidden: false }));
vi.mock("@/adapters", () => ({ openUrlInBrowser: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: state.hidden }),
}));

describe("original source reconciliation", () => {
  beforeEach(() => {
    state.hidden = false;
    vi.clearAllMocks();
  });
  it.each(["ltr", "rtl"])(
    "remains visible after approval and opens the stored reference (%s)",
    async (dir) => {
      const activity = {
        needsReview: true,
        metadata: { source_reconciliation: sourceReconciliationFixture },
      };
      const { rerender } = render(
        <div dir={dir}>
          <ActivitySourceReconciliation activity={activity} />
        </div>,
      );
      expect(screen.getByText("Needs Review")).toBeVisible();
      rerender(
        <div dir={dir}>
          <ActivitySourceReconciliation activity={{ ...activity, needsReview: false }} />
        </div>,
      );
      expect(screen.getByText("Reviewed")).toBeVisible();
      expect(screen.getByText("+0.02 EUR")).toBeVisible();
      expect(screen.getByText("49.98 EUR")).toBeVisible();
      expect(screen.getByText("TEST-1")).toBeVisible();
      await userEvent.click(screen.getByRole("button", { name: "Related discussion (Rankia)" }));
      expect(openUrlInBrowser).toHaveBeenCalledWith(sourceReconciliationFixture.referenceUrl);
    },
  );
  it("hides original amounts under balance privacy", () => {
    state.hidden = true;
    render(
      <ActivitySourceReconciliation
        activity={{
          needsReview: false,
          metadata: { source_reconciliation: sourceReconciliationFixture },
        }}
      />,
    );
    expect(screen.queryByText(/49\.98/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0\.02/)).not.toBeInTheDocument();
  });
  it("does not render malformed metadata or open untrusted links", () => {
    render(
      <ActivitySourceReconciliation
        activity={{
          needsReview: false,
          metadata: {
            source_reconciliation: {
              ...sourceReconciliationFixture,
              referenceUrl: "javascript:alert(1)",
            },
          },
        }}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
