# Sales Commission, Affiliate & Partner Management

An interactive system for designing commission plans and seeing exactly what they
pay — month by month, year by year — for salespeople, affiliates, and partners.

The headline feature is a **deterministic, code-based commission engine**. No AI
decides commissions: every dollar traces back to a specific rule, and the UI
shows which rule fired, when it starts and stops, what continues forever, and how
earnings change with closings and churn.

> **Data layer:** the app runs on a real **multi-tenant Neon (Postgres)**
> database through serverless API routes. Every mutation goes through a
> dedicated, role-checked, single-row endpoint — the `PUT /api/state` snapshot
> write has been **removed** (it now answers 410 with a map of the endpoint to
> use instead).
>
> `localStorage` is a **development-only** backend for `vite dev`, which serves
> no serverless functions. In production the database is the sole source of
> truth: a cached copy is never substituted for the live dataset, because a rep
> reading a balance the database disagrees with is worse than an honest error.
> See [`docs/FEATURES.md` §23](docs/FEATURES.md#23-data-integrity-model).

## Demo / Review mode

The app ships with a **Review Mode** so it can be explored without credentials.
When enabled, a sticky top bar lets you switch **tenant** (Demo / Acme) and
**role** on the fly and see exactly what each user sees:

| Bar button          | Role           | Lands on        |
| ------------------- | -------------- | --------------- |
| Agency Owner        | `owner`        | `/agency`       |
| Sub-account Admin   | `admin`        | `/` (workspace) |
| Sales Manager       | `sales_manager`| `/`             |
| Salesperson         | `salesperson`  | `/portal`       |
| Affiliate / Partner | `affiliate`    | `/portal`       |

**How it works (and stays safe):**

- Demo mode is controlled by the `DEMO_MODE` env var and is **OFF by default**
  (production-safe). Set `DEMO_MODE` to `1`/`true`/`on`/`enabled`/`yes` to turn it
  on for a review deployment; any other value (including unset) keeps it off. In a
  Vercel **production** deployment (`VERCEL_ENV=production`) the no-password bypass
  is additionally **forced off** even if `DEMO_MODE` is set, unless
  `DEMO_MODE_ALLOW_IN_PRODUCTION` is also explicitly set (a deliberate two-key
  action).
- The bypass only ever resolves to an **existing seeded demo user** for the
  chosen tenant + role — it never invents an identity. A real password session
  (cookie `scm_session`) always takes precedence over the demo bypass.
- The selected tenant/role is stored in the cookies `scm_demo_tenant` /
  `scm_demo_role`; tenant + role still come from the server, and every query is
  filtered by `tenant_id`, so tenants remain fully data-isolated in demo mode.

> ⚠️ **Security:** demo mode must stay **off** wherever the app holds real
> customer data — it is **off by default**, and additionally **forced off** in a
> production deployment unless the two-key override above is set. While it is on,
> anyone with the URL can view a seeded **demo/acme** tenant without a password.

## Security posture

Production hardening, with details in [`docs/`](docs/):

- **Demo mode off in production** — off by default and force-off under
  `VERCEL_ENV=production` unless a second key is set. See
  [`docs/ENV.md`](docs/ENV.md) and [`docs/INCIDENT_RECOVERY.md`](docs/INCIDENT_RECOVERY.md).
- **Tenant + agency isolation** — every row is `tenant_id`-scoped; the tenant is
  fixed by the session, and roles further scope reads.
- **Login rate limiting, CSRF, and httpOnly/Secure session cookies** — see the
  security summary in [`docs/RUNBOOK.md`](docs/RUNBOOK.md).
- **Payout separation of duties** — approver ≠ submitter (owner exempt),
  owner/admin-only pay/cancel, and append-only `payout_events` history.
- **Kleegr / GoHighLevel access is server-side only** — no direct GHL OAuth;
  secrets read by env-var name; webhooks verify an HMAC signature and fail closed.
  See [`docs/KLEEGR_SETUP.md`](docs/KLEEGR_SETUP.md).

Operational runbooks: [`docs/RUNBOOK.md`](docs/RUNBOOK.md) (day-2 ops, health,
the deploy-time `scripts/migrate-financial.ts`) and
[`docs/INCIDENT_RECOVERY.md`](docs/INCIDENT_RECOVERY.md) (disable sync, reverse a
payout, bad imports, Neon PITR).

## Run it

### Frontend only (uses localStorage)

```bash
npm install
npm run dev      # Vite dev server — no serverless functions, so it uses localStorage
```

The app seeds a full demo dataset on first run.

```bash
npm run build    # type-check + production build (SPA)
npm run preview  # preview the production build
npm test         # 32 dependency-free unit suites (engine, timing, recompute,
                 # clawbacks, balance, payment events, auth, handlers, …)
```

Requires Node 18+ (developed on Node 22; Vercel builds on Node 22).

### Full stack locally (frontend + serverless API + Neon)

The `/api/*` routes are Vercel serverless functions, so to exercise the real
database locally use the Vercel CLI (which runs the functions):

```bash
npm i -g vercel
vercel link               # link to the existing project (one time)
vercel env pull .env      # pull DATABASE_URL etc. into a local .env
vercel dev                # serves the SPA *and* /api/* against Neon
```

With `vercel dev` running, the app detects the API and reads/writes Postgres;
the **Settings → Data source & workspace** panel shows the live connection and
the current (session-bound) workspace.

## Database

### Connection string

The API/scripts read the **first** of these env vars that is present, in order:

```
DATABASE_URL, POSTGRES_URL, DATABASE_URL_UNPOOLED,
POSTGRES_PRISMA_URL, POSTGRES_URL_NON_POOLING, NEON_DATABASE_URL
```

Copy `.env.example` to `.env` and set `DATABASE_URL` to your Neon **pooled**
connection string. On Vercel, set the same variable under
**Project → Settings → Environment Variables** (the Neon/Vercel integration
usually sets `DATABASE_URL` automatically).

### Schema & seeds

The schema is defined once in `api/_lib/schema.ts` and mirrored, for humans, in
`migrations/0001_init.sql`. It is **idempotent** (`CREATE TABLE IF NOT EXISTS`),
and is applied automatically by the API on first request (`/api/health`).
Forward-only column/table additions live in `api/_lib/migrations.ts` and run on
every cold start, so a previously-seeded database is upgraded without a wipe.

You can also run it from the CLI (these require `DATABASE_URL` and a network that
can reach Neon — they do **not** run inside a restricted sandbox):

```bash
npm run db:migrate          # apply the schema
npm run db:seed             # seed the two demo tenants if the DB is empty
npm run db:seed -- --reset  # wipe + reseed the two demo tenants
```

### Multi-tenancy

Every business row carries a `tenant_id`. A **tenant** is one GoHighLevel
location / sub-account; tenants roll up to an optional `agency_account`. Two
tenants are seeded to prove isolation:

| slug   | name                        | GHL location id     | data                         |
|--------|-----------------------------|---------------------|------------------------------|
| `demo` | Northwind Agency — Demo     | `ghl_loc_demo_001`  | full demo dataset            |
| `acme` | Acme Partners               | `ghl_loc_acme_002`  | scaled-down variant          |

The active tenant is **fixed by the authenticated session** (derived server-side
from the logged-in user), so a user only ever sees their own tenant's isolated
rows. To act in another tenant, log in as a user there.

### Tables

`agency_accounts`, `tenants`, `ghl_connections`, `users`, `sessions`,
`salespeople`, `commission_plans`, `commission_rules`, `clients`, `payments`,
`commission_ledger`, `payout_batches`, `payout_batch_entries`, `payout_events`,
`affiliate_applications`, `settings`, `projection_assumptions`, `audit_logs`,
`integration_events`, plus `schema_migrations`.

GoHighLevel-readiness lives in the schema today (nullable / unused until the
integration phase): `tenants.ghl_location_id`, `clients.ghl_contact_id` /
`ghl_opportunity_id`, `payments.source` / `external_payment_id`, and the
dedicated `ghl_connections` + `integration_events` tables — so the OAuth install
and webhook work can be added **without a migration of existing data**.

## API

Serverless routes under `/api` (Vercel Node runtime). All data routes require
an authenticated session; the **tenant is derived from the session**, never the
client.

Auth:
- `POST /api/auth/login` — `{ email, password, tenant? }`; sets an httpOnly
  session cookie and returns the user.
- `POST /api/auth/logout` — destroys the session.
- `GET  /api/auth/me` — the current user, or 401.

Data:
- `GET  /api/state` — the current user's `AppData`, scoped to their tenant **and
  role** (owner/admin = whole tenant; sales_manager = their team; salesperson /
  affiliate / partner = only their own rows), plus a `mode` block telling the
  browser store who owns the data.
- ~~`PUT /api/state`~~ — **removed**; answers 410 with the per-resource map.
- `GET/POST/PATCH/DELETE /api/clients`, `/api/salespeople`, `/api/payments` —
  single-row writes; a commission-affecting change recomputes that client's
  ledger in the same transaction.
- `GET/POST/PUT/DELETE /api/plans` — plans, rules and timing (+ duplicate,
  reorder).
- `GET/POST /api/ledger` — the ledger, plus `?action=release|recompute`.
- `GET  /api/payouts` — payouts visible to the user + their audit history.
- `GET  /api/payouts?resource=balance` — a rep's reconciled, withdrawable balance.
- `POST /api/payouts` — `submit | request_withdrawal | approve | reject |
  mark_paid | cancel`; real per-resource DB writes with role checks, logged to
  `payout_events`.

Ops/diagnostics:
- `GET  /api/health` — DB connectivity, Postgres version, per-tenant counts.
- `GET  /api/tenants` — tenant list (diagnostic).
- `POST /api/seed` (`?reset=1`) — seed/reseed demo tenants + role users.

### Demo logins (password `demo1234` for all)

Two workspaces (`demo`, `acme`); each has one user per role:

| Role          | Email (demo workspace)        |
| ------------- | ----------------------------- |
| owner         | `owner@demo.example.com`      |
| admin         | `admin@demo.example.com`      |
| sales_manager | `manager@demo.example.com`    |
| salesperson   | `rep@demo.example.com`        |
| affiliate     | `affiliate@demo.example.com`  |
| partner       | `partner@demo.example.com`    |

(Swap `demo` → `acme` for the second workspace.) These are seeded demo
credentials — rotate/disable before production.

## Architecture

```
api/
  _lib/
    db.ts            # Neon serverless Pool (WebSocket) + env-var resolution
    schema.ts        # canonical SQL schema (source of truth) + child-first order
    migrations.ts    # forward-only idempotent ALTERs / new tables (auth, sessions, payout_events)
    auth.ts          # scrypt password hashing + DB-backed sessions + cookies
    auth-seed.ts     # one user per role per tenant; links portals + manager teams
    repository.ts    # ensureSchema, role-scoped reads, seeding (writeState = seed path only)
    recompute.ts     # pure ledger recompute: stable ids, timing, verification gate
    payouts.ts       # payout workflow + withdrawal requests + audit history
    balance.ts       # pure rep balance reconciliation
    payment-events.ts# pure webhook normalization (did the client actually pay?)
    clawbacks.ts     # pure refund / chargeback reversal plan
    runtime-env.ts   # deployment environment + local-fallback policy
  auth/{login,logout,me}.ts   # session endpoints
  state.ts           # GET (role-scoped) only — the PUT snapshot was removed
  clients.ts         # GET/POST/PATCH/DELETE one client
  payouts.ts         # GET list + balance / POST workflow actions
  health.ts, tenants.ts, seed.ts
src/
  types/             # the whole data model (serializable, GHL/DB-swap friendly)
  lib/
    commission-engine.ts  # pure, deterministic projection + payment calc (tested)
    ledger.ts             # derive the live ledger; status logic
    analytics.ts          # totals, rollups, monthly series for charts
    roles.ts              # role labels, home paths, route access map (client guard)
    payouts-client.ts     # client for the /api/payouts workflow
    storage/apiStore.ts      # HybridStore: reads /api/state; local cache only where no server owns the data
    storage/fallback-policy.ts # when a cached read / local write is permitted
    commission-breakdown.ts  # step-by-step explanation of one ledger line
  store/AuthContext.tsx # current user + login/logout
  store/AppContext.tsx  # global state (useReducer) + reload(); tenant/role from session
  pages/                # Login, Reports, Payouts, portals, admin sections
```

### Why the engine is separate

All commission math lives in `commission-engine.ts` as pure functions with no UI
or storage dependencies, covered by unit tests. The same functions power the
live preview, the projection page, the recruiting view, and the real ledger — so
what a candidate is shown and what actually gets paid come from one source of
truth.

### How persistence works (per-resource writes)

`src/lib/storage/index.ts` defines a `DataStore` interface
(`load` / `save` / `clear` / `name`). `apiStore.ts` implements it as a
**HybridStore** that reads the session-scoped dataset from `/api/state`. It no
longer writes to the server at all — every mutation goes through a per-resource
endpoint — so `save()` only maintains the local cache, and only where no server
owns the data.

Reads classify the failure rather than answering everything from cache: a 401/403
propagates (a dead session must not look like a healthy dashboard), an *absent*
API (`vite dev` answering with the SPA shell) legitimately falls back, and an
*outage* (5xx/network) may only be answered from cache where the deployment
policy allows it — never in production or preview. See
[`docs/FEATURES.md` §23](docs/FEATURES.md#23-data-integrity-model).

## Kleegr Smart Productivity integration

This app integrates with GoHighLevel **exclusively through Kleegr Smart
Productivity** (a white-label bridge). There is **no direct GoHighLevel OAuth,
API call, or webhook** anywhere in this codebase — Kleegr owns the GoHighLevel
layer, and every server↔Kleegr call authenticates with the integration token by
name only. All Kleegr secrets are read server-side from environment variables
and are never logged, returned to the browser, or placed in the manifest.

### Launch flow

Kleegr opens the app at **`/kleegr/launch`** (rewritten to the
`/api/kleegr/launch` serverless function) with a short-lived launch token. The
handler verifies the token with Kleegr, validates the claims (`valid`,
`aud = sales-commission-manager`, `exp`, `sp_user_id`, `sub_account_id`), maps
the Kleegr role, upserts the tenant (sub-account) and the user, mints **our own**
session, runs a small first sync, reports `connected` back to Kleegr, and hands
off into the right workspace. The Kleegr launch token is used **once** and is
never cached, reused, persisted, or sent to the browser.

#### Session transport (mobile WebViews)

The launch does **not** finish with a 302. Smart Productivity frames this app,
and inside that iframe our `scm_session` cookie is *third-party* — iOS WebKit
and Android WebView block third-party cookies outright, so the cookie set on a
redirect response was dropped and the user landed on the manual
"Sign in to your workspace" screen despite a successful launch.

The session is therefore delivered over **two transports**:

| Transport                                    | Set by                     | Used for                        |
| -------------------------------------------- | -------------------------- | ------------------------------- |
| `scm_session` httpOnly cookie                | `setSessionCookie()`       | direct (non-framed) web browsing |
| `Authorization: Bearer <token>`              | client, from localStorage  | the embedded / mobile iframe     |

The launch returns a small HTML handoff document
(`api/_lib/launch-handoff.ts`) that writes the session token to
`localStorage["scm_session_token"]` — *first-party* to this origin, so a WebView
allows it — and then `location.replace()`s into the workspace. The cookie is
still set on that same response, so nothing about standard web login changes.

On the client, `src/lib/api-auth.ts` patches `window.fetch` once at boot and
attaches the Bearer header to every **same-origin `/api/*`** request (never
cross-origin, never over a caller's own `Authorization` header, and never on
`/api/kleegr/launch` or `/api/kleegr/sync`, where a Bearer header means a Kleegr
launch token instead).

On the server, `getSessionTokens()` in `api/_lib/auth.ts` offers the Bearer
token first and the cookie second; both are validated by the *same* `sessions`
row lookup, so a Bearer session is neither more nor less privileged than a
cookie session, and a stale token in either transport simply falls through to
the other. Logout revokes both.

### Role mapping

| Kleegr role     | Context          | App role        |
| --------------- | ---------------- | --------------- |
| `agency_admin`  | agency placement | `owner`         |
| `agency_admin`  | sub-account      | `admin`         |
| `manager`       | —                | `sales_manager` |
| `user`          | —                | `salesperson`   |
| unknown / empty | —                | `salesperson`   |

An unknown or missing role always maps to the most limited role (`salesperson`)
— never `owner`.

### Data mapping

A Kleegr/GHL **contact** and its **opportunity** both map onto our existing
`clients` table (a client already models contact + opportunity in this schema).
Imported rows are labelled via `clients.kleegr_source` — `kleegr_imported` for
rows the sync created, `kleegr_linked` for existing rows it matched. Every
upsert is **idempotent**: rows are matched by their Kleegr/GHL ids, so a
re-launch or a repeated webhook never duplicates data, and manually-entered
business data is linked rather than overwritten. (`writeState` — now the seeding
path only — still captures and restores these external-id columns around its
replace-all, since the `AppData` shape does not carry them.)

Kleegr also forwards the **payment lifecycle**: a succeeded charge records a
verified payment and recomputes the client, which is what releases the
commission, and a refund or chargeback books an automatic clawback. See
[`docs/FEATURES.md` §15](docs/FEATURES.md#15-kleegr--gohighlevel-integration).

### Webhooks

Kleegr posts events to **`/api/kleegr/webhook`**, signed with **HMAC-SHA256 over
the raw request body** and sent as the `X-SP-Signature` header. Verification
**fails closed**: a missing webhook secret is a server misconfiguration and
returns **500**; a missing or invalid signature returns **401**; only a valid
signature is processed (and events are recorded idempotently by delivery id).
The handled events are `app.installed`, `subaccount.connected`,
`subaccount.disconnected`, `contact.created`, `contact.updated`,
`opportunity.created`, and `opportunity.updated`.

### Manifest

The manifest Kleegr imports is **`smart-productivity.app.json`** at the repo
root. An identical, typed copy lives in `api/_lib/kleegr-manifest.ts` for the
serverless routes to use, and a unit test asserts the two never drift. The
manifest contains **no secrets** — only env-var names appear, in the setup
instructions.

### Settings UI

**Settings → Kleegr Integration** (`/settings/integrations/kleegr`, owner/admin
only) shows the connection status, the Kleegr sub-account and GoHighLevel
location ids, the connected user and their role, the last sync time, the
imported / linked / synced-user counts, and which server env vars are present.
It also has buttons to **test the connection** (server-side token verify),
**validate the manifest** (Kleegr dry-run import), and **report status** back to
Kleegr.

### Required Vercel env vars (server-side only)

| Variable                   | Used for                                               |
| -------------------------- | ------------------------------------------------------ |
| `KLEEGR_API_BASE_URL`      | Base URL of the Kleegr Smart Productivity API          |
| `KLEEGR_INTEGRATION_TOKEN` | Server↔Kleegr token (verify, status, manifest dry-run) |
| `KLEEGR_WEBHOOK_SECRET`    | HMAC secret to verify inbound webhook signatures       |

Set all three for **Production** and **Preview**. They are read by name only and
must never be committed.

## Deploy

The project is connected to Vercel and **auto-deploys on push to `main`**.
`vercel.json` sets the build command (`npm run build`), output directory
(`dist`), and a SPA rewrite that **excludes `/api`** so the serverless functions
are not shadowed:

```json
{ "source": "/((?!api/).*)", "destination": "/index.html" }
```

Required env var on Vercel: **`DATABASE_URL`** (Neon pooled connection string).
After it is set, the next deployment (or a redeploy) will connect; visit
`/api/health` to confirm `ok: true`.

## What's done in this phase / next steps

Done in this phase:
- **Real authentication** — scrypt-hashed passwords, DB-backed sessions
  (httpOnly cookie), `/api/auth/*`, and one seeded user per role per tenant.
- **Role-based portals + server-enforced isolation** — `/api/state` scopes data
  by tenant and role; scoped roles physically never receive other users' rows,
  and every write is a role-checked single-row endpoint.
- **Real payout workflow** — `/api/payouts` does per-resource DB writes
  (submit → approve → reject → mark paid → claw back/cancel) with role checks
  and an append-only `payout_events` history. These tables are server-owned and
  each batch stores an immutable snapshot of its lines, so history survives any
  later edit or re-price. Reps can raise their own **withdrawal requests**
  against a server-reconciled balance.
- **Reports** — revenue, commission liability/paid/pending/projected,
  salesperson & affiliate performance, top clients — all role/tenant scoped.
- **Kleegr Smart Productivity integration** — launch/SSO, role mapping, a safe
  idempotent sync, signed webhooks, status reporting, and a settings page, all
  brokered through Kleegr (no direct GoHighLevel access).

Next steps:
- **A public affiliate-signup endpoint.** `src/pages/AffiliateSignup.tsx` is
  unrouted and is the one component still writing only to the local reducer; the
  `affiliate_applications` table is waiting for an endpoint with its own rate
  limiting.
- **Deepen the Kleegr sync.** The first sync is intentionally small; add
  pagination, conversations, and write-back as Kleegr exposes those resources.
- **Password reset / user management UI**, session revocation, and rate limiting
  on login.
- **Code-split** the bundle (currently one ~730 kB chunk).

---

*Figures are deterministic projections from plan rules, not financial guarantees.*
