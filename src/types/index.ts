// ============================================================================
// Core data model for the Commission Management prototype.
//
// Everything the app stores is described here. The shapes are intentionally
// flat and serializable (JSON) so the storage layer can later be swapped for
// GoHighLevel Custom Objects / Contacts / Payments or an external database
// without touching the UI or the commission engine.
// ============================================================================

export type Role = "salesperson" | "affiliate" | "partner";
export type PersonStatus = "active" | "inactive";
export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface Salesperson {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: Role;
  referralCode: string;
  status: PersonStatus;
  commissionPlanId: string | null;
  /** Optional weekly salary. null/0 means no salary. */
  weeklySalary: number | null;
  salaryStartDate: string | null; // ISO yyyy-mm-dd
  salaryEndDate: string | null; // ISO yyyy-mm-dd (optional)
  notes: string;

  /** Where this person came from. Affiliates from the public portal start pending. */
  source: "admin" | "affiliate_portal";
  approvalStatus: ApprovalStatus;
  companyName?: string;
  website?: string;
  referralSource?: string;
  createdAt: string;
}

// ----------------------------------------------------------------------------
// Commission plans are built from flexible rules.
// ----------------------------------------------------------------------------

export type RuleType =
  | "setup_fee"
  | "signup_bonus"
  | "monthly_residual"
  | "salary";

export type SetupFeeMode = "none" | "percentage" | "fixed";
export type ValueType = "percentage" | "fixed";

export interface SetupFeeRule {
  id: string;
  type: "setup_fee";
  mode: SetupFeeMode;
  /** percentage (0-100) when mode==='percentage', dollars when mode==='fixed' */
  value: number;
}

export interface SignupBonusRule {
  id: string;
  type: "signup_bonus";
  amount: number; // flat dollars per new signup
}

export interface MonthlyResidualRule {
  id: string;
  type: "monthly_residual";
  startMonth: number; // 1-based, inclusive
  endMonth: number | null; // inclusive; null when continueForever
  continueForever: boolean;
  valueType: ValueType;
  value: number; // percentage (0-100) or flat dollars
}

export interface SalaryRule {
  id: string;
  type: "salary";
  weeklyAmount: number;
  startDate: string | null; // ISO (optional in plan context)
  endDate: string | null; // ISO (optional)
  maxWeeks: number | null; // optional
}

export type Rule =
  | SetupFeeRule
  | SignupBonusRule
  | MonthlyResidualRule
  | SalaryRule;

export interface CommissionPlan {
  id: string;
  name: string;
  description: string;
  rules: Rule[]; // ordered; order is meaningful for display + drag/drop
  /** Sample inputs stored with the plan so the preview is reproducible. */
  sampleSetupFee: number;
  sampleMonthly: number;
  createdAt: string;
}

// ----------------------------------------------------------------------------
// Clients
// ----------------------------------------------------------------------------

export type ClientStatus = "active" | "canceled" | "refunded" | "paused";

export interface Client {
  id: string;
  companyName: string;
  contactName: string;
  email: string;
  phone: string;
  salespersonId: string | null;
  signupDate: string; // ISO
  setupFee: number;
  monthlySubscription: number;
  status: ClientStatus;
  notes: string;
  createdAt: string;
}

// ----------------------------------------------------------------------------
// Payments (manually entered for now)
// ----------------------------------------------------------------------------

export type PaymentType =
  | "setup_fee"
  | "monthly_subscription"
  | "refund"
  | "adjustment";

export interface Payment {
  id: string;
  clientId: string;
  date: string; // ISO
  type: PaymentType;
  amount: number;
  /** Subscription month number (1-based) for monthly_subscription payments. */
  paymentNumber: number | null;
  notes: string;
  createdAt: string;
}

// ----------------------------------------------------------------------------
// Commission ledger
// ----------------------------------------------------------------------------

export type CommissionStatus =
  | "projected" // due in the future, not yet earned
  | "pending" // earned, awaiting submission
  | "submitted" // submitted for approval (step 1)
  | "approved" // approved (step 2) — ready to pay
  | "paid"
  | "rejected"
  | "canceled"
  | "clawed_back";

