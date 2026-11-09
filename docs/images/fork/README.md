# Fork screenshots

Captured on 2026-11-09 from the current React components using a temporary,
isolated Vite page and headless Chrome at a 1280-pixel viewport, with local
fonts and the default light theme. The temporary capture page and service stubs
were removed after capture; no runtime application code was changed.

| Image                                             | Actual component and demonstration state                                                                                                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Inversis matching](inversis-matching.png)        | `InversisImportPanel`, including `InversisAiMatching` and `InversisMatchCard`; two synthetic fund purchases, one exact name and one abbreviated name producing a rule suggestion. The image is cropped after the first match card. |
| [Prepared Inversis import](inversis-prepared.png) | The same panel after preparation: EUR500 deposited, EUR350 invested, EUR150 left in cash and zero investment-account cash. Seven activities include both internal transfer pairs.                                                  |
| [Kraken wallet](kraken-wallet.png)                | `KrakenImportPanel` after reading a synthetic ledger: EUR1000 deposit, EUR500 purchase of 0.005 BTC, transfer of 0.002 BTC and 0.00001 BTC fee. Five activities; closing balances EUR500 and 0.00299 BTC.                          |
| [Wi-Fi sync](wifi-sync.png)                       | `LanSyncPage` supplied with a simulated paired, ready desktop status. `192.0.2.10` is a documentation address, not a real host. No QR code or invitation is shown.                                                                 |

The Inversis and Kraken parsers and UI ran normally against generated input.
Platform, profile, duplicate-check and AI-provider dependencies were replaced
with documentation-only stubs; CSV reading returned the synthetic rows in the
adapter's usual shape. No real profile, database, native command or provider was
accessed. Browser requests outside the local documentation server were blocked.
The Inversis continuation button was checked to be enabled after reconciliation.
Each final image was visually inspected.

The AI selector shows a fictitious configured model. The screenshots do not show
an inference result, a real device exchange or a persisted import and should not
be treated as end-to-end test evidence.

All names, identifiers, statements, amounts and connection status are synthetic.
The PNGs are direct browser captures without source document or personal photo
metadata. Personal screenshots supplied during development were not used.
