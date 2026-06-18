// ============================================================================
// APP STATE
//
// A single React context holds the entire dataset and exposes typed actions.
// All persistence goes through the DataStore abstraction (localStorage today,
// GoHighLevel / external DB later). Whenever payments, clients, salespeople or
// plans change, payment-derived and salary commission rows are recomputed by
// the deterministic engine so the ledger is always in sync.
// ============================================================================

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import type {
  AppData,
  Client,
  CommissionEntry,
  CommissionPlan,
  Payment,
  Payout,
  ProjectionAssumptions,
  Salesperson,
} from "../types";
import { SCHEMA_VERSION } from "../types";
import {
  store,
  getBackendInfo,
  type Backend,
} from "../lib/storage/apiStore";
import { useAuth } from "./AuthContext";
import { buildDemoData } from "../lib/demo-data";
import {
  recomputePaymentCommissions,
  recomputeSalaryEntries,
} from "../lib/ledger";
import { todayISO, uid } from "../lib/format";

// ----------------------------------------------------------------------------
// Actions
// ----------------------------------------------------------------------------

type Action =
  | { type: "HYDRATE"; data: AppData }
  | { type: "RESET_DEMO" }
  | { type: "IMPORT"; data: AppData }
  | { type: "SET_THEME"; theme: "light" | "dark" }
  | { type: "SET_COMPANY"; name: string }
  | { type: "SET_ASSUMPTIONS"; assumptions: ProjectionAssumptions }
  // salespeople
  | { type: "SP_ADD"; sp: Salesperson }
  | { type: "SP_UPDATE"; sp: Salesperson }
  | { type: "SP_DELETE"; id: string }
  | { type: "SP_APPROVAL"; id: string; approval: "approved" | "rejected" }
  // plans
  | { type: "PLAN_ADD"; plan: CommissionPlan }
  | { type: "PLAN_UPDATE"; plan: CommissionPlan }
  | { type: "PLAN_DELETE"; id: string }
  // clients
  | { type: "CLIENT_ADD"; client: Client }
  | { type: "CLIENT_UPDATE"; client: Client }
  | { type: "CLIENT_DELETE"; id: string }
  // payments
  | { type: "PAYMENT_ADD"; payment: Payment }
  | { type: "PAYMENT_UPDATE"; payment: Payment }
  | { type: "PAYMENT_DELETE"; id: string }
  // ledger
  | { type: "COMMISSION_SET_STATUS"; ids: string[]; status: CommissionEntry["status"] }
  | { type: "RELEASE_COMMISSION"; ids: string[] }
  // payouts
  | { type: "PAYOUT_SUBMIT"; salespersonId: string; commissionEntryIds: string[]; notes: string }
  | { type: "PAYOUT_APPROVE"; id: string }
  | { type: "PAYOUT_MARK_PAID"; id: string }
  | { type: "PAYOUT_REJECT"; id: string };

// Recompute the derived ledger (payment + salary rows) after any change that
// could affect it, while preserving manually advanced workflow statuses.
function withRecompute(data: AppData): AppData {
  const paymentRows = recomputePaymentCommissions(data);
  const salaryRows = recomputeSalaryEntries({ ...data, commissions: paymentRows });
  return { ...data, commissions: [...paymentRows, ...salaryRows] };
}

// Keep a client's cancellation date consistent with its status so the clawback
// window can be measured. When a client is moved to canceled/refunded and no
// date was supplied, stamp today; when moved back to active/paused, clear it.
// An explicitly supplied canceledDate (e.g. an admin backdating a cancellation)
// is preserved.
function stampClientCancellation(client: Client): Client {
  const isCanceled = client.status === "canceled" || client.status === "refunded";
  if (isCanceled && !client.canceledDate) {
    return { ...client, canceledDate: todayISO() };
  }
  if (!isCanceled && client.canceledDate) {
    return { ...client, canceledDate: null };
  }
  return client;
}

