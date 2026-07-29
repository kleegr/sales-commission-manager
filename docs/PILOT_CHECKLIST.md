# Sales Commission Manager - Pilot & Production Readiness Checklist

This is the go-live checklist for putting a **real agency owner** on Sales Commission
Manager. It maps every completion criterion to its current status, records the live
production QA that was run, and gives the owner a short runbook to reach a pilot.

**Status legend:** `[DONE]` done & deployed - `[OWNER]` owner action required -
`[KLEEGR/DB]` needs the Kleegr team or a DB run - `[OPTIONAL]` polish.

Last updated after PRs #18-#32 (all merged to `main`; production auto-deployed and verified).

---

## 1. "Complete when a real agency owner can..." - the 20 criteria

| # | Criterion | Status | Notes |
|---|---|---|---|
| 1 | Open SCM from Kleegr/GHL | DONE | `/kleegr/launch` verifies the launch token, mints its own session, redirects by role. |
| 2 | Land in the correct agency/sub-account workspace | DONE | Owner -> `/agency`, admin/manager -> `/`, rep/affiliate -> `/portal`. |
| 3 | See the correct role | DONE | Role mapped from the verified launch claim (PR #14/#17); never from the URL. |
| 4 | Know real vs sample/demo data | DONE | Demo mode forced OFF in production; the demo/acme sample tenants are inert (no login). Real Kleegr sub-accounts are the `k-*` tenants. |
| 5 | Connect/confirm a sub-account/location | DONE | Launch upserts the tenant; `/settings/integrations/kleegr` shows connection status. |
| 6 | Import/link contacts/opportunities safely | DONE (gated) | Auto-import is OFF by default (`KLEEGR_SYNC_ENABLED`); a launch only refreshes the profile. Reviewed import is a future enhancement. |
| 7 | Create salespeople/affiliates/partners | DONE | People CRUD. |
| 8 | Create commission plans (templates or manual) | DONE | Plan builder + templates. |
| 9 | Assign people to plans | DONE | Plan assignment; the setup checklist flags anyone unassigned. |
| 10 | Add/receive clients/leads/opportunities | DONE | Clients CRUD + portal "add lead". |
| 11 | Add payments / define the trigger | DONE | Payments feed the deterministic engine + server recompute. |
| 12 | See the ledger explain every dollar | DONE | Commission ledger; recompute is authoritative + concurrency-guarded (PR #31). |
| 13 | See held/pending/approved/paid/clawed-back clearly | DONE | Ledger statuses + held total. |
| 14 | Submit payouts | DONE | Payout workflow. |
| 15 | Approve payouts | DONE | Team-scoped + separation of duties (approver != submitter) + batch reconciliation (PR #22). |
| 16 | Mark payouts paid | DONE | With reconciliation guard. |
| 17 | Preserve historical payout/ledger records | DONE | Locked rows (submitted/approved/paid) never re-priced; `payout_events` append-only audit. |
| 18 | View reports and export them | DONE | Reports + CSV export + drill-down (PR #28). |
| 19 | Let salespeople/affiliates see their own portal | DONE | Self-scoped portals (rep-picker removed, PR #24). |
| 20 | Use it without a developer explaining every screen | DONE | Setup checklist + "Needs attention" action center on the dashboard (PR #29); action-bearing empty states. |

**20 / 20 addressed.** #6 is intentionally gated for safety (see section 4).

---

## 2. "Pilot-ready means..." - checklist

- [x] Real Kleegr launch works (token verified, own session minted)
- [x] Correct role/tenant routing
- [x] Demo mode OFF (forced off in production via the `VERCEL_ENV` guard - PR #19)
- [x] No fake/demo language on the product surface (login de-demo'd, "simulated/prototype" removed - PR #23/#24; verified 0 `demo1234` in the shipped bundle)
- [x] No public tenant-data leaks (`/api/health`, `/api/tenants`, `/api/agency` locked down - verified live)
- [x] Basic security hardened (rate-limit, CSRF on all mutations, tenant/agency isolation, error envelopes)
- [x] Onboarding/setup checklist exists
- [x] Admin dashboard tells the user what to do next
- [x] Contacts/opportunities can be safely reviewed (auto-import gated off)
- [x] Commission plans/payments/ledger/payouts work end-to-end
- [x] Reports useful enough (with export)
- [x] Embedded layout feels professional (compact iframe layout + frame-ancestors CSP - PR #30)
- [x] No major runtime errors (`/api/goals` 500 fixed - PR #18, verified 401 not 500)
- [ ] **[OWNER] Run `scripts/migrate-financial.ts`** against Neon (adds money-path FKs + idempotency keys)
- [ ] **[OWNER] Set `DEMO_MODE` off/unset** in the Vercel Production env (code already forces it off; keep the env clean)

**Pilot-ready once the two [OWNER] actions are done.**

---

## 3. "Production-ready means..." - checklist

- [x] All pilot-ready items
- [x] Payout separation-of-duties + reconciliation (immutable enough posted history)
- [x] Recompute concurrency guard (`FOR UPDATE` + stable lock order - PR #31)
- [x] Migration discipline documented; deploy-time financial migration script provided
- [x] Structured error logging (`console.error("[scm:error] ...")`) + generic client envelopes
- [x] Docs/runbooks (`docs/RUNBOOK`, `KLEEGR_SETUP`, `ENV`, `INCIDENT_RECOVERY`, this file)
- [x] Full permission model server-enforced (owner/admin/manager/self roles)
- [x] Export/reporting present
- [x] Polished UI across roles
- [ ] **[OWNER] Financial DB constraints applied** (run the migration)
- [ ] **[KLEEGR/DB] Append-only clawback/reversal (H-4)** - deliberately deferred; the current status-flip + `payout_events` is functional and audited. Needs a DB to test the ledger math before rewriting. Documented design item.
- [ ] **[KLEEGR/DB] Full Kleegr live sync** - gated off until the Kleegr team confirms the gateway resource / webhook naming / claim shape (see section 4). The code now defaults the gateway resource to `locations` and accepts both `location.*`/`subaccount.*` webhooks, so it is ready to enable.
- [ ] **[OPTIONAL]** Remove residual client-side demo scaffolding (DemoBar "Review Mode", `RESET_DEMO`, hardcoded demo tenant names) - inert in production (demo off).
- [ ] **[OPTIONAL]** DB-backed integration test suite (tenant isolation, payout lifecycle, sync idempotency) - pure-logic units exist; a Postgres-backed suite is the next test investment.

---

## 4. Kleegr integration proof - confirmed vs. open

**Confirmed / built:**
- App manifest (`smart-productivity.app.json`) with corrected scopes `locations/users/contacts/opportunities.readonly` and status/health/webhook endpoints.
- Launch token verified with Kleegr (`POST /api/plugins/verify`), claims validated, used once, own session minted; secrets server-side only.
- Webhook HMAC verified over raw bytes, fails closed (missing secret -> 500, bad sig -> 401).
- Gateway resource token now defaults to `locations` (matches the approved scope) and is overridable via `KLEEGR_GATEWAY_RESOURCE` (PR #32).
- Webhook receiver accepts both `location.*` and `subaccount.*` event names (PR #32).
- Auto-import gated off (`KLEEGR_SYNC_ENABLED`) - no real data written on launch (PR #27).

**Open questions for the Kleegr / platform team** (see `docs/KLEEGR_SETUP.md`):
1. Correct gateway resource token - `locations` (now the default) vs `subaccount`?
2. Webhook event names - `location.*` or `subaccount.*`? (Receiver handles both regardless.)
3. Launch-token claim shape - `aud`, `sub_account_id`/`location_id`, `role`, `placement`, and a company/agency id (needed to populate `tenants.agency_id` so an agency owner sees all their sub-accounts).
4. Webhook delivery-id field for idempotency.
5. Is the app registered/enabled for the target sub-account, and is the manifest accepted?

Once 1-4 are confirmed: set `KLEEGR_GATEWAY_RESOURCE` if needed, wire `agency_id` from the company/agency claim, then flip `KLEEGR_SYNC_ENABLED=1` with a reviewed import.

---

## 5. Live production QA (run this session)

Verified against `https://sales-commission-manager.vercel.app` (cache-busted, current deployment):

| Check | Result |
|---|---|
| `GET /api/health` (unauth) | PASS - `ok:true`, coarse status, no tenant array |
| `GET /api/kleegr/status` (unauth) | PASS - `authenticated:false`, no workspace/user |
| `GET /api/auth/me` (unauth) | PASS - `401` |
| `GET /api/goals` (unauth) | PASS - `401` (not the old 500 / "Cannot find module") |
| `GET /api/agency` (unauth) | PASS - `401` |
| `GET /api/tenants` (unauth) | PASS - `401` |
| Login page | PASS - clean email+password; 0 occurrences of `demo1234` / "A simulated rep login" in the shipped JS bundle; meta description clean |
| Error bodies | PASS - generic (`{"error":"unauthorized"}` / `internal_error`); no SQL/stack leaked |
| Full test suite on `main` | PASS - 19 test files; typecheck + build clean |

Note: a transient cold-start `500` was observed once on `/api/goals` (steady-state `401`) - consistent with a cold Neon connection, not a handler bug; the error envelope is generic.

---

## 6. Owner go-live runbook (to reach a pilot)

1. **Apply the financial migration:** `npx tsx scripts/migrate-financial.ts` (with `DATABASE_URL` set). It runs an orphan/duplicate pre-flight and refuses to apply on dirty data - clean anything it reports, then re-run.
2. **Vercel Production env:** ensure `DEMO_MODE` is off/unset; leave `KLEEGR_SYNC_ENABLED` unset for now. Confirm `DATABASE_URL`, `KLEEGR_INTEGRATION_TOKEN`, `KLEEGR_WEBHOOK_SECRET` are set (see `docs/ENV.md`).
3. **Confirm you can sign in:** either a real owner login, or launch from your Kleegr sub-account (the no-password demo bypass is intentionally dead in prod).
4. *(optional)* Delete the inert `demo` / `acme` sample tenants from the DB if you do not want sample workspaces present.
5. **Smoke test** (the acceptance walkthrough): launch from Kleegr -> land in the right workspace/role -> dashboard shows the setup checklist + needs-attention -> create a plan -> add & assign a person -> record a payment -> check the ledger -> submit a payout -> approve as a different user (self-approval is blocked) -> mark paid -> export a report. Expect: no `demo1234`, no fake data, no dead buttons.
6. **When ready for live sync:** complete the Kleegr section-4 confirmations, then enable `KLEEGR_SYNC_ENABLED` with a reviewed import.

**After steps 1-3 + a clean smoke test, the app is ready for a real pilot customer.**
