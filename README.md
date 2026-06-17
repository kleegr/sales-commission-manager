# Sales Commission, Affiliate & Partner Management

An interactive system for designing commission plans and seeing exactly what they
pay — month by month, year by year — for salespeople, affiliates, and partners.

The headline feature is a **deterministic, code-based commission engine**. No AI
decides commissions: every dollar traces back to a specific rule, and the UI
shows which rule fired, when it starts and stops, what continues forever, and how
earnings change with closings and churn.

> **Data layer:** the app now runs on a real **multi-tenant Neon (Postgres)
> database** through serverless API routes, with automatic fallback to browser
> `localStorage` when no database is reachable (e.g. `vite dev` with no
> functions, or before `DATABASE_URL` is configured). The commission engine and
> the entire UI are unchanged — persistence is fully behind a small `DataStore`
> seam, so the same code reads/writes Postgres in production and `localStorage`
> locally. The schema is **GoHighLevel-ready** for a future marketplace /
> sub-account integration.

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

- Demo mode is controlled by the `DEMO_MODE` env var and is **ON by default**.
  Set `DEMO_MODE=off` (or `0`/`false`/`disabled`/`no`) to require real login.
- The bypass only ever resolves to an **existing seeded demo user** for the
  chosen tenant + role — it never invents an identity. A real password session
  (cookie `scm_session`) always takes precedence over the demo bypass.
- The selected tenant/role is stored in the cookies `scm_demo_tenant` /
  `scm_demo_role`; tenant + role still come from the server, and every query is
  filtered by `tenant_id`, so tenants remain fully data-isolated in demo mode.

> ⚠️ **Security:** `DEMO_MODE` must be turned **off** before the app holds any
> real customer data. While it is on, anyone with the URL can view any seeded
> demo tenant without a password.

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
npm test         # commission-engine (29) + auth (8) unit tests
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
  affiliate / partner = only their own rows).
- `PUT  /api/state` — replace the tenant's snapshot transactionally
  (**owner/admin only**; writes an `audit_logs` row).
- `GET/POST /api/clients` — list (role-scoped) / create ONE client (real
  single-row insert, not a snapshot replace).
- `GET  /api/payouts` — payouts visible to the user + their audit history.
- `POST /api/payouts` — `submit | approve | reject | mark_paid | cancel`; real
  per-resource DB writes with role checks, logged to `payout_events`.

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
    repository.ts    # ensureSchema, read/role-scoped-read/write AppData, seeding
    payouts.ts       # real per-resource payout workflow + audit history
  auth/{login,logout,me}.ts   # session endpoints
  state.ts           # GET (role-scoped) / PUT (owner-admin) /api/state
  clients.ts         # GET/POST one client (per-resource write example)
  payouts.ts         # GET list / POST workflow actions
  health.ts, tenants.ts, seed.ts
src/
  types/             # the whole data model (serializable, GHL/DB-swap friendly)
  lib/
    commission-engine.ts  # pure, deterministic projection + payment calc (tested)
    ledger.ts             # derive the live ledger; status logic
    analytics.ts          # totals, rollups, monthly series for charts
    roles.ts              # role labels, home paths, route access map (client guard)
    payouts-client.ts     # client for the /api/payouts workflow
    storage/apiStore.ts   # HybridStore: session-scoped Neon API first, localStorage fallback
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

### How persistence works (the snapshot seam + per-resource writes)

`src/lib/storage/index.ts` defines a `DataStore` interface
(`load` / `save` / `clear` / `name`). `apiStore.ts` implements it as a
**HybridStore**: on first load it reads the session-scoped dataset from
`/api/state`; if the API + DB are reachable it reads/writes Postgres (debounced
PUTs, owner/admin only), otherwise it falls back to `localStorage`.

The snapshot `PUT /api/state` is a transactional per-tenant replace. The newer,
role-aware workflows (payouts; `/api/clients` create) are **real per-resource
writes** that do NOT replace the tenant — they are the pattern for migrating the
remaining resources off the snapshot. The payout tables are server-owned and
excluded from the snapshot replace so their workflow state + history survive
admin edits elsewhere.

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
  and snapshot writes are owner/admin only.
- **Real payout workflow** — `/api/payouts` does per-resource DB writes
  (submit → approve → reject → mark paid → claw back/cancel) with role checks
  and an append-only `payout_events` history. These tables are server-owned and
  excluded from the snapshot replace, so history survives admin edits.
- **Reports** — revenue, commission liability/paid/pending/projected,
  salesperson & affiliate performance, top clients — all role/tenant scoped.

Next steps:
- **Migrate remaining writes off the snapshot.** People/plans/clients/payments
  still use `PUT /api/state` (replace-all). Add per-resource endpoints like the
  `/api/clients` and `/api/payouts` examples. Known limitation: editing the
  underlying payments/plans after a payout exists can stale that batch's exact
  line linkage (the batch + history + totals are preserved).
- **GoHighLevel integration.** Schema is ready (`ghl_connections`,
  `integration_events`, `ghl_*` id columns). Next: OAuth install flow + webhook
  handlers + contact/payment/opportunity sync, per `ghl_location_id`.
- **Password reset / user management UI**, session revocation, and rate limiting
  on login.
- **Code-split** the bundle (currently one ~730 kB chunk).

---

*Figures are deterministic projections from plan rules, not financial guarantees.*
