# Local Wi-Fi device sync

This fork adds an opt-in, encrypted, one-to-one connection between a desktop
profile and a native mobile profile. The desktop listens only while its profile
is unlocked. Both devices keep their own SQLite database and exchange the
existing transactional outbox events. Connect accounts and subscriptions are not
used. Connect device sync and LAN sync must not share a profile.

## Architecture impact

Reuse the existing snapshot export/restore, authenticated encryption, event IDs,
transactional outbox, replay validation, conflict rules and portfolio
recalculation events. Add an explicit LAN listener and client, one paired-device
configuration in SecretStore, and encrypted request/response envelopes. A cycle
mutex prevents two simultaneous exchanges acknowledging each other's batches.
Events are acknowledged only after the receiving database commits them. Network
failures leave events pending for idempotent retry. No relay or new financial
database is needed.

The initial snapshot's exact outbox boundary is captured in the same database
transaction as its rows. The receiving profile retains a pending acknowledgement
in its existing local settings until the desktop confirms it. This prevents a
crash after import from causing either a repeated destructive import or an
acknowledgement of newer desktop writes the mobile never received. The setting
contains event IDs, not the pairing secret, and is excluded from sync snapshots.
The existing sync lifecycle mutex serializes cycles and Connect transitions.
Connect reset/rebind actions refuse to clear a live LAN outbox.

Initial joining is allowed only into an empty profile. It imports the desktop's
existing filtered sync snapshot; it never silently replaces a populated mobile
portfolio. Subsequent exchanges use changes in both directions. Keep the desktop
app open and unlocked. Foreground polling and resume trigger reconnects; mobile
operating systems may suspend the app in the background.

The invitation contains a private IPv4 address, port and random 256-bit secret.
Transfer it privately between your own devices. Payloads are authenticated and
encrypted before HTTP; the secret is never sent in URLs, headers or plaintext
requests. Connections reject public addresses, proxies and redirects. Changing
Wi-Fi/IP requires updating the desktop address on the mobile device. The first
version intentionally supports one paired mobile per desktop, manual address
entry and QR scanning, without mDNS or an Internet relay. Existing market-data
providers retain their own behavior; this feature changes only device transport.

## Trying it

Use the same fork build on both devices. The store app cannot join this
protocol.

1. Start desktop development with `pnpm tauri dev`. It uses the existing
   development identifier and a separate local profile store.
2. Open **Settings > Wi-Fi sync**, select the desktop's Wi-Fi IPv4 address if
   automatic selection picked a VPN/other adapter, then start sharing. The
   default port is 18457. Allow the desktop executable on the private network if
   Windows Firewall asks.
3. Build Android with
   `pnpm tauri android build --debug --apk --target aarch64 --ci`. The debug APK
   is **Wealthfolio LAN**, with application ID `com.teymz.wealthfolio.lan`; it
   can coexist with the original store app.
4. In an empty Android profile, open the same setting, scan the QR or paste the
   invitation, and select **Join desktop**. Keep both devices on the same LAN
   for the initial import.
5. Changes made offline remain queued. While the mobile app is visible it
   retries every 15 seconds, on focus, on resume and on browser network-online
   events. **Sync now** also triggers an exchange. A desktop host listens while
   unlocked even when its window is not focused.

If the desktop IP changes, start the host on its new address and update the
address on the mobile; keep the pairing key. To replace the mobile, disconnect
on the desktop and generate a new invitation. Disconnecting keeps local
portfolio data. A populated mobile profile cannot be joined to a new desktop;
use a new empty profile. Provider credentials and installation-local settings
remain local, as in the upstream sync table filters.

The Android project currently targets SDK 36. Local connections use its existing
INTERNET permission. When moving to target SDK 37, implement Android's
ACCESS_LOCAL_NETWORK runtime permission before raising the target.

## Checks

Focused tests:

```sh
cargo test --locked -p wealthfolio-device-sync lan::tests
cargo test --locked -p wealthfolio-storage-sqlite lan_ -- --test-threads=1
cargo test --locked -p wealthfolio-app --lib commands::lan_sync::tests -- --test-threads=1
pnpm --filter frontend exec vitest run src/features/lan-sync/use-lan-sync-trigger.test.tsx src/pages/settings/lan-sync/lan-sync-page.test.tsx src/adapters/adapter-command-parity.test.ts
```

Validation must cover tampering, wrong keys, response/request binding, public
address rejection, retry after lost responses, duplicate events, initial import
and offline changes in both directions. Native device and firewall behavior
requires a real desktop/mobile pair; automated loopback checks cannot prove it.
