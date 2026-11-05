import {
  disconnectLanSync,
  getLanSyncStatus,
  joinLanSync,
  startLanSyncHost,
  tickLanSync,
  updateLanSyncAddress,
} from "@/adapters";
import { usePlatform } from "@/hooks/use-platform";
import { useProfile } from "@/features/profiles/profile-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  useDateFormatting,
} from "@wealthfolio/ui";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsHeader } from "../settings-header";

export default function LanSyncPage() {
  const profileId = useProfile()?.profile?.id;
  // Switching profiles must discard an invitation immediately, including when
  // navigation keeps the settings screen mounted.
  return <LanSyncProfile key={profileId} profileId={profileId} />;
}

function LanSyncProfile({ profileId }: { profileId: string | undefined }) {
  const { t } = useTranslation();
  const formatting = useDateFormatting();
  const { isTauri, isMobile, loading } = usePlatform();
  const queryClient = useQueryClient();
  const { data: status, error: statusError } = useQuery({
    queryKey: ["lan-sync", profileId],
    queryFn: getLanSyncStatus,
    enabled: isTauri,
    refetchInterval: 3_000,
  });
  // Invitations are credentials: keep them in component memory, never in
  // React Query, URLs, logs or browser storage. Disconnect and unmount clear them.
  const [invitation, setInvitation] = useState("");
  const [hostInvitation, setHostInvitation] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: ["lan-sync"] });
    }
  };

  const scan = async () => {
    const scanner = await import("@tauri-apps/plugin-barcode-scanner");
    if (
      (await scanner.checkPermissions()) !== "granted" &&
      (await scanner.requestPermissions()) !== "granted"
    ) {
      throw new Error(t("sync:enterCode.cameraOpenError"));
    }
    const result = await scanner.scan({ windowed: false, formats: [scanner.Format.QRCode] });
    setInvitation(result.content);
  };

  return (
    <div className="space-y-6">
      <SettingsHeader heading={t("sync:lan.title")} text={t("sync:lan.description")} />
      {!isTauri ? (
        <p>{t("sync:lan.nativeOnly")}</p>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>
                {t(status?.role ? "sync:lan.status" : isMobile ? "sync:lan.join" : "sync:lan.host")}
              </CardTitle>
              <CardDescription>{t("sync:lan.instructions")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {status?.role && (
                <div className="space-y-2" aria-live="polite">
                  <p>{t(status.paired ? "sync:lan.paired" : "sync:lan.waiting")}</p>
                  {!status.ready && <p>{t("sync:lan.pending")}</p>}
                  {status.role === "host" && !status.listening && <p>{t("sync:lan.stopped")}</p>}
                  <p className="text-muted-foreground text-sm">
                    {t("sync:lan.lastSync")}{" "}
                    {status.lastSyncAt
                      ? formatting.formatDateTime(new Date(status.lastSyncAt), {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })
                      : "—"}
                  </p>
                  <p className="font-mono text-sm" dir="ltr">
                    {status.address}
                  </p>
                </div>
              )}
              {(!status?.role || status.role === "host") && !isMobile && (
                <>
                  <label className="block space-y-2">
                    <span>{t("sync:lan.address")}</span>
                    <Input
                      dir="ltr"
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      placeholder={status?.address ?? "192.168.1.10:18457"}
                    />
                  </label>
                  <Button
                    disabled={busy || loading}
                    onClick={() =>
                      void run(async () => {
                        setHostInvitation(await startLanSyncHost(address || undefined));
                      })
                    }
                  >
                    {t("sync:lan.start")}
                  </Button>
                  {hostInvitation && (
                    <div className="space-y-3">
                      <div className="w-fit rounded bg-white p-4">
                        <QRCodeSVG value={hostInvitation} size={224} level="M" />
                      </div>
                      <p className="text-sm">{t("sync:lan.privateCode")}</p>
                      <label className="block space-y-2">
                        <span>{t("sync:lan.invitation")}</span>
                        <textarea
                          className="border-input bg-background w-full rounded-md border p-3 font-mono text-xs"
                          dir="ltr"
                          readOnly
                          value={hostInvitation}
                          rows={3}
                          onFocus={(e) => e.target.select()}
                        />
                      </label>
                    </div>
                  )}
                </>
              )}
              {!status?.role && (
                <div className="space-y-3">
                  <p>{t("sync:lan.emptyProfile")}</p>
                  <label className="block space-y-2">
                    <span>{t("sync:lan.invitation")}</span>
                    <textarea
                      className="border-input bg-background w-full rounded-md border p-3 font-mono text-xs"
                      dir="ltr"
                      value={invitation}
                      onChange={(e) => setInvitation(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      rows={3}
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {isMobile && (
                      <Button variant="outline" disabled={busy} onClick={() => void run(scan)}>
                        {t("sync:lan.scan")}
                      </Button>
                    )}
                    <Button
                      disabled={busy || !invitation.trim()}
                      onClick={() =>
                        void run(async () => {
                          await joinLanSync(invitation.trim());
                          setInvitation("");
                          await queryClient.invalidateQueries();
                        })
                      }
                    >
                      {t("sync:lan.join")}
                    </Button>
                  </div>
                </div>
              )}
              {status?.role === "client" && (
                <div className="space-y-2">
                  <label htmlFor="lan-desktop-address">{t("sync:lan.address")}</label>
                  <Input
                    id="lan-desktop-address"
                    dir="ltr"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder={status.address ?? "192.168.1.10:18457"}
                  />
                  <Button
                    variant="outline"
                    disabled={busy || !address.trim()}
                    onClick={() => void run(() => updateLanSyncAddress(address.trim()))}
                  >
                    {t("sync:lan.saveAddress")}
                  </Button>
                </div>
              )}
              {status?.role && (
                <div className="flex flex-wrap gap-2">
                  <Button disabled={busy} onClick={() => void run(() => tickLanSync())}>
                    {t("sync:lan.syncNow")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await disconnectLanSync();
                        setInvitation("");
                        setHostInvitation("");
                        setAddress("");
                      })
                    }
                  >
                    {t("sync:lan.disconnect")}
                  </Button>
                </div>
              )}
              {busy && <p role="status">{t("sync:lan.working")}</p>}
              {(error || status?.error || statusError) && (
                <p className="text-destructive text-sm" role="alert">
                  {error || status?.error || String(statusError)}
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
