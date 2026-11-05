import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLanSyncTrigger } from "./use-lan-sync-trigger";

const mocks = vi.hoisted(() => ({ isTauri: true, tickLanSync: vi.fn() }));
vi.mock("@/adapters", () => mocks);
const visible = (value: DocumentVisibilityState) =>
  Object.defineProperty(document, "visibilityState", { configurable: true, value });

describe("Wi-Fi foreground sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.isTauri = true;
    mocks.tickLanSync.mockResolvedValue(undefined);
    visible("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not invoke native sync when disabled or in the browser", () => {
    const hook = renderHook(({ enabled }) => useLanSyncTrigger(enabled), {
      initialProps: { enabled: false },
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
      window.dispatchEvent(new Event("online"));
    });
    expect(mocks.tickLanSync).not.toHaveBeenCalled();
    mocks.isTauri = false;
    hook.rerender({ enabled: true });
    expect(mocks.tickLanSync).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("waits for the current attempt, retries after failure and cleans up", async () => {
    let fail!: (reason: Error) => void;
    mocks.tickLanSync.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    );
    const hook = renderHook(() => useLanSyncTrigger(true));
    act(() => {
      vi.advanceTimersByTime(60_000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(mocks.tickLanSync).toHaveBeenCalledTimes(1);
    await act(async () => {
      fail(new Error("desktop asleep"));
      await Promise.resolve();
    });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
    });
    expect(mocks.tickLanSync).toHaveBeenCalledTimes(2);
    visible("hidden");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(mocks.tickLanSync).toHaveBeenCalledTimes(2);
    visible("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(mocks.tickLanSync).toHaveBeenCalledTimes(3);
    hook.unmount();
    act(() => {
      vi.advanceTimersByTime(60_000);
      window.dispatchEvent(new Event("online"));
    });
    expect(mocks.tickLanSync).toHaveBeenCalledTimes(3);
  });
});
