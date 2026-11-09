# CSV mapping defaults and calculated price

Imports use the original Wealthfolio account selection, CSV mapping, asset
resolution, row review, duplicate checks and confirmation. Cash and securities
accounts keep their normal account-specific import profiles.

## MyInvestor / Inversis source import

The upload screen offers an Inversis mode for EUR transaction-tracked investment
accounts. It reads the HTML reports exported with an `.xls` extension locally,
using Windows-1252 decoding. Cash movements and security operation files are
parsed separately, then prepared together. No addon installation is required.

Prepared records enter the existing draft, asset-resolution, validation, review
and confirmation path directly, skipping CSV mapping. Source import state is
transient; changing inputs invalidates prepared drafts. The generic CSV path
continues to use its existing mapping and templates.

Cash statement opening and closing rows are control values rather than activities.
Each statement must reconcile before it can be prepared. Opening cash is not
created automatically. Security operations preserve quantity, supplied net price,
currency and operation references. A purchase and its cash charge represent one
settlement: importing both as independent debits would double-count cash.

Matching prioritizes cash value date against security settlement date. Trade
date against cash operation date is a fallback for review, not an equivalent
cross-comparison. It filters by type and direction before checking uniqueness on
both sides. Exact instrument, primary date, currency and amount matches can be
accepted automatically. Similar names and fallback dates generate proposals for
review; generic fund words and conflicting class/currency/hedging terms
must not establish identity. Ties and competing proposals remain manual.
Manual choices reserve their cash row; explicitly clearing a choice prevents
automatic reselection. A cash movement cannot finance multiple operations.
Dropdowns and proposal evidence show readable labels, both source dates,
amount differences and observed FX where applicable.
The panel preselects rule proposals and validated AI proposals alongside exact
matches. All selected pairs count as matched; their rule/AI origin stays visible.
Unresolved rows appear first, then selected proposals, then exact/manual matches,
preserving source order within each group. Users can change or clear any selection.
The selected bank debit determines the final settlement amount; a different
security net amount is reported without inventing a commission. USD trades matched
to EUR cash retain their native values and use the observed settlement ratio via
the existing activity-to-account FX rate. Unsupported operations and invalid
records produce blocking diagnostics.

Cash may use the same investment account or a separate EUR cash account. Separate
accounts use ordinary internal transfer legs in the same import batch. The
existing core transfer linker, final-cash calculations and semantic duplicate
checks remain authoritative. Reimport does not repair earlier partial imports.

Both legs of generated transfers carry a stable operation reference so distinct
same-date, same-amount purchases do not collide with each other. Before accepting
a separate-account preparation, original-comment transfer probes are checked
through the existing read-only import validation API. A match to a stored legacy
transfer blocks preparation for review; failed or incomplete checks also block.
This avoids silently duplicating known transfers from earlier importer versions.
It does not rewrite old records, resolve edited legacy records or repair partial
imports. Probe rows are deduplicated before validation and are never imported.

The prepared activity cash effects are checked independently against the union
of source movements per account and currency. In separate accounts the funds
cash effect must net to zero and the cash account must retain the source delta.
Statement controls remain per-file checks, so overlapping exports are not summed
twice. These are changes, not invented opening balances.

Each separate-account trade and its two transfer legs share a transient source
operation group. After normal backend duplicate validation, the wizard blocks a
group with only some rows included (new versus duplicate/skipped/error). The
confirmation handler repeats this check before creating assets or applying
activities. Entirely new, duplicate or excluded groups retain normal behavior.
This prevents duplicate trades plus fresh financing legs from producing an
unbalanced partial import. The group is draft-only and is not sent to persistence.

### Architecture impact

Parsing and matching remain local frontend functions. Separate-account preparation
adds one awaited read-only call to the existing import-check command for legacy
transfer compatibility. It uses cash-only probes, without asset enrichment or
new external provider requests. It adds no API commands, persistence schema,
background jobs or synchronization mechanisms. Failure is surfaced and blocks
preparation; edits invalidate in-flight results rather than retrying in background.
Source row provenance stays in the preparation result; stable operation references
are included in activity comments through the existing import fields. Unknown
future formats require an explicit parser rather than broader column guessing.