export interface CommissionEntry {
  id: string;
  salespersonId: string;
  clientId: string | null;
  paymentId: string | null; // null for salary / projected entries
  paymentDate: string; // the date that drives this commission
  paymentType: PaymentType | "salary";
  paymentAmount: number; // base amount the commission is computed from
  ruleId: string | null;
  ruleType: RuleType;
  ruleLabel: string; // human readable, e.g. "Residual · Month 1–3 · 70%"
  commissionValueType: ValueType;
  commissionValue: number; // 70 (means 70%) or 150 (means $150)
  commissionAmount: number; // resolved dollars
  status: CommissionStatus;
  dueDate: string; // ISO
  paidDate: string | null;
  notes: string;
  /** true for future projected rows that are computed, not derived from a real payment */
  isProjection: boolean;
  createdAt: string;
}

// ----------------------------------------------------------------------------
// Payouts (two-step approval)
// ----------------------------------------------------------------------------

export type PayoutStatus = "submitted" | "approved" | "paid" | "rejected" | "canceled";

export interface Payout {
  id: string;
  salespersonId: string;
  commissionEntryIds: string[];
  totalAmount: number;
  status: PayoutStatus;
  notes: string;
  createdAt: string;
  submittedAt: string | null;
  approvedAt: string | null;
  paidAt: string | null;
}

// ----------------------------------------------------------------------------
// Settings + projection assumptions
// ----------------------------------------------------------------------------

export interface ProjectionAssumptions {
  avgSetupFee: number;
  avgMonthly: number;
  closingsPerMonth: number;
  monthlyChurnPct: number; // 0-100
  months: number; // horizon, up to 60
}

export interface AppSettings {
  theme: "light" | "dark";
  companyName: string;
  assumptions: ProjectionAssumptions;
}

export interface AppData {
  salespeople: Salesperson[];
  plans: CommissionPlan[];
  clients: Client[];
  payments: Payment[];
  commissions: CommissionEntry[]; // real (past/present) entries only; projected are computed
  payouts: Payout[];
  settings: AppSettings;
  /** schema version so future migrations / GHL sync can detect old data */
  version: number;
}

export const SCHEMA_VERSION = 1;

// ----------------------------------------------------------------------------
// Goals & milestones (server-owned; fetched via /api/goals, NOT part of AppData)
//
// A goal targets a measurable metric for a salesperson, a manager's team, or the
// whole tenant, over a period. Progress is computed from real data, never
// stored. Milestones are sub-thresholds of a goal used to motivate.
// ----------------------------------------------------------------------------

export type GoalMetric =
  | "revenue" // $ collected (setup + subscription − refunds) in the period
  | "clients_closed" // new clients signed in the period
  | "referrals" // new referral-sourced clients in the period
  | "mrr" // current monthly recurring revenue (active clients)
  | "commission_earned" // commission earned (non-projected) in the period
  | "activity"; // proxy: clients signed + payments recorded in the period

export type GoalScopeType = "salesperson" | "team" | "tenant";
export type GoalPeriod = "monthly" | "quarterly" | "custom";
export type GoalStatus = "active" | "archived";

export interface Goal {
  id: string;
  scopeType: GoalScopeType;
  salespersonId: string | null; // when scopeType === 'salesperson'
  managerUserId: string | null; // when scopeType === 'team'
  metric: GoalMetric;
  title: string;
  targetValue: number;
  period: GoalPeriod;
  periodStart: string | null; // ISO yyyy-mm-dd
  periodEnd: string | null; // ISO yyyy-mm-dd
  status: GoalStatus;
  createdAt: string;
  /** Computed server-side and attached to the GET response (not persisted). */
  actual?: number;
}

export interface Milestone {
  id: string;
  goalId: string;
  title: string;
  thresholdValue: number; // in the goal's metric units
  reward: string;
  createdAt: string;
}
