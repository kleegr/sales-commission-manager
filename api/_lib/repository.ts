// ============================================================================
// REPOSITORY  (tenant-scoped data access layer)
//
// Translates between the application's `AppData` document and the normalized
// relational tables, always scoped by tenant_id. The existing front-end speaks
// `AppData` through its DataStore interface, so these two functions are all the
// app needs to live on Postgres:
//
//   readState(tenantId)        -> AppData     (GET  /api/state)
//   writeState(tenantId, data) -> void        (PUT  /api/state)
//
// writeState is a transactional REPLACE-ALL for the tenant: it deletes the
// tenant's child rows and re-inserts from the snapshot, so there are never
// stale rows and concurrent saves are last-write-wins (documented).
//
// NOTE ON TENANT ISOLATION: every statement below filters / writes by
// tenant_id. There is no query in this file that can read or mutate rows for a
// tenant other than the one passed in — that is the multi-tenant guarantee for
// this phase (see SECURITY in README for what real auth still needs to add).
// ============================================================================

import { query, withTransaction, type PoolClient } from "./db.js";
import { SCHEMA_SQL, TABLES_CHILD_FIRST } from "./schema.js";
import { buildDemoData } from "../../src/lib/demo-data.js";
import {
  SCHEMA_VERSION,
  type AppData,
  type Client,
  type CommissionEntry,
  type CommissionPlan,
  type Payment,
  type Payout,
  type Rule,
  type Salesperson,
} from "../../src/types/index.js";

const nowISO = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Schema + migrations
// ---------------------------------------------------------------------------

let schemaReady = false;

/** Idempotently create every table/index. Safe to call on every cold start. */
export async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await query(SCHEMA_SQL);
  await query(
    `INSERT INTO schema_migrations (id) VALUES ($1)
     ON CONFLICT (id) DO NOTHING`,
    ["0001_init"],
  );
  schemaReady = true;
}

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  ghl_location_id: string | null;
  agency_id: string | null;
  status: string;
}

export async function listTenants(): Promise<TenantRow[]> {
  const { rows } = await query<TenantRow>(
    `SELECT id, name, slug, ghl_location_id, agency_id, status
       FROM tenants ORDER BY created_at ASC, name ASC`,
  );
  return rows;
}

export async function getTenantBySlug(slug: string): Promise<TenantRow | null> {
  const { rows } = await query<TenantRow>(
    `SELECT id, name, slug, ghl_location_id, agency_id, status
       FROM tenants WHERE slug = $1`,
    [slug],
  );
  return rows[0] ?? null;
}