function reducer(state: AppData, action: Action): AppData {
  switch (action.type) {
    case "HYDRATE":
      return action.data;
    case "RESET_DEMO":
      return buildDemoData();
    case "IMPORT":
      return withRecompute(action.data);

    case "SET_THEME":
      return { ...state, settings: { ...state.settings, theme: action.theme } };
    case "SET_COMPANY":
      return { ...state, settings: { ...state.settings, companyName: action.name } };
    case "SET_ASSUMPTIONS":
      return { ...state, settings: { ...state.settings, assumptions: action.assumptions } };

    // --- salespeople ---------------------------------------------------------
    case "SP_ADD":
      return withRecompute({ ...state, salespeople: [...state.salespeople, action.sp] });
    case "SP_UPDATE":
      return withRecompute({
        ...state,
        salespeople: state.salespeople.map((s) => (s.id === action.sp.id ? action.sp : s)),
      });
    case "SP_DELETE":
      return withRecompute({
        ...state,
        salespeople: state.salespeople.filter((s) => s.id !== action.id),
        clients: state.clients.map((c) =>
          c.salespersonId === action.id ? { ...c, salespersonId: null } : c,
        ),
      });
    case "SP_APPROVAL":
      return withRecompute({
        ...state,
        salespeople: state.salespeople.map((s) =>
          s.id === action.id
            ? {
                ...s,
                approvalStatus: action.approval,
                status: action.approval === "approved" ? "active" : "inactive",
              }
            : s,
        ),
      });

    // --- plans ---------------------------------------------------------------
    case "PLAN_ADD":
      return { ...state, plans: [...state.plans, action.plan] };
    case "PLAN_UPDATE":
      return withRecompute({
        ...state,
        plans: state.plans.map((p) => (p.id === action.plan.id ? action.plan : p)),
      });
    case "PLAN_DELETE":
      return withRecompute({
        ...state,
        plans: state.plans.filter((p) => p.id !== action.id),
        salespeople: state.salespeople.map((s) =>
          s.commissionPlanId === action.id ? { ...s, commissionPlanId: null } : s,
        ),
      });

    // --- clients -------------------------------------------------------------
    case "CLIENT_ADD":
      return withRecompute({
        ...state,
        clients: [...state.clients, stampClientCancellation(action.client)],
      });
    case "CLIENT_UPDATE": {
      const updated = stampClientCancellation(action.client);
      return withRecompute({
        ...state,
        clients: state.clients.map((c) => (c.id === updated.id ? updated : c)),
      });
    }
    case "CLIENT_DELETE":
      return withRecompute({
        ...state,
        clients: state.clients.filter((c) => c.id !== action.id),
        payments: state.payments.filter((p) => p.clientId !== action.id),
      });

    // --- payments ------------------------------------------------------------
    case "PAYMENT_ADD":
      return withRecompute({ ...state, payments: [...state.payments, action.payment] });
    case "PAYMENT_UPDATE":
      return withRecompute({
        ...state,
        payments: state.payments.map((p) => (p.id === action.payment.id ? action.payment : p)),
      });
    case "PAYMENT_DELETE":
      return withRecompute({
        ...state,
        payments: state.payments.filter((p) => p.id !== action.id),
      });

    // --- ledger status -------------------------------------------------------
    case "COMMISSION_SET_STATUS":
      return {
        ...state,
        commissions: state.commissions.map((e) =>
          action.ids.includes(e.id)
            ? {
                ...e,
                status: action.status,
                paidDate: action.status === "paid" ? todayISO() : e.paidDate,
              }
            : e,
        ),
      };

    // Admin force-release of held commissions. Sets the sticky releasedOverride
    // flag and recomputes so the resolver moves the line to pending immediately;
    // the flag survives future recomputes (e.g. on_approval lines never re-hold).
    case "RELEASE_COMMISSION":
      return withRecompute({
        ...state,
        commissions: state.commissions.map((e) =>
          action.ids.includes(e.id) ? { ...e, releasedOverride: true } : e,
        ),
      });

    // --- payouts (two-step) --------------------------------------------------
    case "PAYOUT_SUBMIT": {
      const ids = action.commissionEntryIds;
      const total = state.commissions
        .filter((e) => ids.includes(e.id))
        .reduce((s, e) => s + e.commissionAmount, 0);
      const payout: Payout = {
        id: uid("po"),
        salespersonId: action.salespersonId,
        commissionEntryIds: ids,
        totalAmount: total,
        status: "submitted",
        notes: action.notes,
        createdAt: new Date().toISOString(),
        submittedAt: new Date().toISOString(),
        approvedAt: null,
        paidAt: null,
      };
      return {
        ...state,
        payouts: [payout, ...state.payouts],
        commissions: state.commissions.map((e) =>
          ids.includes(e.id) ? { ...e, status: "submitted" } : e,
        ),
      };
    }
    case "PAYOUT_APPROVE": {
      const po = state.payouts.find((p) => p.id === action.id);
      if (!po) return state;
      return {
        ...state,
        payouts: state.payouts.map((p) =>
          p.id === action.id
            ? { ...p, status: "approved", approvedAt: new Date().toISOString() }
            : p,
        ),
        commissions: state.commissions.map((e) =>
          po.commissionEntryIds.includes(e.id) ? { ...e, status: "approved" } : e,
        ),
      };
    }
    case "PAYOUT_MARK_PAID": {
      const po = state.payouts.find((p) => p.id === action.id);
      if (!po) return state;
      return {
        ...state,
        payouts: state.payouts.map((p) =>
          p.id === action.id
            ? { ...p, status: "paid", paidAt: new Date().toISOString() }
            : p,
        ),
        commissions: state.commissions.map((e) =>
          po.commissionEntryIds.includes(e.id)
            ? { ...e, status: "paid", paidDate: todayISO() }
            : e,
        ),
      };
    }
    case "PAYOUT_REJECT": {
      const po = state.payouts.find((p) => p.id === action.id);
      if (!po) return state;
      return {
        ...state,
        payouts: state.payouts.map((p) =>
          p.id === action.id ? { ...p, status: "rejected" } : p,
        ),
        commissions: state.commissions.map((e) =>
          po.commissionEntryIds.includes(e.id) ? { ...e, status: "rejected" } : e,
        ),
      };
    }

    default:
      return state;
  }
}

