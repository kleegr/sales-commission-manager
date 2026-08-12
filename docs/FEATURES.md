# Sales Commission Manager — Complete Feature & Function Reference

A full catalogue of everything the application does: every product area, every
screen, every role, every API endpoint, and every calculation function.

The app is a **multi-tenant commission management system** for salespeople,
affiliates and partners. Its centre of gravity is a **deterministic, code-based
commission engine** — no AI decides commissions; every dollar traces back to a
named rule, and the UI always shows which rule fired, when it starts and stops,
what continues forever, and how earnings change with closings and churn.

**Stack:** React 18 + TypeScript + Vite + Tailwind + Recharts SPA, Vercel Node
serverless functions under `/api`, Neon (Postgres) storage, with an automatic
`localStorage` fallback. GoHighLevel is reached **only** through the Kleegr Smart
Productivity bridge.

---

## Table of contents

1. [Product areas at a glance](#1-product-areas-at-a-glance)
2. [Roles, access and navigation](#2-roles-access-and-navigation)
3. [Commission plans & the rule engine](#3-commission-plans--the-rule-engine)
4. [Commission timing: holds, releases, clawbacks](#4-commission-timing-holds-releases-clawbacks)
5. [People, clients and payments](#5-people-clients-and-payments)
6. [The commission ledger](#6-the-commission-ledger)
7. [Payout workflow](#7-payout-workflow)
8. [Projections, recruiting view and analytics](#8-projections-recruiting-view-and-analytics)
9. [Goals & milestones](#9-goals--milestones)
10. [Proposals, contracts & AI business setup](#10-proposals-contracts--ai-business-setup)
11. [Self-service portals](#11-self-service-portals)
12. [Agency control (multi-sub-account)](#12-agency-control-multi-sub-account)
13. [Feature access (per-tenant entitlements)](#13-feature-access-per-tenant-entitlements)
14. [Settings, data management & reporting exports](#14-settings-data-management--reporting-exports)
15. [Kleegr / GoHighLevel integration](#15-kleegr--gohighlevel-integration)
16. [Authentication, sessions & security](#16-authentication-sessions--security)
17. [Demo / review mode](#17-demo--review-mode)
18. [Data model & database tables](#18-data-model--database-tables)
19. [API reference](#19-api-reference)
20. [Function reference (by module)](#20-function-reference-by-module)
21. [UI system, layout and embedded shell](#21-ui-system-layout-and-embedded-shell)
22. [Operations, testing and deployment](#22-operations-testing-and-deployment)

---

## 1. Product areas at a glance

| Area | Route | What it does |
| --- | --- | --- |
| Dashboard | `/` | Sub-account KPIs, charts, leaderboard, setup checklist, "needs attention" queue |
| Agency Control | `/agency` | Cross-sub-account rollup for the agency owner |
| Salespeople / Affiliates / Partners | `/people`, `/people/:id` | Roster, plan assignment, salary, approvals |
| Commission Plans | `/plans`, `/plans/new`, `/plans/:id/edit` | Rule-based plan builder with live preview |
| Plan Projection | `/plans/:id/projection` | Per-client and whole-book earnings modelling |
| Clients | `/clients`, `/clients/:id` | Accounts, assigned rep, revenue, documents, activity |
| Payments | `/payments` | Record what clients paid; commissions recompute automatically |
| Commission Ledger | `/ledger` | Every commission line, its rule, status, hold and release date |
| Payouts | `/payouts` | Bundle → submit → approve → mark paid, with audit history |
| Reports | `/reports` | Revenue, liability, performance, top clients, CSV/PDF export |
| Goals & Milestones | `/goals` | Targets per person/team/company with live progress and pace |
| Proposals & Contracts | `/documents` | Section-based templates, client documents, AI drafting |
| Recruiting View | `/present` | Candidate-facing presentation of what a plan pays |
| My Portal | `/portal` | Salesperson or affiliate/partner self-service portal |
| Settings | `/settings` | Company details, projection defaults, feature access, data source |
| Kleegr Integration | `/settings/integrations/kleegr` | Connection status, sync counts, diagnostics |

---

## 2. Roles, access and navigation

Six roles, defined in `src/lib/roles.ts` (labels, home path, route access map).
The server enforces data scoping independently; the client map drives navigation
and the route guard so the UI matches what the API will actually return.

| Role | Label | Home | Sees |
| --- | --- | --- | --- |
| `owner` | Agency Owner | `/agency` | All sub-accounts, plus any workspace they open |
| `admin` | Admin | `/` | The whole sub-account (tenant) |
| `sales_manager` | Sales Manager | `/` | Their team's people, clients, ledger, reports, goals |
| `salesperson` | Salesperson | `/portal` | Only their own clients, commissions, payouts, documents |
| `affiliate` | Affiliate | `/portal` | Only their own referrals and commissions |
| `partner` | Partner | `/portal` | Same as affiliate |

**Route access matrix** (`ACCESS` in `roles.ts`; longest-prefix match, so
`/plans/new` inherits `/plans`):

| Route | Roles |
| --- | --- |
| `/` | admin, sales_manager |
| `/agency` | owner, admin |
| `/people`, `/plans`, `/payments`, `/present`, `/settings` | owner, admin |
| `/clients`, `/ledger`, `/reports`, `/goals` | owner, admin, sales_manager |
| `/payouts`, `/documents` | all six roles (self-scoped for portal roles) |
| `/portal` | salesperson, affiliate, partner |

**Guard behaviour** (`src/App.tsx`):
- A role hitting a route it may not see is redirected to `homePath(role)`.
- A route disabled by a **feature flag** renders an inline "This area is turned
  off" notice instead of redirecting — so a role whose own home route is gated
  can never enter a redirect loop.
- `/portal` renders `AffiliatePortal` for affiliate/partner and
  `SalespersonPortal` for everyone else.
- Unknown routes redirect to the role's home.

The agency owner is deliberately **not** granted `/`: landing on the
single-sub-account dashboard made them look like an ordinary user and hid the
agency overview.

---

## 3. Commission plans & the rule engine

### Plan structure

A `CommissionPlan` carries a name, description, an **ordered list of rules**, an
optional `CommissionTiming` block, and sample inputs (`sampleSetupFee`,
`sampleMonthly`) stored with the plan so previews are reproducible.

### The four rule types

| Rule | Fields | Behaviour |
| --- | --- | --- |
| **Setup fee** (`setup_fee`) | `mode`: `none` / `percentage` / `fixed`, `value` | Percentage of the setup fee collected, or a flat dollar amount. Paid once, on the setup-fee payment. |
| **Signup bonus** (`signup_bonus`) | `amount` | Flat dollars per new signup, triggered by the setup-fee payment. |
| **Monthly residual** (`monthly_residual`) | `startMonth`, `endMonth`, `continueForever`, `valueType`, `value` | Percentage of the subscription or flat dollars, for an inclusive month range or forever. Multiple residual bands stack (e.g. 70% months 1–3, then 20% months 4+ forever). |
| **Salary** (`salary`) | `weeklyAmount`, `startDate`, `endDate`, `maxWeeks` | Weekly salary. **Preview only** inside a plan — the real ledger uses the person's own `weeklySalary` fields, so the two never double-count. |

### Plan Builder (`/plans/new`, `/plans/:id/edit`)

- Plan details: name, description, sample setup fee, sample monthly.
- **Rule list with drag-to-reorder** (`RuleList.tsx`); order is meaningful for
  display.
- **Rule editor modal** (`RuleEditorModal.tsx`) per rule type, with
  `suggestNextStartMonth()` pre-filling the next residual band as
  `max(existing end) + 1`.
- **Timing editor**: "When does a commission become payable?" — trigger,
  days/months/payments, "pay only while the client is still active", and
  "claw back if the client cancels before N months".
- **Live preview** that recalculates on every keystroke, plus a
  `PlanPreviewModal` and a `TimingExplainer` that puts the timing rule in plain
  English.

### Plans index (`/plans`)

- **Card view and table view** toggle.
- KPI strip: total plans, plans in use, people assigned.
- Filters: by status (in use / not assigned), by rule type (has setup fee /
  signup bonus / residual / salary), by assigned person; plus sorting.
- Per plan: rule-type chips, timing headline, upfront / 1-year / 2-year totals,
  people assigned, and actions — **preview, edit, duplicate, delete**, and open
  the full projection.
- Delete is blocked or warned when the plan is assigned.

### Engine functions (`src/lib/commission-engine.ts`)

Pure, deterministic, unit-tested; the same functions power the live preview, the
projection page, the recruiting view and the real ledger.

| Function | Purpose |
| --- | --- |
| `setupFeeAmount(rule, setupFee)` | Resolve a setup-fee rule to dollars |
| `residualAmount(rule, monthly)` | Resolve a residual rule to dollars |
| `ruleAppliesToMonth(rule, month)` | Whether a residual band covers a 1-based month |
| `setupFeeLabel` / `residualLabel` / `ruleHeadline` | Human-readable rule labels used in tables and the ledger |
| `suggestNextStartMonth(rules)` | Next residual start month |
| `salaryScheduleByMonth(rule, horizon)` | Monthly salary contribution, capped by `maxWeeks` or date range |
| `projectPlanForClient(plan, inputs)` | Month-by-month single-client projection: per-month lines, year totals, 12/24/60-month cumulative totals |
| `calculateCommissionForPayment(payment, client, salesperson, plan)` | The real ledger calculation for one payment → concrete `CommissionEntry` rows |
| `generateSalaryEntries(salesperson, toISO)` | Weekly salary ledger rows from the person's own salary settings |
| `projectBook(plan, assumptions)` | Whole-book, churn-adjusted cohort model: N closings/month, each cohort earning by its own age, shrinking by monthly churn |

Refund and adjustment payments do **not** auto-generate commissions.

---

## 4. Commission timing: holds, releases, clawbacks

`src/lib/commission-timing.ts` decides, for one earned commission, whether it is
payable yet and why. Three outcomes: **held**, **pending** (released and
payable), **clawed_back**.

### The eight supported behaviours

| Behaviour | Configuration |
| --- | --- |
| Pay immediately | `trigger: immediate` (the default) |
| Pay after X days | `trigger: after_days`, `days: X` |
| Pay after X months | `trigger: after_months`, `months: X` |
| Pay after X client payments | `trigger: after_payments`, `payments: X` |
| Hold until a human approves | `trigger: on_approval` |
| Release after a refund window | `trigger: after_refund_window`, `days: X` |
| Pay only while the client is active | `requireActiveClient: true` |
| Claw back on early cancellation | `clawbackBeforeMonths: X` |

### Functions

- `DEFAULT_TIMING` — pay immediately, no conditions (preserves historical
  behaviour for plans with no timing block).
- `normalizeTiming(partial)` — coerce a partial/legacy/persisted object into a
  full, validated timing config.
- `TRIGGERS`, `TRIGGER_LABEL` — the trigger list and their UI labels.
- `timingHeadline(timing)` — one-line summary for plan cards and the builder
  (e.g. "Pays 30 days after earned · active clients only · clawback under 3 mo").
- `resolveCommissionTiming(ctx)` — the resolver: takes timing, earned date,
  as-of date, client status/signup/cancel dates, qualifying payment count and any
  admin override, and returns status, released flag, release date, hold days,
  hold reason and clawback reason.
- `isHeld(status)`, `effectiveDate(...)` — helpers for ledger display and sorting.

Held lines carry `holdReason`, `releaseDate`, `holdDays` and `timingTrigger` so
the ledger can explain exactly what a line is waiting on. An admin **force
release** sets `releasedOverride`, which is sticky across recomputes and bypasses
the trigger and active-client condition (but never the clawback).

---

## 5. People, clients and payments

### People (`/people`, `/people/:id`)

- Roster of salespeople, affiliates and partners with search and a role filter.
- Add / edit person: name, email, phone, role, referral code, status, commission
  plan assignment, notes.
- **Weekly salary** with start and end dates (salespeople).
- **Approval status** for affiliates who self-registered through the public
  signup form (`pending` / `approved` / `rejected`), plus origin tracking
  (`admin` vs `affiliate_portal`) and recruiting metadata (company, website,
  referral source).
- Deactivate (soft) rather than hard-delete.
- **Salesperson detail** page: plan assignment, earned/paid/pending/projected
  KPIs, an earned-vs-projected chart, assigned clients and recent commissions,
  all with a date-range filter.

### Clients (`/clients`, `/clients/:id`)

- Client list with search, status filter (`active`, `paused`, `canceled`,
  `refunded`), assigned rep, signup date, setup fee, monthly subscription.
- **Canceled / refunded date** — anchors the clawback window.
- **Client detail**: lifetime revenue, commissions paid/pending/projected,
  account terms, payment history, commission history, linked proposals and
  contracts, and an activity feed.
- Clients created by the Kleegr sync are labelled `kleegr_imported`; existing
  rows the sync matched are labelled `kleegr_linked`.

### Payments (`/payments`)

- Record what a client paid: client, type (`setup_fee`, `monthly_subscription`,
  `refund`, `adjustment`), date, amount, **payment number** (which subscription
  month), notes.
- Commissions are calculated automatically from the assigned plan's rules the
  moment a payment is recorded — the payments table shows the commission lines
  each payment generated.
- Editing or deleting a payment triggers a **recompute** of that client's ledger.
  A payment whose commissions are already **submitted / approved / paid** is
  **locked**: the delete is refused with a clear explanation rather than
  silently corrupting a payout.

---

## 6. The commission ledger

`/ledger` — "every commission line: which rule fired, what it pays, and where it
stands."

- KPI strip: **Earned (real), Paid, Pending / owed, Held, Projected (future)**.
- Table columns: person, client, payment, base amount, **rule that fired**, rate,
  commission, status, and release information.
- Filters by person, status and date range.
- **Release now** action on a held line (admin) — force-releases it for payout.
- **Recompute** action — regenerates payment-derived lines from current plan
  rules.
- Nine statuses: `projected`, `held`, `pending`, `submitted`, `approved`, `paid`,
  `rejected`, `canceled`, `clawed_back`.
- Future-dated lines display as **Projected** until their due date passes; a
  plan's timing rule can **Hold** a line until its condition is met, at which
  point it becomes **Pending** and enters the payout workflow.

### Ledger functions (`src/lib/ledger.ts`)

- `stampTiming(...)` — apply the plan's timing resolution to a line.
- `displayStatus(...)` — the status a line should show given today's date.
- `recomputePaymentCommissions(data)` — rebuild all payment-derived lines.
- `recomputeSalaryEntries(data)` — rebuild weekly salary lines.
- `computeProjectedLedger(data, months)` — forward-looking projected lines.
- `fullLedger(data, futureMonths = 24)` — the complete view: real + projected.
- `clientLabel(client)` — display helper.

### Server-side recompute (`api/_lib/recompute.ts`)

- `recomputeClientLedger(input)` — the **pure** core: no database, no clock
  beyond the supplied `today`, no randomness in the decision.
- `recomputeClientInTx` / `recomputePlanInTx` / `recomputeTenantInTx` — run the
  core inside a transaction, with `SELECT … FOR UPDATE` serialising concurrent
  recomputes.
- `LOCKED_STATUSES` (`submitted`, `approved`, `paid`) are preserved verbatim and
  block deletion of the underlying payment.
- `MANUAL_STATUSES` — human-set outcomes (`rejected`, `canceled`) keep their
  label across a regenerate even when the row is re-priced.
- `paymentHasLockedCommissions(...)` — the guard the payments endpoint uses.

---

## 7. Payout workflow

`/payouts` — "bundle earned commissions, then submit → approve → mark paid."

### Flow

1. **Select eligible commission lines** (pending/released) with per-row and
   select-all checkboxes, filtered by person.
2. **Submit** → creates a `payout_batches` row with its entry links; lines move
   to `submitted`.
3. **Approve** or **reject** → lines move to `approved` / `rejected`.
4. **Mark paid** → stamps the paid date on the batch and its lines.
5. **Cancel / claw back** → reverses a batch.

### Controls

- KPI strip: eligible to pay, awaiting approval, approved, paid out.
- **Payout history** table with an expandable per-batch audit trail.
- **Separation of duties**: the approver may not be the submitter (`owner` is
  exempt) — `violatesSeparationOfDuties()`.
- **Role gates**: `roleMayTransition()` and `mayActOnBatch()` — approve/reject
  and pay/cancel are owner/admin only; portal roles see only their own batches.
- **Append-only `payout_events` history** — every transition is logged with the
  actor, the from/to status and a note.
- Payout tables are **server-owned** and excluded from the `PUT /api/state`
  snapshot replace, so workflow state and history survive admin edits elsewhere.

---

## 8. Projections, recruiting view and analytics

### Plan projection (`/plans/:id/projection`, `ProjectionView.tsx`)

Two models side by side:

- **Per-client**: month-by-month lines with the rules that applied, year totals,
  and 12 / 24 / 60-month cumulative totals.
- **Whole book**: cohort model — `closingsPerMonth` new clients each month, each
  cohort earning residuals by its own age, shrinking by `monthlyChurnPct`.
  Columns: month, new clients, active clients, setup, bonus, residual, salary,
  total, cumulative.

Adjustable assumptions: average setup fee, average monthly, closings per month,
monthly churn, horizon (up to 60 months), plus **include churn** and **include
salary** toggles. Charts render commission per month and cumulative earnings.
Both models can be **printed to PDF**.

### Recruiting presentation (`/present`)

A clean, candidate-facing view of a chosen plan: upfront per deal, first-year
earnings, "how you get paid" rule cards, per-client earnings by year, book totals
for years 1, 2 and 5, lifetime value per client, and the assumptions used. Backed
by the same engine as the ledger, so what a candidate is shown and what actually
gets paid come from one source of truth.

### Dashboard (`/`)

- KPIs: total revenue, commissions owed, paid commissions, projected (upcoming),
  active salespeople, active clients, total earned, commission plans.
- Earned-vs-projected monthly chart and a salesperson performance chart.
- **Team leaderboard**: clients, earned, pending, projected per person.
- **Setup checklist** (first-run): create a plan → add people → assign plans →
  add a client → record a payment → review the ledger → run your first payout.
  Collapses to a "setup complete" confirmation.
- **Needs attention** queue: people without a commission plan, clients without a
  rep, commissions held and ready to release, payouts awaiting approval, pending
  affiliate/partner applications.

### Reports (`/reports`)

Date-range filtered and role/tenant scoped: revenue, commission liability,
commissions paid, projected (next 24 months); monthly revenue table and chart;
salesperson performance (clients, paid, pending); affiliate performance
(referrals, paid, pending); top clients by revenue. Exportable.

### Analytics functions (`src/lib/analytics.ts`)

`inRange`, `revenueInRange`, `commissionTotals`, `rollupBySalesperson`,
`monthlySeries` — plus `src/lib/plan-analytics.ts` for plan-level summaries:
`planRuleTypes`, `summarizePlanRules`, `planProjectedTotals`,
`commissionByRuleType`, `assignmentsForPlan`, `planUsage`, `planTimingFlags`,
`formatTotals`.

---

## 9. Goals & milestones

`/goals` — "set targets for people, teams, or the whole business; progress is
measured live from real data." Goals are server-owned (`/api/goals`), not part of
the `AppData` snapshot, and **progress is always computed, never stored**.

### Six metrics

| Metric | Measures |
| --- | --- |
| `revenue` | Dollars collected (setup + subscription − refunds) in the period |
| `clients_closed` | New clients signed in the period |
| `referrals` | New referral-sourced clients in the period |
| `mrr` | Current monthly recurring revenue across active clients |
| `commission_earned` | Non-projected commission earned in the period |
| `activity` | Proxy: clients signed + payments recorded in the period |

### Scopes and periods

- Scope: **a salesperson**, **my team** (manager), or **the whole company**.
- Period: **this month**, **this quarter**, or a **custom date range**.
- Status: active or archived.

### Milestones

Sub-thresholds inside a goal, each with a label, a threshold value in the goal's
units, and an optional **reward**. Reached milestones are marked; the next one is
highlighted.

### Functions (`src/lib/goals.ts`)

`monthRange`, `quarterRange`, `inDateRange`, `resolveGoalPeriod`, `metricActual`,
`goalProgress`, `paceProjection` (are you on pace to hit it?), `daysBetween`,
`projectedCommissionPerDeal`, `milestoneViews`, `nextMilestone`.

---

## 10. Proposals, contracts & AI business setup

`/documents` — "build branded proposals and contracts from reusable sections."
Documents are made of **structured, reorderable sections**, not one text blob.

### Tabs

| Tab | Contents |
| --- | --- |
| Business Setup | The tenant's business profile (wizard-driven) |
| Proposal Templates | Reusable proposal templates |
| Contract Templates | Reusable contract templates |
| Client Proposals | Proposals issued to specific clients |
| Client Contracts | Contracts issued to specific clients |
| AI History | Every AI generation, role-scoped |

Tabs appear only when the matching feature flag (`proposals`, `contracts`, `ai`)
is enabled for the tenant.

### Section types

- **Proposal**: cover, problem, solution, scope, deliverables, timeline, pricing,
  addons, terms, next steps, signature.
- **Contract**: parties, payment terms, term length, cancellation, refund,
  confidentiality, responsibilities, disclaimers.
- **Either**: custom.

### Document styles

`modern`, `classic`, `minimal`, `bold` — chosen per template and per document.

### Merge fields

Templates carry tokens such as `{{client_name}}`; when a client document is
created from a template the tokens are **resolved on the server** and baked into
the document's sections. `buildMergeContext()` assembles the values from the
business profile, the client and the salesperson; `applyMergeFields()` and
`applySectionsMerge()` perform the substitution.

### Document lifecycle

`draft → sent → viewed → signed`, with `canceled` available throughout.
`canTransitionStatus()` enforces the legal transitions and
`isTerminalStatus()` marks the end states.

### Operations

Templates: create, update, duplicate, delete, set default.
Sections (on both templates and documents): add, update, delete, reorder.
Client documents: create from a template, update, set status, preview.
All exposed through `POST /api/documents` with an `op` discriminator.

### Business profile wizard (`BusinessWizard.tsx`)

Captures ~25 fields used for merge and AI context: business name, logo, website,
industry, description, services, software, what you sell (services / software /
both), target customers, pricing model, setup fees, monthly fees, packages, scope
of work, deliverables, timeline, payment terms, cancellation terms, refund terms,
contract length, guarantees, brand tone, address, contact email/phone, legal
language, and default proposal/contract styles.

### AI generation (`/api/ai`)

- Server-side only: the model API key is read from the environment and **never**
  sent to the browser.
- Targets: a whole **template**, a whole **document**, a single **section**, or a
  follow-up **email**.
- Gated by the tenant's `ai` feature flag (403 `ai_disabled` when off) and by key
  configuration (409 `ai_not_configured` when unset) — manual templates keep
  working either way.
- Every generation is appended to `ai_generated_content` with its prompt, model,
  target and client, and the history is role-scoped.

---

## 11. Self-service portals

### Salesperson portal (`/portal`)

- KPIs: total earned, paid, pending, projected.
- Earnings-over-time chart.
- My clients (company, monthly, status).
- Recent commissions (client, rule, commission, status).
- My payouts (submitted date, amount, status).
- **Add a lead** — creates a client in the app database assigned to the rep.
- Company-owned clients are badged distinctly from self-sourced ones.

### Affiliate / partner portal (`/portal`)

- **Referral code** panel, prominently displayed and copyable.
- KPIs: pending commission, paid out, projected (next 24 months), my referrals.
- My referrals table (company, contact, referred date, monthly, status).
- Recent commissions and payout history.
- **Submit a referral** — company, contact, email, phone, estimated setup fee,
  estimated monthly, notes.

### Public affiliate signup (`AffiliateSignup.tsx`)

Self-registration form: full name, email, phone, company, website, and "how will
you promote us?". Submissions land as **pending** affiliate applications for an
admin to approve or reject.

### Portal view state (`src/lib/portal-state.ts`)

`portalView({hydrating, hasProfile, linkedSalespersonId, retryExhausted})` returns
`loading` / `ready` / `unlinked` / `unavailable`. This exists to stop a valid rep
from seeing a "No profile found" flash during the first 1–2 seconds of hydration:
`/api/auth/me` returns `salespersonId` before the shell mounts, so the app knows
whether an empty dataset means "still loading" or "genuinely not linked".
`PortalSkeleton.tsx` renders the loading state.

---

## 12. Agency control (multi-sub-account)

`/agency` — the agency owner's home. "All sub-accounts that use the Commission
Manager."

- Agency-wide KPIs: sub-accounts, revenue (net), commission liability,
  commissions paid, people, clients.
- **Sub-account comparison**: revenue by sub-account chart.
- Per sub-account card: revenue, owed, paid, payouts pending; counts of people,
  clients, plans, payments, documents, payouts; the GoHighLevel location id (or
  "GHL location not connected"); **feature access chips** showing which product
  areas are enabled; and an integration status panel.
- "Open from the Kleegr sub-account" — a workspace is entered through Kleegr, not
  by impersonation from this screen.

Backed by `GET /api/agency` and `api/_lib/agency-core.ts`
(`emptyAggregate`, `TenantRollup`, `RawTenantAggregate`) with
`api/_lib/agency-scope.ts` enforcing which tenants the caller may roll up.

---

## 13. Feature access (per-tenant entitlements)

The agency/owner controls which product areas a sub-account may use. Flags are
DB-backed (`tenant_feature_access`), **enabled by default**, and gating **fails
open** — a transient API failure never locks anyone out.

| Flag | Label | Controls |
| --- | --- | --- |
| `commissions` | Commission tracking | `/ledger` — holds, releases, clawbacks |
| `payouts` | Payout workflow | `/payouts` |
| `reports` | Reports & analytics | `/reports` |
| `sales_portal` | Sales portal | `/portal` for salespeople |
| `affiliate_portal` | Affiliate / partner portal | `/portal` for affiliates and partners |
| `proposals` | Proposal system | Proposal tabs in `/documents` |
| `contracts` | Contract system | Contract tabs in `/documents` |
| `ai` | AI generation | AI drafting + AI history |

Enforced in three places: the nav (hides items), the route guard
(`featureAllowsPath()` renders the "turned off" notice), and the **server**
(`readTenantFlags()` / `tenantFeatureEnabled()` gate the document and AI
endpoints). Edited under **Settings → Feature access**; changes save to the
database and take effect immediately.

---

## 14. Settings, data management & reporting exports

`/settings` (owner/admin):

- **General** — company name (shown in the sidebar and on the recruiting view)
  and light/dark **theme**.
- **Projection defaults** — average setup fee, average monthly subscription,
  closings per month, monthly churn, projection horizon (max 60 months). These
  seed every projection and the recruiting view.
- **Feature access** — the entitlement editor described above.
- **Data** — active store name, **Export JSON**, **Import JSON**, **Reset to demo
  data**, and live counts of people, plans, clients and payments.
- **Data source & workspace** — live `/api/health` status: connected to Neon
  Postgres (with the engine version and which env var supplied the connection
  string) or using browser storage; the current session-bound workspace; and a
  per-tenant row-count panel that demonstrates tenant isolation. A re-check
  button re-runs the probe.

### Export helpers (`src/lib/export.ts`)

- `downloadCSV(filename, rows)` — CSV export for report tables.
- `downloadJSON(filename, data)` — full data export/backup.
- `printHTMLToPDF(title, bodyHTML)` — print-to-PDF for projections and the
  recruiting presentation.

---

## 15. Kleegr / GoHighLevel integration

GoHighLevel is reached **exclusively** through Kleegr Smart Productivity, a
white-label bridge. There is **no direct GoHighLevel OAuth, API call or webhook**
anywhere in the codebase. All Kleegr secrets are read server-side from
environment variables by name and are never logged, returned to the browser, or
placed in the manifest.

### Launch / SSO flow (`/api/kleegr/launch`)

1. Kleegr opens the app at `/kleegr/launch` with a short-lived launch token.
2. The handler verifies the token with Kleegr and validates the claims: `valid`,
   `aud = sales-commission-manager`, `exp`, `sp_user_id`, `sub_account_id`.
3. It maps the Kleegr role, upserts the tenant (sub-account) and the user, links
   the user to a salesperson record, mints **our own** session, runs a small
   first sync, reports `connected` back to Kleegr, and hands off into the right
   workspace.
4. The launch token is used **once** — never cached, reused, persisted, or sent
   to the browser.

### Dual session transport (mobile WebViews)

Inside the Kleegr iframe the `scm_session` cookie is *third-party*, and iOS
WebKit / Android WebView block it outright. So the session travels two ways:

| Transport | Set by | Used for |
| --- | --- | --- |
| `scm_session` httpOnly cookie | `setSessionCookie()` | Direct (non-framed) browsing |
| `Authorization: Bearer <token>` | Client, from `localStorage` | The embedded / mobile iframe |

The launch returns an HTML **handoff document** (`launch-handoff.ts`) that writes
the token to `localStorage["scm_session_token"]` — first-party to this origin, so
a WebView allows it — then `location.replace()`s into the workspace. The cookie
is still set on the same response, so standard web login is unchanged.
`src/lib/api-auth.ts` patches `window.fetch` once at boot and attaches the Bearer
header to **same-origin `/api/*`** requests only — never cross-origin, never over
a caller's own `Authorization` header, and never on `/api/kleegr/launch` or
`/api/kleegr/sync` where a Bearer header means a Kleegr launch token.
`getSessionTokens()` offers Bearer first and cookie second; both resolve through
the same `sessions` row, so neither is more privileged. Logout revokes both.

### Role mapping (`kleegr-roles.ts`)

| Kleegr role | Context | App role |
| --- | --- | --- |
| `agency_admin` | agency placement | `owner` |
| `agency_admin` | sub-account | `admin` |
| `manager` | — | `sales_manager` |
| `user` | — | `salesperson` |
| unknown / empty | — | `salesperson` |

An unknown or missing role always maps to the **most limited** role — never
`owner`.

### Data mapping and sync

A Kleegr/GHL **contact** and its **opportunity** both map onto the existing
`clients` table. Imported rows are labelled `kleegr_imported`; matched existing
rows are labelled `kleegr_linked`. Every upsert is **idempotent** — rows are
matched by their Kleegr/GHL ids, so a re-launch or repeated webhook never
duplicates data, and manually-entered business data is linked rather than
overwritten. Because the `PUT /api/state` snapshot doesn't carry the external-id
columns, `writeState` captures and restores them around its replace-all, so an
admin save never wipes a tenant's Kleegr/GHL links.

### Webhooks (`/api/kleegr/webhook`)

Signed with **HMAC-SHA256 over the raw request body**, sent as `X-SP-Signature`.
Verification **fails closed**: a missing webhook secret is a server
misconfiguration and returns **500**; a missing or invalid signature returns
**401**; only a valid signature is processed, and events are recorded
idempotently by delivery id.

Handled events: `app.installed`, `subaccount.connected`,
`subaccount.disconnected`, `contact.created`, `contact.updated`,
`opportunity.created`, `opportunity.updated`.

### Manifest

`smart-productivity.app.json` at the repo root is what Kleegr imports; an
identical typed copy lives in `api/_lib/kleegr-manifest.ts`, and a unit test
asserts the two never drift. The manifest contains **no secrets** — only env-var
names appear, in the setup instructions.

### Settings UI (`/settings/integrations/kleegr`, owner/admin)

Shows connection status, the Kleegr sub-account and GoHighLevel location ids, the
connected user and their Kleegr role, connected-at and last-sync times, imported
/ linked client and synced-user counts, the Kleegr API base URL, which server env
vars are present, the available gateway resources and the subscribed webhook
events. Three actions: **test the connection** (server-side token verify),
**validate the manifest** (Kleegr dry-run import), and **report status** back to
Kleegr.

### Required env vars (server-side only)

`KLEEGR_API_BASE_URL`, `KLEEGR_INTEGRATION_TOKEN`, `KLEEGR_WEBHOOK_SECRET`.

---

## 16. Authentication, sessions & security

- **Passwords**: scrypt-hashed (`api/_lib/auth.ts`).
- **Sessions**: DB-backed rows, delivered as an httpOnly + Secure cookie
  (`scm_session`) and/or a Bearer token; logout revokes both.
- **Login rate limiting** (`api/_lib/rate-limit.ts`): a DB-backed sliding window
  — 10 failed attempts per IP or email within 15 minutes returns 429. Deliberately
  **fail-open** so an infrastructure hiccup can never lock out a real user.
- **CSRF**: `csrfOk(req)` guards every mutating endpoint.
- **Tenant isolation**: every business row carries `tenant_id`; the tenant is
  fixed by the session and never taken from the client. Roles further scope reads
  — scoped roles physically never receive other users' rows.
- **Snapshot writes are owner/admin only** and write an `audit_logs` row.
- **Payout separation of duties**: approver ≠ submitter (owner exempt);
  pay/cancel is owner/admin only; `payout_events` is append-only.
- **Financial concurrency**: recompute serialises with `SELECT … FOR UPDATE`.
- **Kleegr access is server-side only**; webhooks verify HMAC and fail closed.
- **Frame policy**: a `frame-ancestors` CSP allows the white-label GoHighLevel
  domain to frame the app and nothing else.

---

## 17. Demo / review mode

A **Review Mode** lets the app be explored without credentials. A sticky top bar
(`DemoBar.tsx`) switches **tenant** (Demo / Acme) and **role** on the fly:

| Bar button | Role | Lands on |
| --- | --- | --- |
| Agency Owner / Super Admin | `owner` | `/agency` |
| Sub-account Admin | `admin` | `/` |
| Sales Manager | `sales_manager` | `/` |
| Salesperson | `salesperson` | `/portal` |
| Affiliate / Partner | `affiliate` | `/portal` |

Safety properties:

- Controlled by `DEMO_MODE` and **off by default**. In a Vercel **production**
  deployment (`VERCEL_ENV=production`) the no-password bypass is additionally
  **forced off** unless `DEMO_MODE_ALLOW_IN_PRODUCTION` is also set — a
  deliberate two-key action.
- The bypass only ever resolves to an **existing seeded demo user** for the
  chosen tenant + role; it never invents an identity.
- A real password session always takes precedence over the demo bypass.
- Tenant and role still come from the server and every query is `tenant_id`
  filtered, so tenants stay fully isolated in demo mode.

Two seeded workspaces prove isolation: `demo` (Northwind Agency — Demo,
`ghl_loc_demo_001`, full dataset) and `acme` (Acme Partners, `ghl_loc_acme_002`,
scaled-down variant), each with one user per role.

---

## 18. Data model & database tables

### Core TypeScript entities (`src/types/index.ts`)

`Salesperson`, `CommissionPlan`, `Rule` (`SetupFeeRule` | `SignupBonusRule` |
`MonthlyResidualRule` | `SalaryRule`), `CommissionTiming`, `Client`, `Payment`,
`CommissionEntry`, `Payout`, `ProjectionAssumptions`, `AppSettings`, `AppData`,
`Goal`, `Milestone`, `DocumentSection`, `DocumentTemplate`, `ClientDocument`,
`BusinessProfile`, `AiGeneration`.

`AppData` is the snapshot shape: salespeople, plans, clients, payments,
commissions, payouts, settings and a schema version. Goals, documents, business
profiles and AI history are **server-owned** and fetched separately.

### Tables

Base schema (`api/_lib/schema.ts`, mirrored in `migrations/0001_init.sql`):
`agency_accounts`, `tenants`, `ghl_connections`, `users`, `salespeople`,
`commission_plans`, `commission_rules`, `clients`, `payments`,
`commission_ledger`, `payout_batches`, `payout_batch_entries`,
`affiliate_applications`, `settings`, `projection_assumptions`, `audit_logs`,
`integration_events`, `schema_migrations`.

Forward-only additions (`api/_lib/migrations.ts`, applied idempotently on cold
start): `sessions`, `payout_events`, `goals`, `milestones`,
`tenant_feature_access`, `business_profiles`, `document_templates`, `documents`,
`ai_generated_content`, `login_attempts` — plus columns for auth
(`password_hash`, `last_login_at`, `manager_user_id`), timing (`timing`,
`released_override`, `canceled_date`), payouts (`created_by_user_id`,
`approved_by_user_id`, `paid_by_user_id`, `rejected_at`, `canceled_at`),
documents (`sections`, `style`, `description`) and Kleegr (`kleegr_user_id`,
`kleegr_role`, `kleegr_permissions`, `kleegr_sub_account_id`,
`kleegr_contact_id`, `kleegr_opportunity_id`, `kleegr_source`,
`kleegr_connection_status`, `kleegr_connected_at`, `kleegr_last_sync_at`,
`pipeline_id`, `stage_id`, `opportunity_status`).

The schema is idempotent (`CREATE TABLE IF NOT EXISTS`) and is applied
automatically by the API on first request.

---

## 19. API reference

All data routes require an authenticated session; the **tenant is derived from
the session, never from the client**. Mutating routes additionally require the
CSRF check.

### Auth

| Endpoint | Description |
| --- | --- |
| `POST /api/auth/login` | `{ email, password, tenant? }` → sets the session cookie, returns the user. Rate-limited. |
| `POST /api/auth/logout` | Destroys the session (cookie **and** Bearer). |
| `GET /api/auth/me` | Current user (including `salespersonId`), or 401. |

### Core data

| Endpoint | Description |
| --- | --- |
| `GET /api/state` | The user's `AppData`, scoped by tenant **and** role. |
| `PUT/POST /api/state` | Transactional per-tenant snapshot replace (owner/admin only; writes `audit_logs`; preserves server-owned and Kleegr-linked columns). |
| `GET/POST /api/clients` | List (role-scoped) / create one client — a real single-row insert. |
| `GET/POST/PATCH/DELETE /api/salespeople` | Roster CRUD, deactivate, and approval decisions. |
| `GET/POST/PUT/DELETE /api/plans` | Plan CRUD plus `duplicate` and rule `reorder` actions. |
| `GET/POST/PATCH/DELETE /api/payments` | Payment CRUD; edits and deletes trigger a recompute, and locked commissions block a delete. |
| `GET/POST /api/ledger` | Ledger read plus `release` (force-release a held line) and `recompute` actions. |
| `GET /api/payouts` | Payouts visible to the user plus their audit history. |
| `POST /api/payouts` | `submit` / `approve` / `reject` / `mark_paid` / `cancel` — per-resource writes with role checks, logged to `payout_events`. |
| `GET/PUT /api/settings` | Company details and projection assumptions. |
| `GET/POST/PATCH/DELETE /api/goals` | Goals and (`?resource=milestone`) milestones; `actual` is computed on read. |
| `GET/PUT/PATCH /api/features` | Read and update the tenant's feature flags. |
| `GET /api/agency` | Cross-sub-account rollup for the agency owner. |
| `GET/PUT/PATCH /api/business-profile` | The tenant's business profile. |
| `GET/POST /api/documents` | Templates, sections, client documents and previews via an `op` discriminator: `create_template`, `update_template`, `duplicate_template`, `delete_template`, `section_add`, `section_update`, `section_delete`, `section_reorder`, `create`, `update_document`, `set_status`, `preview`. |
| `GET/POST /api/ai` | `GET` → availability (`configured`, `model`); `GET ?resource=history` → role-scoped history; `POST {op:'generate', …}` → `{ title, sections }`. |

### Kleegr

| Endpoint | Description |
| --- | --- |
| `GET /api/kleegr/launch` | Launch/SSO entry point (rewritten from `/kleegr/launch`). |
| `POST /api/kleegr/sync` | Run a sync of contacts/opportunities. |
| `POST /api/kleegr/webhook` | HMAC-verified inbound events. |
| `GET /api/kleegr/status` | Connection, counts, configuration presence. |
| `POST /api/kleegr/test-connection` | Server-side token verification. |
| `POST /api/kleegr/validate-manifest` | Kleegr dry-run manifest import. |
| `POST /api/kleegr/report-status` | Report status back to Kleegr. |

### Ops / diagnostics

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | DB connectivity, Postgres version, which env var supplied the connection string, per-tenant counts. |
| `GET /api/tenants` | Tenant list (diagnostic). |
| `POST /api/seed` (`?reset=1`) | Seed / reseed the demo tenants and role users. |

---

## 20. Function reference (by module)

### `src/lib/`

| Module | Key functions |
| --- | --- |
| `commission-engine.ts` | `setupFeeAmount`, `residualAmount`, `ruleAppliesToMonth`, `setupFeeLabel`, `residualLabel`, `ruleHeadline`, `suggestNextStartMonth`, `salaryScheduleByMonth`, `projectPlanForClient`, `calculateCommissionForPayment`, `generateSalaryEntries`, `projectBook` |
| `commission-timing.ts` | `DEFAULT_TIMING`, `normalizeTiming`, `TRIGGERS`, `TRIGGER_LABEL`, `timingHeadline`, `resolveCommissionTiming`, `isHeld`, `effectiveDate` |
| `ledger.ts` | `stampTiming`, `displayStatus`, `recomputePaymentCommissions`, `recomputeSalaryEntries`, `computeProjectedLedger`, `fullLedger`, `clientLabel` |
| `analytics.ts` | `inRange`, `revenueInRange`, `commissionTotals`, `rollupBySalesperson`, `monthlySeries` |
| `plan-analytics.ts` | `planRuleTypes`, `summarizePlanRules`, `planProjectedTotals`, `commissionByRuleType`, `assignmentsForPlan`, `planUsage`, `planTimingFlags`, `formatTotals`, plus `RULE_TYPE_ORDER/LABEL/TONE/COLOR` |
| `goals.ts` | `monthRange`, `quarterRange`, `inDateRange`, `resolveGoalPeriod`, `metricActual`, `goalProgress`, `paceProjection`, `daysBetween`, `projectedCommissionPerDeal`, `milestoneViews`, `nextMilestone` |
| `documents.ts` | `sectionTypesForKind`, `isSectionTypeValid`, `coerceStyle`, `isValidStatus`, `isTerminalStatus`, `canTransitionStatus`, `buildMergeContext`, `applyMergeFields`, `applySectionsMerge`, `sectionId`, `emptySection`, `reorderByIds`, `defaultSections`, plus `PROPOSAL_SECTION_TYPES`, `CONTRACT_SECTION_TYPES`, `SECTION_LABELS`, `DOCUMENT_STYLES`, `MERGE_FIELDS`, `NEXT_STATUS` |
| `roles.ts` | `ROLE_LABEL`, `ADMIN_ROLES`, `SELF_ROLES`, `homePath`, `canAccess` |
| `features.ts` | `FEATURES`, `FEATURE_KEYS`, `defaultFeatures`, `coerceFeatures`, `featureAllowsPath` |
| `format.ts` | `uid`, `formatCurrency`, `formatNumber`, `formatPercent`, `formatDate`, `todayISO`, `isoToDate`, `addMonthsISO`, `addDaysISO`, `weeksBetween`, `daysBetween`, `monthsBetween`, `monthsSince`, `clampNum`, `round2`, `classNames`, `YEAR_LABELS` |
| `export.ts` | `downloadCSV`, `downloadJSON`, `printHTMLToPDF` |
| `portal-state.ts` | `portalView` |
| `api-auth.ts` | `shouldAttachBearer`, `installApiAuthInterceptor` |
| `session-token.ts` | `readSessionToken`, `storeSessionToken`, `clearSessionToken` |
| `sidebar-pref.ts` | `readSidebarPref`, `writeSidebarPref`, `browserPrefStore` |
| `useEmbedded.ts` | `detectEmbedded`, `useEmbedded` |
| `demo-prefs.ts` | `readDemoPrefs`, `storeDemoPrefs`, `clearDemoPrefs` |
| `demo-data.ts` | `buildDemoData` |
| `resource-client.ts` | Typed clients for every per-resource endpoint: salespeople, settings, goals/milestones, features, agency overview, business profile, documents, templates and sections |
| `payouts-client.ts` | `fetchPayouts`, `submitPayout`, `payoutTransition` |
| `kleegr-client.ts` | `getKleegrStatus`, `testKleegrConnection`, `reportKleegrStatus`, `validateKleegrManifest` |
| `storage/` | `DataStore` interface; `HybridStore` (`classifyStateResponse`, `getBackendInfo`, `StateLoadError`, `isAuthError`); `LocalStorageStore` |

### `api/_lib/`

| Module | Responsibility |
| --- | --- |
| `db.ts` | Neon serverless pool (WebSocket), env-var resolution, `query`, `withTransaction` |
| `schema.ts` | Canonical SQL schema and child-first table order |
| `migrations.ts` | Forward-only idempotent ALTERs and new tables |
| `auth.ts` | scrypt hashing, DB-backed sessions, cookie + Bearer token resolution |
| `auth-seed.ts` | One user per role per tenant; links portals and manager teams |
| `repository.ts` | `ensureSchema`, role-scoped reads, snapshot writes, seeding |
| `handlers.ts` | Shared request handling and the server-side feature-key list |
| `commission-handlers.ts` | Commission/ledger endpoint logic |
| `recompute.ts` | Pure recompute core plus client/plan/tenant transactional wrappers and lock guards |
| `payouts.ts` | `listPayouts`, `submitPayout`, `transitionPayout`, `roleMayTransition`, `mayActOnBatch`, `violatesSeparationOfDuties` |
| `documents-core.ts` | Section operations, merge resolution, AI prompt building (`buildGenerationMessages`, `parseAiSections`, `aiConfigured`, `aiModel`) |
| `agency-core.ts` / `agency-scope.ts` | Cross-tenant rollups and who may see them |
| `feature-access.ts` | `readTenantFlags`, `tenantFeatureEnabled` |
| `rate-limit.ts` | `overLimit`, `loginBlocked`, failure recording |
| `http.ts` | CSRF check, JSON helpers, method guards |
| `kleegr.ts`, `kleegr-roles.ts`, `kleegr-sync.ts`, `kleegr-manifest.ts` | Kleegr gateway calls, role mapping, sync, manifest parity |
| `launch-handoff.ts` | The HTML handoff document that carries the session into a WebView |

---

## 21. UI system, layout and embedded shell

- **Layout** (`components/layout/Layout.tsx`): sidebar navigation built from the
  role + feature flags, a company-name header, **light/dark theme toggle**, sign
  out, and a mobile drawer.
- **Embedded mode**: inside the Kleegr iframe the app renders a compact
  **nav rail**. Collapsed it shows icons with **instant flyout labels** on
  hover/focus; expanded it shows icons plus full text. The expand/collapse
  preference persists (`scm.sidebarExpanded`), and when the viewport is too
  narrow the expanded rail floats over the content instead of squeezing it.
  `useEmbedded()` detects the framed context.
- **UI primitives** (`components/ui/`): `Card`, `Button`, `Badge`, `StatCard`,
  `SectionTitle`, `EmptyState`, `Modal`, `Table`/`THead`/`TR`/`TH`/`TD`, and form
  controls (`Field`, `Input`, `Select`, `Checkbox`, `Textarea`).
- **Charts** (`components/charts/Charts.tsx`, Recharts): monthly earned vs
  projected, salesperson performance, revenue by sub-account, cumulative
  earnings.
- **Shared widgets**: `DateRangeFilter`, `SetupChecklist`, `NeedsAttention`,
  `PortalSkeleton`, `DemoBar`.
- **Document components**: `BusinessWizard`, `SectionBuilder`,
  `DocumentPreview`.
- **Plan components**: `RuleList`, `RuleEditorModal`, `PlanPreviewModal`,
  `PlanAssignments`, `ProjectionView`, `ProjectionTable`, `TimingExplainer`.
- **State**: `AuthContext` (current user, login/logout), `AppContext`
  (`useReducer` global state with `reload()`; tenant and role come from the
  session), `FeaturesContext` (tenant flags, fail-open).

---

## 22. Operations, testing and deployment

### Persistence seam

`src/lib/storage/index.ts` defines a `DataStore` (`load` / `save` / `clear` /
`name`). `apiStore.ts` implements it as a **HybridStore**: it reads the
session-scoped dataset from `/api/state`, uses Postgres when the API and DB are
reachable (debounced PUTs, owner/admin only), and falls back to `localStorage`
otherwise. `classifyStateResponse()` distinguishes **auth**, **client** and
**outage** failures so an expired session shows a login prompt instead of
silently serving a stale cache.

Newer workflows (payouts, clients, plans, payments, goals, documents, features)
are **real per-resource writes** that do not replace the tenant snapshot.

### Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Vite dev server (localStorage, no serverless functions) |
| `npm run build` | Type-check app + API, then production build |
| `npm run preview` | Preview the production build |
| `npm test` | The full unit suite (see below) |
| `npm run db:migrate` | Apply the schema |
| `npm run db:seed` (`-- --reset`) | Seed / wipe-and-reseed the demo tenants |
| `vercel dev` | Full stack locally: SPA + `/api/*` against Neon |

### Test suite

24 test modules run by `npm test`, covering: the commission engine, commission
timing, auth, request handlers, commission handlers, recompute, goals, documents
core, agency core and scope, HTTP helpers, payout authorization, roles, sidebar
preference, portal state, the Kleegr gateway/roles/user-scope/salesperson-link/
sync-gate, launch handoff, API auth interceptor, and the API store.

### Deployment

Vercel, auto-deploying on push to `main`. `vercel.json` sets the build command,
the `dist` output directory, and a SPA rewrite that **excludes `/api`** so the
serverless functions are not shadowed. Required env var: `DATABASE_URL` (Neon
pooled connection string) — the API reads the first present of `DATABASE_URL`,
`POSTGRES_URL`, `DATABASE_URL_UNPOOLED`, `POSTGRES_PRISMA_URL`,
`POSTGRES_URL_NON_POOLING`, `NEON_DATABASE_URL`. Visit `/api/health` to confirm.

### Runbooks

`docs/RUNBOOK.md` (day-2 ops, health checks, the deploy-time
`scripts/migrate-financial.ts`), `docs/INCIDENT_RECOVERY.md` (disable sync,
reverse a payout, bad imports, Neon PITR), `docs/ENV.md` (environment
variables), `docs/KLEEGR_SETUP.md` (integration setup), `docs/PILOT_CHECKLIST.md`
(real-customer pilot and production readiness).

### Known limitations / next steps

- People, plans, clients and payments still have a `PUT /api/state` snapshot
  path alongside their per-resource endpoints; editing underlying payments or
  plans after a payout exists can stale that batch's exact line linkage (the
  batch, its history and its totals are preserved).
- The Kleegr sync is intentionally small — pagination, conversations and
  write-back are pending as Kleegr exposes those resources.
- Password reset / user-management UI and session revocation UI are not built.
- The bundle is not yet code-split (one large chunk).

---

*Figures produced anywhere in the app are deterministic projections from plan
rules, not financial guarantees.*