/** Per-tenant row counts — used by /api/health to prove data is really there. */
export async function tenantCounts(tenantId: string) {
  const tables = [
    "salespeople",
    "commission_plans",
    "commission_rules",
    "clients",
    "payments",
    "commission_ledger",
    "payout_batches",
  ];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const { rows } = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${t} WHERE tenant_id = $1`,
      [tenantId],
    );
    out[t] = Number(rows[0]?.n ?? 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// READ: rows -> AppData
// ---------------------------------------------------------------------------

export async function readState(tenantId: string): Promise<AppData> {
  const [
    spRes,
    planRes,
    ruleRes,
    clientRes,
    payRes,
    ledgerRes,
    poRes,
    poEntryRes,
    settingsRes,
  ] = await Promise.all([
    query(`SELECT * FROM salespeople WHERE tenant_id = $1 ORDER BY created_at ASC`, [tenantId]),
    query(`SELECT * FROM commission_plans WHERE tenant_id = $1 ORDER BY sort_order ASC, created_at ASC`, [tenantId]),
    query(`SELECT * FROM commission_rules WHERE tenant_id = $1 ORDER BY commission_plan_id, sort_order ASC`, [tenantId]),
    query(`SELECT * FROM clients WHERE tenant_id = $1 ORDER BY created_at ASC`, [tenantId]),
    query(`SELECT * FROM payments WHERE tenant_id = $1 ORDER BY payment_date ASC`, [tenantId]),
    query(`SELECT * FROM commission_ledger WHERE tenant_id = $1`, [tenantId]),
    query(`SELECT * FROM payout_batches WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]),
    query(`SELECT * FROM payout_batch_entries WHERE tenant_id = $1`, [tenantId]),
    query(`SELECT * FROM settings WHERE tenant_id = $1`, [tenantId]),
  ]);

  const salespeople: Salesperson[] = spRes.rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    email: r.email ?? "",
    phone: r.phone ?? "",
    role: r.role,
    referralCode: r.referral_code ?? "",
    status: r.status,
    commissionPlanId: r.commission_plan_id ?? null,
    weeklySalary: r.weekly_salary === null ? null : Number(r.weekly_salary),
    salaryStartDate: r.salary_start_date ?? null,
    salaryEndDate: r.salary_end_date ?? null,
    notes: r.notes ?? "",
    source: r.source,
    approvalStatus: r.approval_status,
    companyName: r.company_name ?? undefined,
    website: r.website ?? undefined,
    referralSource: r.referral_source ?? undefined,
    createdAt: r.created_at || nowISO(),
  }));

  // group rules under plans, rebuilding the exact Rule union from metadata
  const rulesByPlan = new Map<string, Rule[]>();
  for (const r of ruleRes.rows as any[]) {
    const list = rulesByPlan.get(r.commission_plan_id) ?? [];
    list.push(r.metadata as Rule);
    rulesByPlan.set(r.commission_plan_id, list);
  }
  const plans: CommissionPlan[] = planRes.rows.map((p: any) => ({
    id: p.id,
    name: p.name,
    description: p.description ?? "",
    rules: rulesByPlan.get(p.id) ?? [],
    sampleSetupFee: Number(p.sample_setup_fee),
    sampleMonthly: Number(p.sample_monthly),
    createdAt: p.created_at || nowISO(),
  }));

  const clients: Client[] = clientRes.rows.map((c: any) => ({
    id: c.id,
    companyName: c.company_name ?? "",
    contactName: c.contact_name ?? "",
    email: c.email ?? "",
    phone: c.phone ?? "",
    salespersonId: c.salesperson_id ?? null,
    signupDate: c.signup_date ?? "",
    setupFee: Number(c.setup_fee_amount),
    monthlySubscription: Number(c.monthly_subscription_amount),
    status: c.status,
    notes: c.notes ?? "",
    createdAt: c.created_at || nowISO(),
  }));

  const payments: Payment[] = payRes.rows.map((p: any) => ({
    id: p.id,
    clientId: p.client_id,
    date: p.payment_date ?? "",
    type: p.payment_type,
    amount: Number(p.amount),
    paymentNumber: p.payment_number === null ? null : Number(p.payment_number),
    notes: p.notes ?? "",
    createdAt: p.created_at || nowISO(),
  }));

  const commissions: CommissionEntry[] = ledgerRes.rows.map((e: any) => ({
    id: e.id,
    salespersonId: e.salesperson_id,
    clientId: e.client_id ?? null,
    paymentId: e.payment_id ?? null,
    paymentDate: e.payment_date ?? "",
    paymentType: e.payment_type,
    paymentAmount: Number(e.payment_amount),
    ruleId: e.commission_rule_id ?? null,
    ruleType: e.rule_type,
    ruleLabel: e.commission_rule_used ?? "",
    commissionValueType: e.commission_type,
    commissionValue: Number(e.commission_value),
    commissionAmount: Number(e.commission_amount),
    status: e.status,
    dueDate: e.due_date ?? "",
    paidDate: e.paid_date ?? null,
    notes: e.notes ?? "",
    isProjection: !!e.is_projection,
    createdAt: e.created_at || nowISO(),
  }));

  const entryIdsByPayout = new Map<string, string[]>();
  for (const row of poEntryRes.rows as any[]) {
    const list = entryIdsByPayout.get(row.payout_batch_id) ?? [];
    list.push(row.commission_entry_id);
    entryIdsByPayout.set(row.payout_batch_id, list);
  }
  const payouts: Payout[] = poRes.rows.map((p: any) => ({
    id: p.id,
    salespersonId: p.salesperson_id,
    commissionEntryIds: entryIdsByPayout.get(p.id) ?? [],
    totalAmount: Number(p.total_amount),
    status: p.status,
    notes: p.notes ?? "",
    createdAt: p.created_at || nowISO(),
    submittedAt: p.submitted_at ?? null,
    approvedAt: p.approved_at ?? null,
    paidAt: p.paid_at ?? null,
  }));

  const s: any = settingsRes.rows[0];
  const settings: AppData["settings"] = s
    ? {
        theme: s.theme === "dark" ? "dark" : "light",
        companyName: s.company_name ?? "",
        assumptions: {
          avgSetupFee: Number(s.default_setup_fee),
          avgMonthly: Number(s.default_monthly_subscription),
          closingsPerMonth: Number(s.default_closings_per_month),
          monthlyChurnPct: Number(s.default_churn_rate),
          months: Number(s.projection_months),
        },
      }
    : {
        theme: "light",
        companyName: "",
        assumptions: { avgSetupFee: 2500, avgMonthly: 250, closingsPerMonth: 5, monthlyChurnPct: 3, months: 60 },
      };

  return { salespeople, plans, clients, payments, commissions, payouts, settings, version: SCHEMA_VERSION };
}

