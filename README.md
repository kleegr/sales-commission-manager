# Sales Commission, Affiliate & Partner Management

A standalone, interactive **prototype** for designing commission plans and seeing
exactly what they pay — month by month, year by year — for salespeople,
affiliates, and partners.

The headline feature is a **deterministic, code-based commission engine**. No AI
decides commissions: every dollar traces back to a specific rule, and the UI
shows which rule fired, when it starts and stops, what continues forever, and how
earnings change with closings and churn.

> **Prototype scope:** all data lives in your browser (in-memory + `localStorage`).
> There is no backend, no real database, no Stripe, and no GoHighLevel API. The
> storage layer is deliberately behind a small interface so it can later be
> swapped for GoHighLevel Custom Objects / Contacts / Payments / Affiliate
> Manager or an external database **without touching the UI or the engine**.

## Run it

```bash
npm install
npm run dev      # start the dev server (Vite)
```

Then open the printed local URL. The app seeds a full demo dataset on first run.

```bash
npm run build    # type-check + production build
npm run preview  # preview the production build
npm test         # run the commission-engine unit tests (29 cases)
```

Requires Node 18+ (developed on Node 22).

## What's inside

- **Dashboard** — revenue, commissions owed/paid/projected, active people &
  clients, earned-vs-projected chart, per-rep performance, date-range filter,
  dark mode.
- **People** (salespeople / affiliates / partners) — CRUD, per-person detail
  pages with assigned clients, earnings breakdowns and charts, plus a
  pending-affiliate approval queue.
- **Commission Plan Builder** — the core UI. Stack flexible rules: setup fee
  (none / % / fixed), signup bonus (flat), monthly residual (multiple, with
  start/end month or "continue forever"), and salary (weekly, optional cap).
  Add / edit / delete / duplicate, drag-to-reorder with visual indicators, an
  intelligent next-start-month suggestion, and a **live projection preview**.
  Number inputs never trap a leading zero.
- **Plan Projection** — dedicated month-by-month table grouped by year
  (expand/collapse), each rule shown separately plus a monthly total, setup and
  signup called out up front, totals for the first 12 / 24 / 60 months and
  lifetime, charts, and **per-client _and_ book-of-business** modes with
  adjustable assumptions (avg setup, avg monthly, closings/month, churn). CSV and
  print-to-PDF export.
- **Clients** — CRUD with company/contact, assigned rep, signup date, setup fee,
  monthly subscription, status (active / paused / canceled / refunded), notes.
- **Payments** — record setup fees, monthly subscriptions, refunds, and
  adjustments; commissions are calculated automatically and you can see exactly
  which commissions each payment generated.
- **Commission Ledger** — every line: rep, client, payment, the rule used, the
  rate, the dollar amount, status, due/paid dates. Filter by person, status, and
  date range; future lines show **Projected** until due, then **Pending**. CSV
  export.
- **Payouts** — bundle eligible commissions and run the **two-step approval**
  workflow (submit → approve → mark paid, with reject), plus full history.
- **Salesperson Portal** — a simulated rep login that shows only that person's
  clients, earnings, and payout history.
- **Affiliate Signup** — a public-style application form that creates a *pending*
  affiliate for admin review.
- **Recruiting Presentation** — a clean, candidate-facing view of a plan's
  structure, example earnings, and a 5-year projection.
- **Settings** — company name, theme, default projection assumptions, JSON
  import/export, and reset-to-demo.

## Architecture

```
src/
  types/                # the whole data model (serializable, GHL/DB-swap friendly)
  lib/
    commission-engine.ts  # pure, deterministic projection + payment calculation (tested)
    commission-engine.test.ts
    ledger.ts             # derive the live ledger; projected-vs-real status logic
    analytics.ts          # totals, rollups, monthly series for charts
    demo-data.ts          # the seeded demo dataset
    format.ts             # formatting + small date helpers
    export.ts             # CSV / JSON / print-to-PDF helpers
    storage/
      index.ts            # DataStore interface  ← the swap seam
      localStorage.ts     # browser implementation used by the prototype
  store/AppContext.tsx  # global state (useReducer) persisted to storage
  components/           # UI primitives, charts, plan builder, layout
  pages/                # one file per section above
```

### Why the engine is separate

All commission math lives in `commission-engine.ts` as pure functions with no UI
or storage dependencies, covered by unit tests. The same functions power the
live preview, the projection page, the recruiting view, and the real ledger —
so what a candidate is shown and what actually gets paid come from one source of
truth.

### Swapping storage later

`src/lib/storage/index.ts` defines a `DataStore` interface
(`load` / `save` / `clear` / `name`). The prototype ships a `localStorage`
implementation. A future GoHighLevel or database adapter only needs to implement
the same interface; nothing else changes.

---

*Built as a prototype. Figures are deterministic projections from plan rules, not
financial guarantees.*
