# Sales Tracker operation and activation

## Preserve the live baseline

The deployed baseline is PR #41, commit `bc46b0425a9e6f2929608bd8bfb86880a6872483`. This change does not replace its framework, database, signed launch, authentication or token broker. Do not rerun a demo seed. Do not use JSON snapshot import to overwrite server records.

The user handoff explicitly does not authorize deployment, live migration, financial import, invitations, CRM writes or money transfers. These are separate activation decisions. A GitHub branch push may start a Vercel Preview: it is not automatically an isolated database. The inspected Preview and Production environment variables referenced the same database, and Preview did not have the broker key configured.

## Configuration and migration

1. Obtain approval for the concrete staging/release target. Use a new isolated Neon branch/database for staging, not the Production database URL. Keep database URLs and service keys in server secrets, never VITE variables or committed files.
2. Take a database backup/restore point and verify it can be restored into another database. Record host, database, migration IDs, row counts and paid totals without credentials. Pause writes for the approved migration window.
3. Install the repository's Node 22 dependencies. The added PGlite dependency is development-only.
4. Supply `DATABASE_URL` explicitly in the operator environment. The tracker migration intentionally does not load `.env` or run on API startup.
5. Run `npm run db:tracker:preflight`. It prints only target host/database and counts. Baseline migration `0011_live_directory` must exist. Review linked participants, historical receipts/ledger and paid batches against the backup.
6. After explicit approval, set `TRACKER_MIGRATION_CONFIRM` to the reviewed database hostname and run `npm run db:tracker:apply`. This executes `0012_sales_tracker` transactionally with a five-second lock timeout and two-minute statement timeout. A failure rolls back; resolve the cause and rerun the idempotent migration.
7. Verify migration ID, original row counts and paid amounts. Check new constraints/triggers and confirm existing identities were grandfathered. Do not convert historical monetary fields automatically.
8. Deploy the reviewed code to the isolated target, configure the existing server token broker variables for that target, and verify authenticated launch. New screens become available after `0012`; they are gated before it.
9. Configure each workspace's currency, decimal precision, timezone, attribution policy and payout terms. Keep separate approval on unless an administrator explicitly records the policy change and reason.
10. Publish reviewed plan versions and dated assignments. Earlier plans/earnings remain history, not automatic exact-engine inputs.

After any new exact financial records exist, do not roll back to old mutation code or remove the immutable-history triggers. Prefer a forward fix. If restoration is necessary, use the verified backup in an isolated database and reconcile events that arrived after the backup before changing the live connection. Never delete financial rows to undo a deployment.

## Isolated verification

`npm test` includes baseline tests and `npm run test:tracker`. The tracker suite creates a fresh embedded Postgres database and uses isolated identities/provider adapters. It has no Neon/GHL connection.

For browser checks, first build the app, remove all database/provider credentials from the shell, then run `npm run dev:tracker:isolated`. It binds only `127.0.0.1:4173`, creates a new in-memory test workspace, and routes through the actual API handlers with an isolated session. Test records disappear when this harness stops. This is not production persistence and must never be deployed.

On the current restricted Windows host, the tsx launcher cannot read OS user information and the Vite development optimizer hits a parent-directory access restriction. Verification therefore uses the local TypeScript loader and programmatic production build; these are local test workarounds, not application runtime changes. Run the standard commands on Node 22 in CI/staging too.

Stage the full workflow: load directory; enroll two users; create team and separate administrator; configure workspace; publish/assign plan; native referral conversion; owner reassignment; confirm a receipt; inspect held earning; release or wait; submit; separately approve; record a test settlement in the isolated database; partial refund; CSV/report reconciliation. Repeat permission checks as manager/participant and another tenant, then reload/re-authenticate from a second browser. Production smoke tests should remain read-only unless separately authorized.

## Integration capabilities and ownership

| Resource | Contract | Scope/token | Pagination / limitation |
|---|---|---|---|
| Token broker | Existing Smart Productivity `/api/auth/ghl/token-inspect` with server `x-service-key` | Existing broker key, tenant-derived location | Broker refreshes/remints; revoked authorization requires reconnection. Never expose returned raw tokens to the browser |
| Users | Existing GHL `/users/search`, company + location context | Agency access with users read permission | Existing verified skip/limit loop; legacy location fallback retained only where supported. Search is not a blind substitute without company context |
| Contacts | Existing `/contacts/` location-scoped adapter | Location token, contacts read permission | Existing cursor pagination and complete-result validation preserved |
| Opportunities | `/opportunities/search`, `Version: v3` | `opportunities.readonly`, location token | Page size 100, saved checkpoint. Read-only live check returned 394 total; field/currency mapping still reviewed |
| Transactions | `/payments/transactions`, `Version: v3`, `altType=location` | `payments/transactions.readonly`, location token | Limit/offset 100. Read-only live check returned 96 total. Only verified live succeeded canonical charges can create receipts |
| Events | Existing authenticated Kleegr webhook route | Existing Kleegr signature verification | Persist event before successful acknowledgement. New attribution/financial changes enter review; no invented marketplace subscription |