## Previous CSV preparation

The former combined MyInvestor CSV panel is superseded by the Inversis source
import. The following describes its earlier limitations, retained for context.

With a transaction-tracked securities account selected, uploading either known
MyInvestor CSV offers a combined preparation panel. Select the EUR cash account,
upload the other CSV and explicitly match each completed purchase to one bank
debit. The exports do not share an execution identifier and estimated order
amounts differ from posted bank debits, so date or amount proximity alone does
not authorize a match. Cancelled orders are omitted; unknown statuses, missing
matches, reused debits and indistinguishable transfer fingerprints block
preparation.

For each match, the posted debit date and amount supply a cash-account
TRANSFER_OUT, an equal funds-account TRANSFER_IN and a funds-account BUY. The
order supplies the ISIN and quantity; the unit price is the actual debit divided
by quantity. All three rows enter the ordinary mapping, asset resolution,
validation and confirmation flow in one batch. Core's existing import transfer
linker links the two transfer legs. No separate writes or new account
relationships are introduced.

Positive interest-period descriptions become INTEREST. Other unmatched bank
movements retain their concepts with an incoming/outgoing unmapped label, so the
user must classify them rather than silently treating an investment debit as an
external withdrawal. The generated CSV has explicit account IDs and currency;
source templates are cleared before mapping to avoid changing those meanings.
This preserves cash changes represented in the source, not an independently
verified closing balance: no opening balance or missing history is invented.

Reimport uses existing semantic duplicate detection. It does not repair a
previous partial import or reclassify already-imported withdrawals/purchases.
Existing duplicate review remains necessary in those cases. Review edits can
change the prepared entries; the preparation does not override those edits.

The activity-type column selector also accepts an explicitly selected fixed
activity type, for exports without an operation column. Never assume that an
unsigned amount means BUY: a fixed type applies to every included row; mixed
files need a type column or per-row correction in the existing review.

When quantity and amount columns are found but price is absent, the mapping
selects amount divided by quantity, rounded to twelve decimal places with
integer arithmetic. Invalid, zero or unavailable operands produce no price and
the normal validation remains blocking. A mapped price column takes precedence.
Source estimates stay estimates; fees, taxes, contract multipliers and cancelled
orders still need review. This is a unit price calculation, not execution-price
recovery.

Currency already falls back to the selected account through the existing import
flow. Spanish date, quantity, amount, concept and currency headings are
recognized alongside existing aliases. ISIN satisfies the mapping-stage security
identifier requirement; actual asset resolution remains mandatory downstream.

## Architecture impact

These are frontend mapping changes. Fixed types and the calculation selector use
reserved string values in the existing fieldMappings JSON, so saving/reapplying
templates uses existing APIs and storage. There are no new tables, background
jobs, providers, network calls, account relationships or accounting rules. The
draft builder and mapping preview share the same value resolver. Cash movements,
buys and transfers keep the existing core validation, cash calculations and
duplicate detection. LAN synchronization is unchanged. The former experimental
MyInvestor importer and UNKNOWN bank-cash accounting are removed; no import
using that flow was confirmed by the user.
# Optional AI reconciliation for Inversis

The Inversis review panel offers an explicit **Analyze with AI** action and a
provider/model picker using the chat's profile-scoped selection. Model resolution
uses a configured favorite when a custom provider has no catalog default; disabled
providers and API providers without credentials are excluded. No external model
request occurs on upload or on opening the panel.

The request reserves manual/automatic associations and the existing deterministic
proposals. Only the remaining operations are candidates for new suggestions.
Context includes every securities operation and relevant candidate/reserved cash
rows, both date roles, source financial fields, and temporary IDs. Unrelated bank
rows, source paths and file names are not sent. Explicit manual clears are kept.

