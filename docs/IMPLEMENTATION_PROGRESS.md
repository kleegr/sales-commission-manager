# Sales Tracker implementation progress

Requirements: full user handoff supplied 2026-09-08. The referenced PDF was not attached. Baseline: `bc46b0425a9e6f2929608bd8bfb86880a6872483` (production PR #41). Work is in `codex/complete-sales-tracker` in a separate checkout; the earlier working copy and live application are preserved.

## Gap matrix and result

| Requirement | Existing implementation | Implemented in this change | Verification / remaining activation |
|---|---|---|---|
| Tenant/auth | Neon persistence, authenticated sessions, signed Kleegr launch, scoped legacy APIs | Same session-derived tenant for new APIs; admin, manager/team and participant scope; CSV and agency boundaries | Existing auth/agency tests plus isolated cross-tenant and manager tests; production embedded recheck remains |
| Users to salespeople | Paginated live GHL directory; earlier sync auto-enrolled users | Separate external directory, explicit bulk enrollment, stable tenant/provider identity, local partners, team manager and dated assignments | Enrollment, repeated sync, no new logins/admin grants and missing-user preservation tested |
| Leads/opportunities | Contacts and current assigned owner | Original source/referrer/owner/closer, evidence/history, manual/code/field attribution, conflict review, local and staged provider opportunities | Ownership preservation, protected evidence, won deal without cash tested |
| Campaigns | No verified referral chain | Lifecycle, participants, immutable link IDs, consented native form, click/conversion trace, resources and terms | Native click to receipt/earning tested; external-page capture explicitly unverified |
| Plans/money | Legacy rules, projections and floating point amounts; editable earnings | Immutable versions, exact integer amounts, explicit assignments, templates, percent/fixed/sale/lead rules, charge bounds, splits, parents, holds, frozen inputs | Exact cash, partial receipt, refund, versioning, idempotency and simulation tests |
| Payouts | Submission/approval and events | Atomic reservations, separate approver including owners by default, settlement evidence, unknown result reconciliation, partial close/carry-forward, failed cancellation | Reservations, duplicate receipts/settlements, partial balances and cash reconciliation tested |
| Reports/goals/portal | Legacy reports, goals, documents and portal | Scoped exact report, source/ownership distinctions, cash/pipeline separation, CSV, team/individual goals, milestones, media, assigned plans and own portal | Exact sums, no forecast liabilities, manager scope, goals, media and safe CSV tested |
| Operations | Existing manual directory sync and signed Kleegr events | Resumable reviewed resource previews, retry/backoff, staged financial mapping, authenticated events persisted before acknowledgement, explicit additive migration | Checkpoint/retry/stale preview tests; live read capability confirmed, no financial import enabled |

## Completed implementation

- Preserved React, Vite, Neon, authentication, documents, existing API integration and earlier data. New screens activate only after migration `0012_sales_tracker`; existing screens continue before migration.
- Preserved the hybrid connection: Smart Productivity owns OAuth and refresh; Commission Manager uses its server-side broker to obtain tokens for supported GHL reads. No new OAuth system and no browser token storage.
- Grandfathered earlier participant enrollments. Subsequent directory imports create available identities, not automatic commission participants or logins. Enrollment never changes CRM permissions.
- Added immutable plan versions and dated participant/product/campaign assignments. Conflicting assignments are rejected instead of choosing an ambiguous rule. Earlier plans remain readable; they are not silently converted.
- Added exact confirmed/pending/failed/cancelled receipts, confirmation of pending receipts, preview before posting, first allocation of previously unmatched receipts, proportional refunds and authorized signed adjustments.
- Added qualified lead/fixed compensation awards with evidence and dated assignments. Fixed compensation is not payroll. Manual adjustments do not transfer money.
- Added payout Draft/Submitted/Approved/Processing/Paid and rejected/cancelled/failed/unknown handling. Partial closure preserves approved amount, records actual cash, and appends balancing/carry-forward entries; it does not pretend the remainder was paid.
- Added dynamic records, meaningful empty/error/loading states, filters, pagination, CSV, reference names, histories, report drill-downs, native referral capture, goal progress, resources and portal views.
- Settings now save explicitly through the persistent API. The old browser snapshot import no longer bypasses server-owned financial workflows. New production defaults do not seed illustrative money or people.
- Added an isolated embedded Postgres browser harness. It rejects live credentials and cannot be started as a Vercel deployment.

## Verification record

- The new embedded Postgres suite currently contains 37 scenarios spanning handoff A–K plus pending confirmation, late allocation, signed adjustments, partial/unknown/failed settlement, manager scope, goals, evidence conflicts and simulator dates.
- Baseline test suites are retained. Two navigation assertions were updated because managers now have scoped Team access; server integration checks prove another team is excluded.
- All 26 test suites passed, including the tracker integration suite. Both TypeScript checks and production bundling passed. The final focused suite also covers actual-submitter separation and exactly-once early release, and canonical provider-charge import deduplication.
- The production bundle reports a size warning (about 963 kB JavaScript / 263 kB gzip); profiling on the release target remains part of staging verification.
- Browser checks on the isolated server: select and enroll two external users; provider role stays separate from commission role; save/reload workspace currency and timezone; template → impact preview → published version. The full HTTP handler flow also reconciled a USD 1,000 receipt, USD 100 ledger earning and CSV/report. Browser native conversion persisted one attributed lead and set verified_native; an HTTP owner transfer to Bob preserved Alice as referrer and commission beneficiary. No real CRM or financial test data was created.
- Live read-only capability check on the connected location: opportunities endpoint returned HTTP 200 and total 394; payment transactions endpoint returned HTTP 200 and total 96. Counts establish read access, not correctness of imported financial mappings. No records from these resources were imported.
- Earlier production verification remains 7 available GHL users and 2,007 contacts through paginated reads. These were observations at verification time, not permanent counts.

## Defined limits and unfinished external work

- This is not a claim of production readiness. No new production migration, deployment, financial import, invitation, CRM write or money transfer has been performed.
- The referenced PDF is unavailable. Any additional requirements present only in that PDF still need review.
- New exact financial workflows require a configured currency/precision/timezone, reviewed versions and explicit assignments. Earlier floating point records are preserved and excluded from exact totals until reviewed; no automatic historical conversion or repricing.
- Real opportunity/payment import requires mapping review. Payment source identity must include provider, account and charge; records without it stay in review. Refund information requires an explicit linked refund review. Won dates absent from provider evidence are not manufactured from an update date.
- External destinations and arbitrary GHL pages do not have a verified conversion adapter. Native forms work locally; production native capture still requires an installed migration and release. Coupon/subscription/churn integrations are not claimed. Projections use user-supplied churn assumptions, not measured churn.
- Supported hierarchies currently expose parent and grandparent beneficiaries. Rule holds use calendar days plus audited manual release; more specialized release conditions from earlier plans require explicit review before migration to the new engine.
- Charge counts use confirmed receipts in ingestion order per contact/product. Late events do not reprice previous earnings. Historical charge-index reconstruction requires reviewed import policy; it must not be inferred silently.
- The existing signed Kleegr event channel is preserved. Marketplace webhook subscriptions, actual event coverage and scheduled polling are not automatically installed. Reconciliation can be run from resumable manual previews.
- Media stores public HTTPS resource metadata with app access controls. It is not private binary file hosting; do not put private assets at public URLs.
- Payout movement has no configured payment provider. Record external manual settlement evidence only; the app does not send funds.
- Optional accountant role and arbitrary-depth referral tiers are not implemented. Existing application roles are preserved.
- Browser checks used a narrow window; production mobile embedding, third-party-cookie fallback and cross-device persistence need the staging/production activation checks described in the runbook. The server and DB tests do not substitute for those checks.

## Next operator steps

See [SALES_TRACKER_OPERATIONS.md](./SALES_TRACKER_OPERATIONS.md). First create an isolated staging database, verify the target and backup, run read-only preflight, then explicitly authorize/apply the additive migration. Do not use the current Preview configuration as an isolation boundary: the inspected Preview and Production environments point to the same database. Publish/release only after the target and activation are approved.
