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
npm test         # run the commission-engine unit tests (29 cases)
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

With `vercel dev` running, the app detects the API, reads/writes Postgres, and
the **Settings → Data source & workspace** panel shows the live connection and a
tenant switcher.

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

The active tenant is stored client-side (`scm.tenant`, default `demo`) and can be
switched from **Settings → Data source & workspace**. Switching re-hydrates the
whole app from that tenant's isolated rows.

### Tables

`agency_accounts`, `tenants`, `ghl_connections`, `users`, `salespeople`,
`commission_plans`, `commission_rules`, `clients`, `payments`,
`commission_ledger`, `payout_batches`, `payout_batch_entries`,
`affiliate_applications`, `settings`, `projection_assumptions`, `audit_logs`,
`integration_events`, plus `schema_migrations`.

GoHighLevel-readiness lives in the schema today (nullable / unused until the
integration phase): `tenants.ghl_location_id`, `clients.ghl_contact_id` /
`ghl_opportunity_id`, `payments.source` / `external_payment_id`, and the
dedicated `ghl_connections` + `integration_events` tables — so the OAuth install
and webhook work can be added **without a migration of existing data**.

## API

Serverless routes under `/api` (Vercel Node runtime):

- `GET /api/health` — is the database real & working? Confirms the connection
  string, ensures the schema, seeds demo tenants on a cold DB (proves a **write**),
  and returns the Postgres version + per-tenant row counts (proves a **read**).
- `GET /api/tenants` — the list of tenants/locations (powers the switcher).
- `GET /api/state?tenant=<slug>` — the full `AppData` snapshot for a tenant.
- `PUT /api/state?tenant=<slug>` — replace a tenant's data transactionally
  (writes an `audit_logs` row each save).
- `POST /api/seed` (`?reset=1` to force) — seed/reseed demo tenants.

## Architecture

```
api/
  _lib/
    db.ts            # Neon serverless Pool (WebSocket) + env-var resolution
    schema.ts        # canonical SQL schema (source of truth) + child-first order
    repository.ts    # ensureSchema, read/write a tenant's AppData, seeding
  health.ts          # GET /api/health  (self-init + report)
  state.ts           # GET/PUT /api/state  (per-tenant snapshot)
  tenants.ts         # GET /api/tenants
  seed.ts            # POST /api/seed
migrations/
  0001_init.sql      # human-readable mirror of schema.ts
scripts/
  migrate.ts         # npm run db:migrate
  seed.ts            # npm run db:seed
src/
  types/             # the whole data model (serializable, GHL/DB-swap friendly)
  lib/
    commission-engine.ts  # pure, deterministic projection + payment calc (tested)
    commission-engine.test.ts
    ledger.ts             # derive the live ledger; projected-vs-real status logic
    analytics.ts          # totals, rollups, monthly series for charts
    demo-data.ts          # the seeded demo dataset (also used to seed Postgres)
    format.ts             # formatting + small date helpers
    export.ts             # CSV / JSON / print-to-PDF helpers
    storage/
      index.ts            # DataStore interface  ← the swap seam
      localStorage.ts     # browser implementation (fallback)
      apiStore.ts         # HybridStore: Neon API first, localStorage fallback
  store/AppContext.tsx  # global state (useReducer); exposes backend + tenant + switchTenant
  components/           # UI primitives, charts, plan builder, layout (live data-source badge)
  pages/                # one file per section (Settings has the data-source/tenant panel)
```

### Why the engine is separate

All commission math lives in `commission-engine.ts` as pure functions with no UI
or storage dependencies, covered by unit tests. The same functions power the
live preview, the projection page, the recruiting view, and the real ledger — so
what a candidate is shown and what actually gets paid come from one source of
truth.

### How persistence works (the snapshot seam)

`src/lib/storage/index.ts` defines a `DataStore` interface
(`load` / `save` / `clear` / `name`). `apiStore.ts` implements it as a
**HybridStore**: on first load it probes `/api/state`; if the API + DB are
reachable it reads/writes the active tenant in Postgres (debounced PUTs), and
otherwise it falls back to `localStorage`. Because it satisfies the same
interface, **nothing in the engine, reducer, or pages changed**. On the server,
`writeState` performs a transactional per-tenant replace into the normalized
relational tables; `readState` rebuilds the exact `AppData` snapshot.

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

## What's still local / next steps

- **Auth is not real yet.** The Salesperson Portal and Affiliate Signup are
  simulated. Next: real authentication (JWT/session) and per-role access using
  the existing `users` table.
- **Writes are snapshot-based.** `PUT /api/state` replaces a tenant's data as one
  transaction (last-write-wins). For concurrent multi-user editing, add granular
  REST endpoints per resource (the normalized tables already support this).
- **GoHighLevel integration.** The schema is ready; the next phase is the OAuth
  install flow + webhook handlers writing to `ghl_connections` /
  `integration_events`, and syncing `clients.ghl_contact_id` etc.
- **Reporting & portals** can be built on the relational tables (indexes for
  tenant-scoped lookups are in place).

---

*Figures are deterministic projections from plan rules, not financial guarantees.*
