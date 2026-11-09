import { isTauri, tickLanSync } from "@/adapters";
import { useEffect } from "react";
import { useProfile } from "@/features/profiles/profile-context";

/** Mobile OS suspension is respected: resume and foreground retry the durable queue. */
export function useLanSyncTrigger(enabled: boolean) {
  const profileId = useProfile()?.profile?.id;
  useEffect(() => {
    if (!enabled || !isTauri) return;
    let running = false;
    const tick = () => {
      if (running || document.visibilityState !== "visible") return;
      running = true;
      // The backend records connection errors for Settings; do not toast on
      // every tick while the desktop is asleep or the phone is away from home.
      void tickLanSync()
        .catch(() => {
          // The backend exposes this failure in the Wi-Fi settings status.
        })
        .finally(() => {
          running = false;
        });
    };
    tick();
    const timer = window.setInterval(tick, 15_000);
    window.addEventListener("focus", tick);
    window.addEventListener("online", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
      window.removeEventListener("online", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [enabled, profileId]);
}
