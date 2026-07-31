// ============================================================================
// SELF-SCOPED PORTAL VIEW STATE
//
// Decides what the salesperson / affiliate portal should render before, during
// and after the dataset arrives. Extracted as a pure function so the rule is
// testable without a DOM.
//
// The bug this exists to prevent: both portals read `data.salespeople[0]` and
// rendered a "No profile found" empty state when it was undefined. On launch it
// is ALWAYS undefined for the first ~1-2s, because AppProvider starts from
// emptyData() and only then fetches /api/state — so every valid, correctly
// linked rep saw "No profile found" flash before their portal appeared.
//
// The signal that resolves it: /api/auth/me returns `salespersonId`, and it
// lands BEFORE the app shell mounts (main.tsx gates on auth loading). So the
// account's link status is already known when the first paint happens:
//
//   linked (salespersonId set)  -> the rows exist; we are merely waiting
//   unlinked (salespersonId null) -> "No profile found" is the truth, show it
//                                    immediately, no spinner needed
// ============================================================================

export type PortalView =
  /** Dataset (or the linked rep row) is still on its way — render a skeleton. */
  | "loading"
  /** The rep record is in hand — render the real portal. */
  | "ready"
  /** This login genuinely has no salesperson record linked to it. */
  | "unlinked"
  /** Linked per the session, but the dataset never produced the row. */
  | "unavailable";

export interface PortalViewInput {
  /** AppContext.hydrating — the first store.load() has not settled yet. */
  hydrating: boolean;
  /** Whether data.salespeople[0] resolved to a record. */
  hasProfile: boolean;
  /** users.salesperson_id for the session, from /api/auth/me. */
  linkedSalespersonId: string | null | undefined;
  /** The one-shot reload() for a linked-but-missing profile has completed. */
  retryExhausted: boolean;
}

export function portalView({
  hydrating,
  hasProfile,
  linkedSalespersonId,
  retryExhausted,
}: PortalViewInput): PortalView {
  // A profile in hand always wins — including mid-reload(), so a post-write
  // refresh never blanks a page that is already showing good data.
  if (hasProfile) return "ready";
  if (hydrating) return "loading";
  // Hydration finished with no rep row. Only the session's link status can say
  // whether that is the truth or a miss.
  if (!linkedSalespersonId) return "unlinked";
  return retryExhausted ? "unavailable" : "loading";
}