// ----------------------------------------------------------------------------
// Context
// ----------------------------------------------------------------------------

interface Ctx {
  data: AppData;
  dispatch: React.Dispatch<Action>;
  storeName: string;
  backend: Backend;
  tenant: string;
  role: string;
  readOnly: boolean;
  reload: () => Promise<void>;
}

const AppCtx = createContext<Ctx | null>(null);

// A safe empty dataset to render against before async hydration completes.
function emptyData(): AppData {
  return {
    salespeople: [],
    plans: [],
    clients: [],
    payments: [],
    commissions: [],
    payouts: [],
    settings: {
      theme: "light",
      companyName: "Acme Commissions",
      assumptions: {
        avgSetupFee: 2500,
        avgMonthly: 250,
        closingsPerMonth: 5,
        monthlyChurnPct: 3,
        months: 60,
      },
    },
    version: SCHEMA_VERSION,
  };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [data, dispatch] = useReducer(reducer, undefined, emptyData);
  const hydrated = useRef(false);
  // When true, the next persist effect is skipped. Set by reload(): re-pulling
  // authoritative server data should not be echoed straight back as a snapshot
  // write. This is what lets per-resource API writes (salespeople, settings,
  // payouts) be the real source of truth instead of the snapshot.
  const suppressPersist = useRef(false);

  // Load once on mount; seed demo data if storage is empty.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const loaded = await store.load();
      if (cancelled) return;
      if (loaded) {
        dispatch({ type: "HYDRATE", data: loaded });
      } else {
        const demo = buildDemoData();
        dispatch({ type: "HYDRATE", data: demo });
        await store.save(demo);
      }
      hydrated.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist on every change (after initial hydration), unless this change came
  // from a reload() of authoritative server state (then we skip the echo).
  useEffect(() => {
    if (!hydrated.current) return;
    if (suppressPersist.current) {
      suppressPersist.current = false;
      return;
    }
    void store.save(data);
  }, [data]);

  // Reflect theme on <html> and remember it for the pre-paint script.
  useEffect(() => {
    const root = document.documentElement;
    if (data.settings.theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    try {
      localStorage.setItem("scm.theme", data.settings.theme);
    } catch {
      /* ignore */
    }
  }, [data.settings.theme]);

  // Switching tenants is no longer a client action: the tenant is fixed by the
  // authenticated session. (To act as another tenant, log in as a user there.)

  // Re-pull the authoritative dataset from the server. Used after server-side
  // workflow actions (e.g. payout transitions, salespeople/settings writes)
  // that change rows directly.
  async function reload(): Promise<void> {
    const loaded = await store.load();
    if (loaded) {
      suppressPersist.current = true;
      dispatch({ type: "HYDRATE", data: loaded });
    }
  }

  const { user } = useAuth();
  const value = useMemo(() => {
    const info = getBackendInfo();
    return {
      data,
      dispatch,
      storeName: info.label,
      backend: info.backend,
      tenant: user?.tenantName ?? user?.tenantSlug ?? "",
      role: user?.role ?? "",
      readOnly: info.readOnly,
      reload,
    };
  }, [data, user]);

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp(): Ctx {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("useApp must be used inside <AppProvider>");
  return ctx;
}
