# Day-2 operations runbook

## Deploy

- The project auto-deploys on push/merge to **`main`** (Vercel). `vercel.json`
  sets build `npm run build`, output `dist`, and a SPA rewrite that excludes
  `/api` so the serverless functions are not shadowed.
- Required production env var: `DATABASE_URL` (Neon pooled). See `ENV.md` for the
  full list (Kleegr / demo / AI variables).
- Base schema: `api/_lib/schema.ts` plus forward-only `api/_lib/migrations.ts` is
  applied automatically on the first request via `ensureSchema()` (e.g. hitting
  `/api/health`). No manual step is needed for the base schema.

## Deploy-time financial-integrity migration

`scripts/migrate-financial.ts` adds money-path FOREIGN KEYs (NOT VALID) and
partial UNIQUE indexes. It is **standalone and run manually** by the owner -- it
is intentionally NOT part of `ensureSchema()`.

```
DATABASE_URL="postgres://...neon...?sslmode=require" \
  npx tsx scripts/migrate-financial.ts
```

- It runs a **read-only pre-flight** first and prints four counts: orphan ledger
  payment ids, orphan payout entries, duplicate ledger dedup groups, and
  duplicate external payment ids. If any count is greater than zero it prints a
  WARNING and **exits non-zero without changing the schema** -- clean the data,
  then re-run.
- When the pre-flight is clean it applies each constraint idempotently (safe to
  re-run). The FKs are added `NOT VALID` (new writes are enforced; existing rows
  are not scanned). Once confirmed clean, promote them with
  `ALTER TABLE <table> VALIDATE CONSTRAINT <name>;` (the script prints the exact
  statements).
- Run it after each schema-affecting deploy and after any database restore.

## Health check

- `GET /api/health` -- unauthenticated liveness. Returns `ok`, the DB env-var
  name that was resolved, and the Postgres engine string. It exposes **no**
  tenant data to anonymous callers; per-tenant row counts are returned only to an
  authenticated owner/admin, and only for their own tenant.
- `GET /api/kleegr/status` -- integration config presence (env-var names only),
  manifest info, and (with a session) the tenant connection summary.

## Logs

- Read runtime logs in the Vercel dashboard (Project -> Deployments -> the
  deployment -> Runtime Logs / Functions), or `vercel logs <deployment-url>`.
- Server errors are logged with a `[scm:error]` prefix. Secrets are never logged;
  Kleegr tokens and the webhook secret are read by name only.

## Security posture (summary)

- **Demo mode off in production.** Off by default, and force-off under
  `VERCEL_ENV=production` unless a second key (`DEMO_MODE_ALLOW_IN_PRODUCTION`) is
  set. See `INCIDENT_RECOVERY.md`.
- **Tenant and agency isolation.** Every business row carries `tenant_id` and all
  queries are tenant-scoped; the active tenant is fixed by the authenticated
  session, never the client. Roles further scope reads (owner/admin = whole
  tenant; sales_manager = their team; salesperson/affiliate/partner = own rows).
- **Rate limiting.** DB-backed sliding window on failed logins (per IP + email;
  `LOGIN_MAX_FAILURES` within `LOGIN_WINDOW_MIN` minutes; fail-open on infra
  error).
- **CSRF.** State-changing requests are origin/referer-checked (`csrfOk` in
  `api/_lib/http.ts`); session cookies are httpOnly and Secure (`SameSite=Lax`
  normally, `SameSite=None` only for the embedded Kleegr launch).
- **Payout separation of duties.** Approver is not the submitter (owner exempt);
  `mark_paid` / `cancel` are owner/admin only; batch totals are reconciled
  against their entries before approve/pay; all transitions append to
  `payout_events`.
- **Secrets server-side only.** Kleegr / OpenAI / DB secrets are read by env-var
  name, never returned to the browser or placed in the manifest. Webhooks verify
  an HMAC signature and fail closed.

See also: `ENV.md`, `KLEEGR_SETUP.md`, `INCIDENT_RECOVERY.md`.
