// ============================================================================
// APP STATE
//
// A single React context holds the entire dataset and exposes typed actions.
//
// WHAT THE REDUCER IS FOR, NOW THAT THE SNAPSHOT WRITE IS GONE
// ------------------------------------------------------------
// `PUT /api/state` used to persist this whole object, which made the reducer a
// real write path: mutate here, and the snapshot carried it to the database.
// That is what allowed a browser to hold — and push — a balance the database
// disagreed with, so it was removed (see api/state.ts).
//
// Two roles remain:
//   1. On a server-backed deployment the reducer is DISPLAY STATE. Pages call
//      the per-resource endpoint and then reload() the authoritative dataset;
//      a reducer action is at most an optimistic echo, never the source of
//      truth, and `store.save()` is a no-op.
//   2. On the local-storage backend (`vite dev`, which serves no serverless
//      functions) there is no server to be authoritative, so the reducer IS the
//      database and `store.save()` persists it. `serverAuthoritative` on the
//      context is how a page tells the two apart.
//
// Whenever payments, clients, salespeople or plans change locally, the
// payment-derived and salary commission rows are recomputed by the same
// deterministic engine the server runs, so the two modes agree.
// ============================================================================

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
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
  isAuthError,
  isUnavailableError,
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
  | { type: "SET_PAYMENT_VERIFICATION"; required: boolean }
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
    case "SET_PAYMENT_VERIFICATION":
      return {
        ...state,
        settings: { ...state.settings, requirePaymentVerification: action.required },
      };

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
  /**
   * True when the database owns this tenant's data — i.e. every mutation must
   * go through a per-resource endpoint and the reducer is display-only.
   *
   * Pages branch on it for one reason: a failed write must be SHOWN here, not
   * absorbed into a browser-local copy. (Off only on the local-storage backend,
   * where `vite dev` runs no serverless functions and the reducer IS the
   * database.)
   */
  serverAuthoritative: boolean;
  reload: () => Promise<void>;
  /**
   * True when the dataset could not be loaded and no cached copy was allowed to
   * stand in for it (the production posture — see storage/fallback-policy.ts).
   * The UI must say so rather than render an empty or stale ledger.
   */
  unavailable: boolean;
  /**
   * True when `data` came from the localStorage cache because /api/state was
   * unreachable (network failure or 5xx), rather than from the server. Show it:
   * the numbers on screen are a snapshot, not live.
   */
  isOfflineData: boolean;
  /**
   * True from mount until the FIRST store.load() settles (success or failure).
   *
   * `data` starts out as emptyData() — an empty dataset that is indistinguishable
   * from "this tenant genuinely has no rows". Without this flag a consumer can
   * only guess, and pages guessed wrong: the salesperson portal rendered its
   * "No profile found" empty state for the ~1-2s the /api/state round trip takes,
   * then swapped to the real portal. Gate any "nothing here" UI on this.
   *
   * Deliberately NOT set by reload(): a post-write refresh must not blank a page
   * that is already showing good data.
   */
  hydrating: boolean;
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
  const { user, sessionExpired } = useAuth();
  const [data, dispatch] = useReducer(reducer, undefined, emptyData);
  const hydrated = useRef(false);
  // Render-visible twin of `hydrated` (a ref deliberately does not re-render).
  // Consumers read this to tell "still fetching" from "genuinely empty".
  const [hydrating, setHydrating] = useState(true);
  // Set when the load failed AND the cache was not allowed to substitute.
  const [unavailable, setUnavailable] = useState(false);
  // When true, the next persist effect is skipped. Set by reload(): re-pulling
  // authoritative server data should not be echoed straight back as a snapshot
  // write. This is what lets per-resource API writes (salespeople, settings,
  // payouts) be the real source of truth instead of the snapshot.
  const suppressPersist = useRef(false);

  /**
   * store.load(), with the one failure the app must not ignore handled once
   * here rather than at each call site: a 401/403 means this session is over,
   * so hand it to AuthContext (which drops the token and shows the login
   * screen) and report "no data" instead of leaving the UI on stale cache.
   * Every other failure — including the outage path, which store.load()
   * answers from the cache — is passed through to the caller unchanged.
   */
  const loadState = useCallback(async (): Promise<AppData | null> => {
    try {
      return await store.load();
    } catch (err) {
      if (isAuthError(err)) {
        sessionExpired();
        return null;
      }
      throw err;
    }
  }, [sessionExpired]);

  // Load once on mount. If the store is empty we hydrate an EMPTY dataset and do
  // NOT persist it, so the app never silently seeds sample/demo data. Seeding is
  // reserved for the explicit "Reset to demo data" action (RESET_DEMO).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let loaded: AppData | null = null;
      try {
        loaded = await loadState();
      } catch (err) {
        /* A dead session is handled by loadState(). What is left is either an
           outage the cache was not allowed to answer (production) or a real
           application error — both mean "we have no trustworthy data", which
           the UI must say out loud instead of rendering an empty ledger. */
        if (!cancelled && isUnavailableError(err)) setUnavailable(true);
      }
      if (cancelled) return;
      if (loaded) {
        dispatch({ type: "HYDRATE", data: loaded });
      } else {
        // Skip the persist echo for this hydration so the empty dataset is not
        // written back to the store.
        suppressPersist.current = true;
        dispatch({ type: "HYDRATE", data: emptyData() });
      }
      hydrated.current = true;
      // Always clear, success or failure: a page stuck on a spinner is worse
      // than one showing an honest empty state.
      setHydrating(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist on every change (after initial hydration), unless this change came
  // from a reload() of authoritative server state (then we skip the echo).
  // store.save() is a no-op wherever the server owns the data, so on a real
  // deployment this effect costs nothing and writes nothing.
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
  // Stable identity (store/dispatch/refs are all stable) so consumers can put
  // it in an effect dependency list without re-running the effect every render.
  const reload = useCallback(async (): Promise<void> => {
    const loaded = await loadState();
    if (loaded) {
      suppressPersist.current = true;
      setUnavailable(false);
      dispatch({ type: "HYDRATE", data: loaded });
    }
  }, [loadState]);

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
      serverAuthoritative: info.serverAuthoritative,
      reload,
      hydrating,
      unavailable,
      isOfflineData: info.isOfflineData,
    };
  }, [data, user, reload, hydrating, unavailable]);

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp(): Ctx {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("useApp must be used inside <AppProvider>");
  return ctx;
}