Architecture impact: one awaited adapter command, `suggest_import_matches`, with
Tauri and Axum handlers delegates to the existing AI service's stateless matching
operation. It reuses provider settings, clients, credentials, proxy/TLS and tuning.
Unlike chat, it does not create a thread or message, generate a title, expose
portfolio tools, or persist source data or suggestions. The only model tool is a
structured output schema. There are no new tables, workers, queues or retries.
Chat tool preferences do not gate this output schema and remain unchanged. A
provider that cannot return structured output fails without applying suggestions.
The AI controls appear in a separate section above the operation list.
Each match compares the security operation and the proposed/accepted cash movement
side by side (stacked on phones), with amounts, both date roles and evidence.
Source references and AI explanations expand under Details. There is no per-row
confirmation. Preparing activities consumes the effective selections, including
proposals, and retains the existing validation and balance checks. Manual choices
and explicit clears take precedence. Editing a selection invalidates prepared drafts.
Replacing or clearing AI proposals also invalidates preparation, including when
the provider/model changes; manual choices remain untouched.
Architecture impact of preselection: only frontend draft preparation changes;
provider requests, parser rules and persistence boundaries remain unchanged.
The subsequent review edits generated activities, not the source pairings. Pairings
can be corrected in the source panel before proceeding. Nothing is persisted until
the final existing import action.
Failures expose bounded diagnostic codes for timeout, invalid output and provider
HTTP status, including Tauri's structured `ServiceError` envelope. Raw provider
errors, response bodies and source data are never shown or logged by matching.

Backend and frontend validate IDs, reservations, uniqueness, settlement/value
dates, cash direction and amounts. Same-currency amounts allow at most 0.02 of
rounding difference; different currencies require a unique eligible cash candidate
on settlement. Incompatible rows are discarded; malformed/duplicate batches fail
without applying a partial greedy assignment. The parser's existing candidate
graph owns instrument/operation-family eligibility. Model explanations and scores
never override these constraints, and no amounts or FX are invented by the model.

Valid suggestions are selected for review and remain editable in the source
matching UI. Provider errors preserve selections. Late results are ignored after
file, account, manual selection, provider/model/configuration changes or unmount.
Generation is bounded by request size (100 operations, 500 cash rows, 80 KB of
serialized context), output budget and a provider-dependent timeout: ten minutes
for providers classified as local (Custom and Ollama), two minutes for cloud
providers. The shared frontend adapter allows eleven minutes so its Tauri and web
transports do not cut off a valid local request first. This changes only awaited
execution timing; it adds no retries, workers or persisted configuration. Large histories need
smaller source batches; they are not silently truncated. Final activity creation,
duplicate checks, balance validation and import still use the existing pipeline.

Matching disables Ollama thinking for the task. For Custom Qwen 3.8 it sends the
verified Strata `reasoning_effort: "none"` switch when no explicit tuning override
exists. This affects this bounded proposal task only, not provider settings or
chat. The output cap scales with the number of pending operations, within the
configured provider maximum.

### Source identifiers and net trade totals

Import asset drafts retain the source ISIN in `metadata.identifiers.isin`,
independently of the canonical/provider symbol used for quotes. Manual search and
draft reconstruction preserve it too. At final activity confirmation, existing
assets with one unambiguous source ISIN have a missing identifier filled through
the existing `get_asset_profile` / `update_asset_profile` adapters. Existing ISINs
(including conflicts), other metadata, names and notes are preserved. Skipped
duplicates do not trigger these updates. A failed write prevents activity import;
an identifier already filled before a later failure is retained for the next try.

Architecture impact: this adds an awaited local asset update to the existing final
import action, not to preview. Both runtime adapters already expose these commands;
their persistence, events and sync behavior are reused, including the normal
`AssetsUpdated` recalculation/quote-sync planning. No provider endpoints or
settings, workers, retries or schema changes are added. Resolver preview
remains read-only; local identity matching retains its existing network boundary.

Inversis preparation compares quantity × source net price with the selected net
cash amount using exact decimal arithmetic and the core half-minor-unit tolerance.
Discrepancies appear as row-specific warnings before import. They do not invent
fees or overwrite the source quantity, price or net amount. Cash reconciliation
and trade arithmetic are separate checks: a balanced cash ledger can still contain
trades that the existing core writer marks for review. This change leaves that
review policy and the final user approval unchanged.

