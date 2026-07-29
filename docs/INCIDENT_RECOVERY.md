# Incident recovery runbooks

Operator runbooks for production incidents. All actions are tenant-scoped; there
is no cross-tenant tooling by design.

## 1. Disable Kleegr sync safely

Goal: stop automatic Kleegr -> SCM import without losing data.

- Preferred: set `KLEEGR_SYNC_ENABLED=off` (the documented gate; default off) and
  redeploy.
- Because the current build triggers import from the Kleegr **launch** flow and
  the admin-only `POST /api/kleegr/sync`, the reliable hard-stops are:
  - **Disconnect at Kleegr** so no launch tokens are issued for the sub-account, and/or
  - **Remove `KLEEGR_INTEGRATION_TOKEN`** and redeploy: launch and gateway calls
    then fail fast and no import runs. `/api/kleegr/status` will report the
    integration as not configured.
- Imports are idempotent and non-destructive (rows are matched by Kleegr/GHL id,
  labelled via `clients.kleegr_source`, and manual business data is linked rather
  than blind-overwritten), so stopping mid-way never corrupts existing rows.

Note: `POST /api/kleegr/sync` cannot be triggered from the browser -- it requires
a fresh Kleegr launch token -- so there is no client-side path to start a sync.

## 2. Reverse a bad payout

Principle: **payout history is append-only. Never edit or delete a `paid` ledger
row.** The recompute engine treats `submitted` / `approved` / `paid`
(`LOCKED_STATUSES` in `api/_lib/recompute.ts`) as immutable: those rows are never
re-priced or deleted, and their `payout_batch_entries` linkage is preserved.

- Batch still `submitted` / `approved` (not yet paid): the owner/admin can
  `reject` (entries go back to pending) or `cancel` via `POST /api/payouts`.
  Every transition is written to `payout_events` (append-only) with actor and
  timestamp.
- Batch already `paid`: use `cancel` (owner/admin). Its entries move to
  `clawed_back` and the batch to `canceled`, again logged to `payout_events`; the
  original paid entries are preserved as the audit trail rather than erased.
- To correct amounts after payment, add **compensating adjustment entries**
  (payment / rule types `adjustment` or `refund`) so the net is corrected while
  the historical paid rows stay intact. Do not hand-edit paid rows in the
  database.
- Controls that back this up: separation of duties (the approver may not be the
  submitter; owner exempt), `mark_paid` / `cancel` restricted to owner/admin, and
  batch-total reconciliation against the sum of entries before approve/pay -- so
  a stale or edited total can never be approved or paid.

## 3. Handle a bad import

- Imported client rows are labelled `clients.kleegr_source = 'kleegr_imported'`
  (rows the sync created) or `'kleegr_linked'` (existing rows it matched). Use
  this label to identify exactly what a sync touched.
- Discard: delete only the `kleegr_imported` rows for the affected tenant -- they
  hold no manual edits. Never delete `kleegr_linked` rows (those are your own
  business rows the sync merely linked); instead clear their Kleegr/GHL id
  columns to unlink them.
- Because imports are idempotent (matched by Kleegr/GHL id), fixing the upstream
  data at Kleegr and re-launching re-links correctly without creating duplicates.
- Snapshot safety: `PUT /api/state` does not carry the external-id columns, and
  `writeState` captures/restores them around its replace-all, so an admin save
  never wipes a tenant's Kleegr/GHL links.

## 4. Database backup / point-in-time recovery (Neon)

- The database is Neon Postgres. Use Neon's **branching + point-in-time restore**
  (restore to a timestamp before the incident) from the Neon console; SCM keeps
  no separate backup of its own.
- Prefer restoring into a **new Neon branch** first, verify the data, then cut
  `DATABASE_URL` over. Never restore in place over a live production branch
  without a verified branch to fall back to.
- After any restore, re-run the deploy-time integrity migration
  (`scripts/migrate-financial.ts`, see `RUNBOOK.md`) so the money-path
  constraints are re-checked against the restored data.

## 5. Force demo mode off in production

- Demo mode is **off by default**. In a Vercel production deployment
  (`VERCEL_ENV=production`) the no-password bypass is additionally **forced off**
  even if `DEMO_MODE` is affirmative, unless `DEMO_MODE_ALLOW_IN_PRODUCTION` is
  also affirmative.
- To guarantee it is off: set `DEMO_MODE=off` (or unset it) AND ensure
  `DEMO_MODE_ALLOW_IN_PRODUCTION` is unset, then redeploy. Confirm with an
  anonymous `GET /api/auth/me`, which must return `401` (no demo bypass in
  effect).
