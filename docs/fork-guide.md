# Fork guide

[Back to the fork README](../README.md)

## MyInvestor / Inversis

Create an EUR investment account with transaction tracking for securities, and a
separate EUR cash account for bank movements. Start from the investment account,
choose **MyInvestor / Inversis**, select the cash account and load the Inversis
exports together:

- `movimientos.xls`: bank movements and statement balance controls.
- `operaciones valores.xls`: security operations, including units and price.
- `valores.xls`: additional security operations, such as stock trades.

Files are recognized by their table contents rather than their names; a values
export supplies operations, not an opening holdings snapshot.

Review the operation/cash matches. Rules use amounts, currency, instrument
information, operation dates and value/settlement dates. Unresolved cases appear
first. Optional **Analyze with AI** sends relevant import data to the chosen
provider only when requested; choosing a cloud provider sends that data outside
the device. Suggestions are preselected and remain editable.

Prepare activities and check the cash reconciliation, then choose **Use these
activities**. Continue through asset review, activity review and final import.
The existing engine receives internal cash transfers to fund purchases; do not
import each export separately into its own account.

Source identifiers such as ISINs and provider quote symbols serve different
purposes. Check the asset selected during review rather than assuming its quote
symbol must equal the ISIN. Differences between source units × price and cash
amount are preserved with original figures and source information in purchase
details; they can require approval after import. Approval keeps that
information.

This importer targets the tested Inversis XLS layout. Legacy MyInvestor CSV
exports are not interchangeable with these XLS files.

## Santander pension plans

Create an EUR **Securities** account with **Transactions** tracking for the
plan. Choose **Santander pensions (PDF)** and load the quarterly statements. The
parser accepts the tested single-page table format, up to 12 PDFs and 20 MB per
file. Text extraction and OCR run locally.

Statements can be imported independently; previous quarters are not required
each time. Each statement must pass its own closing controls. Source opening
balances are controls, not invented acquisition history or opening activities.
When starting mid-history, the statement's opening balance alone does not create
the earlier holdings.

Contributions create funding and purchases inside the pension account. Incoming
plan transfers create units without a bank debit. No salary or bank account is
charged. Review the proposed manual plan asset and its statement closing price
before importing. Conflicting existing manual prices need review. Existing
duplicate checks apply when statements overlap.

## Kraken spot

Create a **Crypto** account with **Transactions** tracking for Kraken. For
crypto withdrawals to your own wallet, create a second **Crypto / Transactions**
account and select it as the wallet destination. Securities accounts with
transaction tracking are also supported. Accounts can use different base
currencies; EUR is not required.

Choose **Kraken**, load the spot **ledgers** CSV and optionally add the spot
**trades** CSV. The ledger determines balances and fees; trades supplement and
validate trade details. Balances alone cannot reconstruct activities.

Supported mappings include:

- Crypto purchases and sales against recognized fiat currencies, retaining the
  original transaction currency and net cash amount.
- Fiat deposits and withdrawals.
- Explicit fiat conversions as two internal cash movements, linked by
  Wealthfolio's existing import service.
- Crypto withdrawals to the selected owned wallet as matched unit transfers.
- Crypto withdrawal fees as separate `FEE_IN_KIND` activities, reducing crypto
  units without a second cash debit and preserving the source USD fee valuation.

Account currency is its valuation currency; buying BTC in USD does not require a
separate BTC asset from buying it in EUR. Wallet transfers preserve acquisition
cost through the existing engine. A wallet is required only when the input
contains crypto withdrawals.

Crypto-to-crypto swaps and unmapped activity types are explicitly unsupported.
This parser targets the rich spot export layout used in the fixtures, not
futures or every historical Kraken CSV schema. Real EUR/BTC exports have been
reconciled; USD, mixed-currency and other crypto scenarios have synthetic
regression coverage.

## Custom AI endpoint

In **Settings > AI providers**, enable **Custom (OpenAI-compatible)**, enter the
base URL, refresh models and enable the desired model. Supply an API key only if
the endpoint requires one. Credentials use the app's existing secret store.

For example, Strata exposing the OpenAI API on the desktop can use
`http://127.0.0.1:8080/v1`. On Android, `127.0.0.1` means the phone: use the
desktop's reachable LAN address instead. Portfolio sync does not make a
desktop-only endpoint reachable or copy provider credentials to the phone.

Inversis matching uses the model selected in its analysis panel. Loading files
alone does not invoke the model. Output must pass identifier, uniqueness and
financial consistency checks; associations remain editable before importing.
Performance depends on the server and model. Chat Tools capabilities are not
required for this matching task.

## Wi-Fi sync

Use this fork on both devices and join from an empty mobile profile. Existing
mobile portfolio data is kept rather than overwritten; create a new profile if
necessary. Changes can be made on either device after pairing. Keep the desktop
open and unlocked and the mobile app active for exchange.

For pairing limits, security boundaries and setup, see the
[LAN sync guide](architecture/lan-device-sync.md). This is separate from
Wealthfolio Connect and does not make the mobile app read-only.

## Documentation screenshots

Use synthetic statements and demonstration profiles. Capture the current UI,
including a mobile view when useful, in the app's normal theme. Suggested
images:

- Wi-Fi pairing and sync status, concealing invitations and QR codes.
- Inversis operation/cash comparisons and editable suggested matches.
- Statement balance checks and the prepared import summary.
- Custom AI endpoint and model selection, concealing credentials.

Do not publish names, account numbers, real portfolio balances, API keys,
pairing secrets or usable QR invitations. Strip image metadata and inspect the
final image before committing it. Store future assets in `docs/images/fork/`,
with descriptive alt text and short captions. The current
[screenshot set and capture notes](images/fork/README.md) use synthetic data;
existing personal screenshots have not been copied into the repository.

## Architecture impact

This documentation update changes no runtime, network calls, provider settings,
persistence, events, retries or user-edit precedence. The importers reuse the
existing review and accounting pipeline; AI transmission remains an explicit
user action. The LAN guide describes the separate transport added by Wi-Fi sync.
