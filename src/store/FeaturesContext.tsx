// ============================================================================
// FEATURES CONTEXT  (client)
//
// Loads the current tenant's feature-access map from /api/features once per
// session and exposes it to the nav, the route guard, and the Settings editor.
// The tenant is derived from the session on the server; the client never sends
// it.
//
// FAILS OPEN: if the API is unreachable (e.g. `vite dev` with no serverless
// functions, or the local-storage fallback backend) the full feature set is
// assumed enabled, so a transient hiccup never hides the product.
// ============================================================================

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  coerceFeatures,
  defaultFeatures,
  type FeatureFlags,
  type FeatureKey,
} from "../lib/features";
import { getFeatures } from "../lib/resource-client";

interface FeaturesCtx {
  features: FeatureFlags;
  loading: boolean;
  isEnabled: (key: FeatureKey) => boolean;
  /** Apply a freshly-saved map locally (instant nav update) without a refetch. */
  setLocal: (next: FeatureFlags) => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<FeaturesCtx | null>(null);

export function FeaturesProvider({ children }: { children: ReactNode }) {
  const [features, setFeatures] = useState<FeatureFlags>(defaultFeatures());
  const [loading, setLoading] = useState(true);
  // True once any fetch has succeeded. Before that, a failure fails OPEN
  // (default all-on, so a dev environment with no API still shows the product);
  // after it, a failure keeps the LAST KNOWN map instead of silently
  // re-enabling everything the agency turned off.
  const hadSuccess = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const map = await getFeatures();
      hadSuccess.current = true;
      setFeatures(coerceFeatures(map));
    } catch {
      if (!hadSuccess.current) setFeatures(defaultFeatures()); // fail open only before the first success
      // otherwise: keep the last known snapshot (fail closed)
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Flags are edited by the agency in another session: re-pull when the tab
    // regains focus and on a modest interval, so revocations actually land.
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 5 * 60 * 1000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const isEnabled = useCallback((key: FeatureKey) => features[key] !== false, [features]);
  const setLocal = useCallback((next: FeatureFlags) => setFeatures(next), []);

  return (
    <Ctx.Provider value={{ features, loading, isEnabled, setLocal, refresh }}>
      {children}
    </Ctx.Provider>
  );
}

export function useFeatures(): FeaturesCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useFeatures must be used inside <FeaturesProvider>");
  return ctx;
}
