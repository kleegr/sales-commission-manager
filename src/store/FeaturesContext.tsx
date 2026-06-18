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

  const refresh = useCallback(async () => {
    try {
      const map = await getFeatures();
      setFeatures(coerceFeatures(map));
    } catch {
      setFeatures(defaultFeatures()); // fail open
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
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