// ---------------------------------------------------------------------------
// WRITE: AppData -> rows (transactional replace-all, tenant-scoped)
// ---------------------------------------------------------------------------

function ruleColumns(rule: Rule): {
  calc: string;
  value: number;
  startMonth: number | null;
  endMonth: number | null;
  forever: boolean;
  weekly: number | null;
  salStart: string | null;
  salEnd: string | null;
  maxWeeks: number | null;
} {
  switch (rule.type) {
    case "setup_fee":
      return { calc: rule.mode, value: rule.value, startMonth: null, endMonth: null, forever: false, weekly: null, salStart: null, salEnd: null, maxWeeks: null };
    case "signup_bonus":
      return { calc: "fixed", value: rule.amount, startMonth: null, endMonth: null, forever: false, weekly: null, salStart: null, salEnd: null, maxWeeks: null };
    case "monthly_residual":
      return { calc: rule.valueType, value: rule.value, startMonth: rule.startMonth, endMonth: rule.endMonth, forever: rule.continueForever, weekly: null, salStart: null, salEnd: null, maxWeeks: null };
    case "salary":
      return { calc: "fixed", value: 0, startMonth: null, endMonth: null, forever: false, weekly: rule.weeklyAmount, salStart: rule.startDate, salEnd: rule.endDate, maxWeeks: rule.maxWeeks };
  }
}