Official references checked September 8, 2026: [user search](https://marketplace.gohighlevel.com/docs/ghl/users/search-users/), [deprecated location users](https://marketplace.gohighlevel.com/docs/2023-02-21/ghl/users/users/), [opportunity search](https://marketplace.gohighlevel.com/docs/ghl/opportunities/search-opportunity/index.html), [transactions](https://marketplace.gohighlevel.com/docs/ghl/payments/list-transactions/index.html), [scopes](https://marketplace.gohighlevel.com/docs/Authorization/Scopes/index.html), [versioning](https://marketplace.gohighlevel.com/docs/Versioning/index.html), [rate limits](https://marketplace.gohighlevel.com/docs/other/rate-limits/index.html). Published resource limits are 100 requests per 10 seconds and 200,000 daily per app/resource; honor provider responses and rate-limit headers. New financial previews run one page per action, persist checkpoints, and back off after failures. Do not bypass their retry time.

The provider owns external identity/profile, contact details, and reviewed opportunity fields. This app owns enrollment, app roles/teams, plans/assignments, manual attribution, ledger, payout evidence, goals and resources. Profile sync must never replace a manual referrer or erase a removed participant's financial history. Current owner is not proven lead generation. A verified launch/session establishes tenant scope; browser location parameters are not authorization.

## Commission policy

Money is an integer string in configured minor units. Percentages use basis points; rule totals round half away from zero. Pool splits distribute a single rounded pool deterministically; stacked groups create independent rewards. Parent/grandparent rewards must have resolvable beneficiaries. Gross is cash after discounts; net removes the supplied tax and fees. A discount is informational and is not subtracted twice.

A confirmed receipt is the qualification event. The first qualifying confirmed receipt can also qualify a fixed sale reward. Opportunity value and invoices never imply collection. Failed/cancelled/pending receipts do not earn until a pending receipt is explicitly confirmed. Receipt identity, frozen rule version, inputs, explanation and due date stay with each earning. Successful charge count is the ingestion-order count for the contact/product, including partially collected receipts as separate charges; refunds do not decrement it. Review subscription/charge mapping before imports if that policy differs from the business contract.

Exactly one dated assignment must match the selected participant/product/campaign. The explicit referrer is the default basis; an administrator can select a recorded owner/closer for plan eligibility without rewriting generation history. Ambiguous assignment overlap is rejected. New versions require a new assignment. Late events use the effective version for their recorded receipt date but never reprice earlier earnings.

Refunds append exact proportional reversals with cumulative rounding and cannot exceed original cash. A reversal after settlement is an outstanding offset, not recovered money. Previously unmatched refunded receipts require an explicit reviewed signed adjustment instead of a gross late allocation. Qualified fixed compensation records require an assignment, evidence, non-overlapping periods, and remain separate from payroll.

Manual payout evidence includes reference, recipient, method, actor, date and exact amount. Repeated references are idempotent. An unknown transfer must be reconciled against the same reference before another attempt. Partial close preserves original entries and approved amount, appends non-cash balancing entries, and exposes only the remaining liability for a new payout. No transfer is initiated by this app.

## Referral capture

Create an active native campaign, select active participants, then open a participant's generated `/join?code=...` link. The server records an opaque expiring click; a consented native form creates one campaign/contact conversion. Repeated submissions of the same click/email within that campaign do not create a second reward. Assign a reviewed plan and record a verified receipt to complete the earning trace. Clicks alone never create payable commissions.

External destinations require public HTTPS and cannot supply an arbitrary request-time redirect. They remain configured/unverified; no generic iframe, cookie or script is claimed to track them. Before enabling external conversion, implement an authenticated capture adapter, preserve the opaque click identifier with consent, verify contact/charge matching and duplicate handling in staging, and obtain approval for installation. Coupon support is unavailable until actual provider evidence and mappings exist. Do not use fingerprinting.

## Reports and operating checks

Currency totals stay separate. Paid totals in a date-filtered earning report mean that cohort's settled earnings, not bank cash during that calendar period. Settlement history provides cash-date evidence. Generated leads use attribution date; assigned inventory and open pipeline are current snapshots. Lead conversion uses lead-created cohort and a confirmed receipt at any date. Won deals require a known won date; current imported won status is not a substitute. Forecasts are labeled estimates and never enter liabilities.

Use the same filters for detail and CSV; exports are permission-scoped, quote cells, guard spreadsheet formulas and enforce size limits. Earlier non-exact records stay visible in details but are excluded from exact totals. Review failed syncs, unresolved attribution, pending imports, approvals and unknown settlements before each payout cycle. Token errors require connection repair, not logging raw credentials. Structured audit histories provide who/what/when for financial and attribution changes.
