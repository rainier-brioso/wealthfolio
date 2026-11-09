import { fireEvent, render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import type { LanSyncStatus } from "@/adapters/lan-sync-types";
import LanSyncPage from "./lan-sync-page";

const mocks = vi.hoisted(() => ({
  mobile: false,
  native: true,
  profile: "a",
  status: vi.fn(),
  start: vi.fn(),
  join: vi.fn(),
  tick: vi.fn(),
  update: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock("@/adapters", () => ({
  getLanSyncStatus: mocks.status,
  startLanSyncHost: mocks.start,
  joinLanSync: mocks.join,
  tickLanSync: mocks.tick,
  updateLanSyncAddress: mocks.update,
  disconnectLanSync: mocks.disconnect,
}));
vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({ isTauri: mocks.native, isMobile: mocks.mobile, loading: false }),
}));
vi.mock("@/features/profiles/profile-context", () => ({
  useProfile: () => ({ profile: { id: mocks.profile } }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../settings-header", () => ({
  SettingsHeader: ({ heading }: { heading: string }) => <h1>{heading}</h1>,
}));

const unpaired: LanSyncStatus = {
  role: null,
  listening: false,
  address: null,
  paired: false,
  ready: false,
  lastSyncAt: null,
  error: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.mobile = false;
  mocks.native = true;
  mocks.profile = "a";
  mocks.status.mockResolvedValue(unpaired);
});
function mount(rtl = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const element = () => (
    <div dir={rtl ? "rtl" : "ltr"}>
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <LanSyncPage />
        </QueryClientProvider>
      </MemoryRouter>
    </div>
  );
  const view = render(element());
  return { client, ...view, rerenderPage: () => view.rerender(element()) };
}

it("shows an explicit native-only message in the browser without calling native commands", () => {
  mocks.native = false;
  mount();
  expect(screen.getByText("sync:lan.nativeOnly")).toBeInTheDocument();
  expect(mocks.status).not.toHaveBeenCalled();
});

it("generates the desktop QR only on request and keeps the credential out of the query cache", async () => {
  const invitation = "wealthfolio-lan-v1:private-test-credential";
  mocks.start.mockResolvedValue(invitation);
  const { client, rerenderPage } = mount(true);
  await waitFor(() => expect(mocks.status).toHaveBeenCalled());
  expect(mocks.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "sync:lan.start" }));
  expect(await screen.findByDisplayValue(invitation)).toHaveAttribute("readonly");
  expect(screen.getByText("sync:lan.privateCode")).toBeInTheDocument();
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    ),
  ).not.toContain(invitation);
  mocks.profile = "b";
  rerenderPage();
  expect(screen.queryByDisplayValue(invitation)).not.toBeInTheDocument();
});

it("lets Android join, then offers retry and disconnect when the desktop is unavailable", async () => {
  mocks.mobile = true;
  mocks.join.mockImplementation(() => {
    mocks.status.mockResolvedValue({
      ...unpaired,
      role: "client",
      paired: true,
      address: "192.168.1.2:18457",
      error: "Desktop unavailable",
    });
    return Promise.reject(new Error("Desktop unavailable"));
  });
  mocks.disconnect.mockImplementation(() => {
    mocks.status.mockResolvedValue(unpaired);
    return Promise.resolve();
  });
  mount(true);
  expect(screen.getByText("sync:lan.emptyProfile")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "sync:lan.start" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("sync:lan.invitation"), {
    target: { value: "private-invitation" },
  });
  fireEvent.click(screen.getByRole("button", { name: "sync:lan.join" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Desktop unavailable");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "sync:lan.syncNow" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "sync:lan.disconnect" }));
  await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.getByRole("button", { name: "sync:lan.join" })).toBeDisabled());
});