export async function writeState(tenantId: string, data: AppData): Promise<void> {
  const ts = nowISO();
  const clientToSp = new Map<string, string | null>();
  for (const c of data.clients) clientToSp.set(c.id, c.salespersonId);
  const spToPlan = new Map<string, string | null>();
  for (const s of data.salespeople) spToPlan.set(s.id, s.commissionPlanId);
  const entryToPayout = new Map<string, string>();
  for (const po of data.payouts) for (const eid of po.commissionEntryIds) entryToPayout.set(eid, po.id);

  await withTransaction(async (c: PoolClient) => {
    // 1. clear this tenant's data (child-first); tenants row is preserved
    for (const table of TABLES_CHILD_FIRST) {
      await c.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    }

    // 2. settings (one row)
    const a = data.settings.assumptions;
    await c.query(
      `INSERT INTO settings
         (tenant_id, company_name, theme, default_setup_fee, default_monthly_subscription,
          default_closings_per_month, default_churn_rate, projection_months, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [tenantId, data.settings.companyName, data.settings.theme, a.avgSetupFee, a.avgMonthly, a.closingsPerMonth, a.monthlyChurnPct, a.months, ts, ts],
    );

    // 3. salespeople
    for (const s of data.salespeople) {
      await c.query(
        `INSERT INTO salespeople
           (id, tenant_id, name, email, phone, role, referral_code, status, approval_status, source,
            commission_plan_id, weekly_salary, salary_start_date, salary_end_date, company_name, website,
            referral_source, notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [s.id, tenantId, s.name, s.email, s.phone, s.role, s.referralCode, s.status, s.approvalStatus, s.source,
         s.commissionPlanId, s.weeklySalary, s.salaryStartDate, s.salaryEndDate, s.companyName ?? null, s.website ?? null,
         s.referralSource ?? null, s.notes, s.createdAt || ts, ts],
      );
    }

    // 4. plans + rules
    for (let pi = 0; pi < data.plans.length; pi++) {
      const p = data.plans[pi];
      await c.query(
        `INSERT INTO commission_plans
           (id, tenant_id, name, description, status, sort_order, sample_setup_fee, sample_monthly, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [p.id, tenantId, p.name, p.description, "active", pi, p.sampleSetupFee, p.sampleMonthly, p.createdAt || ts, ts],
      );
      for (let ri = 0; ri < p.rules.length; ri++) {
        const rule = p.rules[ri];
        const col = ruleColumns(rule);
        await c.query(
          `INSERT INTO commission_rules
             (id, tenant_id, commission_plan_id, rule_type, calculation_type, value, start_month, end_month,
              continues_forever, weekly_salary_amount, salary_start_date, salary_end_date, max_weeks,
              sort_order, is_active, metadata, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18)`,
          [rule.id, tenantId, p.id, rule.type, col.calc, col.value, col.startMonth, col.endMonth, col.forever,
           col.weekly, col.salStart, col.salEnd, col.maxWeeks, ri, true, JSON.stringify(rule), p.createdAt || ts, ts],
        );
      }
    }

    // 5. clients
    for (const cl of data.clients) {
      await c.query(
        `INSERT INTO clients
           (id, tenant_id, salesperson_id, company_name, contact_name, email, phone, signup_date,
            setup_fee_amount, monthly_subscription_amount, status, notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [cl.id, tenantId, cl.salespersonId, cl.companyName, cl.contactName, cl.email, cl.phone, cl.signupDate,
         cl.setupFee, cl.monthlySubscription, cl.status, cl.notes, cl.createdAt || ts, ts],
      );
    }

    // 6. payments (salesperson derived from the client)
    for (const pay of data.payments) {
      await c.query(
        `INSERT INTO payments
           (id, tenant_id, client_id, salesperson_id, payment_date, payment_type, amount, payment_number,
            source, external_payment_id, notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [pay.id, tenantId, pay.clientId, clientToSp.get(pay.clientId) ?? null, pay.date, pay.type, pay.amount,
         pay.paymentNumber, "manual", null, pay.notes, pay.createdAt || ts, ts],
      );
    }

    // 7. commission ledger
    for (const e of data.commissions) {
      await c.query(
        `INSERT INTO commission_ledger
           (id, tenant_id, salesperson_id, client_id, payment_id, commission_plan_id, commission_rule_id,
            rule_type, payment_date, payment_type, payment_amount, commission_rule_used, commission_type,
            commission_value, commission_amount, status, due_date, paid_date, payout_batch_id, is_projection,
            notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        [e.id, tenantId, e.salespersonId, e.clientId, e.paymentId, spToPlan.get(e.salespersonId) ?? null, e.ruleId,
         e.ruleType, e.paymentDate, e.paymentType, e.paymentAmount, e.ruleLabel, e.commissionValueType,
         e.commissionValue, e.commissionAmount, e.status, e.dueDate, e.paidDate, entryToPayout.get(e.id) ?? null,
         e.isProjection, e.notes, e.createdAt || ts, ts],
      );
    }

    // 8. payout batches + their entry membership
    for (const po of data.payouts) {
      await c.query(
        `INSERT INTO payout_batches
           (id, tenant_id, salesperson_id, status, total_amount, submitted_at, approved_at, paid_at,
            notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [po.id, tenantId, po.salespersonId, po.status, po.totalAmount, po.submittedAt, po.approvedAt, po.paidAt,
         po.notes, po.createdAt || ts, ts],
      );
      for (const eid of po.commissionEntryIds) {
        await c.query(
          `INSERT INTO payout_batch_entries (payout_batch_id, commission_entry_id, tenant_id)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [po.id, eid, tenantId],
        );
      }
    }

    // 9. audit trail — every snapshot save is recorded (financial systems need this)
    await c.query(
      `INSERT INTO audit_logs (id, tenant_id, entity_type, action, after, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb, now())`,
      [
        `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        tenantId,
        "app_state",
        "state_sync",
        JSON.stringify({
          salespeople: data.salespeople.length,
          plans: data.plans.length,
          clients: data.clients.length,
          payments: data.payments.length,
          ledger: data.commissions.length,
          payouts: data.payouts.length,
        }),
      ],
    );
  });
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const DEMO_AGENCY_ID = "agency_demo";

export const DEMO_TENANTS = [
  { id: "tenant_demo", slug: "demo", name: "Northwind Agency — Demo", company: "Northwind Agency", ghl: "ghl_loc_demo_001" },
  { id: "tenant_acme", slug: "acme", name: "Acme Partners", company: "Acme Partners", ghl: "ghl_loc_acme_002" },
] as const;

/** A lightly-varied second dataset so two tenants visibly differ. */
function variantData(company: string, factor: number): AppData {
  const d = buildDemoData();
  d.settings.companyName = company;
  // scale subscription/setup a touch and trim the book so tenant B != tenant A
  d.clients = d.clients.slice(0, Math.max(3, Math.round(d.clients.length * 0.6))).map((c) => ({
    ...c,
    monthlySubscription: Math.round(c.monthlySubscription * factor),
  }));
  const keep = new Set(d.clients.map((c) => c.id));
  d.payments = d.payments.filter((p) => keep.has(p.clientId));
  // re-derive ledger for the trimmed set happens client-side on hydrate; keep
  // only commissions whose client still exists (or salary rows with no client)
  d.commissions = d.commissions.filter((e) => !e.clientId || keep.has(e.clientId));
  d.payouts = [];
  return d;
}

type DemoTenant = (typeof DEMO_TENANTS)[number];

/** Idempotently ensure the owning agency row exists. */
async function ensureAgency(): Promise<void> {
  await query(
    `INSERT INTO agency_accounts (id, name, status, created_at, updated_at)
     VALUES ($1,$2,'active', now(), now()) ON CONFLICT (id) DO NOTHING`,
    [DEMO_AGENCY_ID, "Demo Agency (App Owner)"],
  );
}

/** True when a tenant already has business data (used to detect partial seeds). */
async function tenantHasData(tenantId: string): Promise<boolean> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM salespeople WHERE tenant_id = $1`,
    [tenantId],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** Create/refresh one demo tenant: its row, an owner user, and its dataset. */
async function seedTenant(index: number, t: DemoTenant): Promise<void> {
  await query(
    `INSERT INTO tenants (id, name, slug, ghl_location_id, agency_id, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'active', now(), now())
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug`,
    [t.id, t.name, t.slug, t.ghl, DEMO_AGENCY_ID],
  );
  await query(
    `INSERT INTO users (id, tenant_id, name, email, role, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'owner','active', now(), now())
     ON CONFLICT (tenant_id, email) DO NOTHING`,
    [`user_owner_${t.slug}`, t.id, `${t.company} Owner`, `owner@${t.slug}.example.com`],
  );
  const data = index === 0 ? withCompany(buildDemoData(), t.company) : variantData(t.company, 0.9);
  await writeState(t.id, data);
}

/**
 * Ensure every demo tenant exists AND has data. Self-healing and idempotent:
 * a tenant is (re)seeded only if it is missing or empty, so an interrupted
 * cold-start seed is repaired on a later request without touching tenants that
 * are already populated (and each call stays small enough to finish quickly).
 */
export async function seedIfEmpty(): Promise<{ seeded: boolean; tenants: string[] }> {
  await ensureAgency();
  const existing = await listTenants();
  const bySlug = new Map(existing.map((t) => [t.slug, t]));

  let seeded = false;
  for (let i = 0; i < DEMO_TENANTS.length; i++) {
    const t = DEMO_TENANTS[i];
    const row = bySlug.get(t.slug);
    const needsSeed = !row || !(await tenantHasData(row.id));
    if (needsSeed) {
      await seedTenant(i, t);
      seeded = true;
    }
  }
  return { seeded, tenants: DEMO_TENANTS.map((t) => t.slug) };
}

/** Force a full (re)seed of the agency + both demo tenants and their datasets. */
export async function seedAll(): Promise<void> {
  await ensureAgency();
  for (let i = 0; i < DEMO_TENANTS.length; i++) {
    await seedTenant(i, DEMO_TENANTS[i]);
  }
}

function withCompany(d: AppData, company: string): AppData {
  d.settings.companyName = company;
  return d;
}