### Original settlement evidence

Inversis arithmetic warnings now attach a versioned `sourceReconciliation`
snapshot to the security draft. It contains the stable issue code
`myinvestor_settlement_difference`, an undetermined cause, original quantities,
prices, source net amount, matched settlement amount, their exact calculated
product and signed difference, both source dates, ISIN, operation reference,
file/row provenance and a fixed related-discussion URL. Draft validation and final
import carry this separate field without changing comments or duplicate keys.

Architecture impact: this is an additive, optional import payload field handled
by the existing Tauri and Axum activity commands. The Rust model validates its
identity, bounded fields, dates, decimal arithmetic and allowed reference URL
at deserialization, then saves it under `metadata.source_reconciliation` using
existing activity persistence and sync. No migration, provider call, worker,
retry or new transport command is needed. This stored evidence is required
because current trade fields can be edited after import and cannot otherwise
reconstruct the original discrepancy.

Activity updates preserve this import-owned metadata key even when a later
metadata patch tries to replace or clear it. Other editable metadata keeps the
existing patch behavior. Approval still only clears review state; it does not
alter the snapshot or introduce another cash movement. The activity detail shows
the original evidence both before and after review, independently of current
edited amounts, with formatting/privacy hooks and an allowlisted external link.
The review badge reflects the current activity review flag rather than claiming
that the discrepancy's cause has been confirmed.

### Inversis cash booking dates

Matched trades use the bank movement's operation date as `activityDate`, the same
date used by their internal funding transfers. The engine applies security units
and cash together on this date; it does not model an unsettled trade payable or
use the stored settlement date to defer cash. Using the securities trade date
previously produced a negative investment-account balance before funding arrived.
When the booking date differs, the existing comment preserves both original
securities dates; discrepancy snapshots also retain them unchanged.

Architecture impact: this changes the effective ledger day of newly imported
Inversis trades, including units and historical valuation, without changing the
engine, providers, transport, persistence schema, or final amounts. The cash
account retains the bank's booking chronology. Existing activities are not
rewritten; remove the previous import before importing the corrected history,
because a changed activity date changes its duplicate key. Regression checks
cover earlier/later bank bookings, single/separate accounts and daily cash nets.

### Santander pension statements

The EUR transaction-account upload step also accepts Santander pension PDFs.
PDF.js renders one-page quarterly statements; Tesseract reads the ruled table by
column and cell. All workers, WASM and English recognition data are bundled at
build time; no document or OCR request leaves the device. Limits are 20 MB per
PDF, 12 statements per batch and 12 million rendered pixels per page. Unsupported
layouts, unreadable numbers, unknown operations and withdrawals fail closed.

The parser checks entry totals, the change in value, exact accumulated units and
the final units times NAV against the statement. Batches must start with zero
units and form a non-overlapping chain of statements. Later history can be added
by loading the complete chain again; ordinary duplicate detection keeps existing
activities. Dates use the assigned-units value date and retain both original
dates in stable comments. File names and PDF generation dates do not affect keys.

Sponsor/participant contributions become a DEPOSIT and BUY in the selected plan
account. Entries explicitly labelled transfers become external security
TRANSFER_IN records, with no cash leg. Their amount and NAV are the entry value,
not evidence of pre-transfer acquisition history. The original employer/transfer
concept remains in the comment. No bank-account selector or bank debit is added.

Architecture impact: PDF/OCR dependencies add local browser workers and static
assets to web, desktop and Android bundles. No new endpoint or persisted schema
is added. The existing source-import drafts, asset resolution, core writer,
duplicate checks and source-operation grouping are reused. Closing prices are
transient source-import state. Confirmation validates manual-asset identity and
existing local prices before importing, then saves closing NAVs through the
existing update_quote adapters after activities succeed (trade-price fallback
quotes cannot replace the closing NAV). Existing differing user prices block
confirmation. Failed price writes retain the import context for a normal deduped
retry; the UI states that activities may already be saved. Existing asset
creation and price/activity writes are separate operations, not a new atomic
transaction, retry worker or background import.

