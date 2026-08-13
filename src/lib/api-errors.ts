// ============================================================================
// API ERROR MESSAGES  (pure; unit-tested in api-errors.test.ts)
//
// The per-resource endpoints answer with machine-readable codes
// (`has_locked_commissions`, `separation_of_duties`, …). Now that a failed write
// no longer silently falls back to localStorage, those codes reach a human, so
// each one needs a sentence that says what happened and what to do next.
//
// Anything unmapped falls through to a generic line rather than leaking a raw
// code into the UI.
// ============================================================================

const MESSAGES: Record<string, string> = {
  // --- write refusals that protect money already committed -----------------
  has_locked_commissions:
    "This has commissions in a payout batch. Cancel or complete that payout first.",
  batch_total_mismatch:
    "The batch total no longer matches its lines. Reject the batch and submit it again.",
  batch_lines_changed:
    "The underlying payments or plan changed after this was submitted, so the amount is out of date. Reject it and submit a fresh batch.",
  entry_not_pending: "One of those commissions is no longer available to pay out.",
  entry_mismatch: "Some of those commission lines could not be found. Refresh and try again.",
  nothing_to_submit: "Select at least one commission line first.",
  insufficient_balance: "That is more than the available balance.",
  withdrawal_already_pending: "You already have a withdrawal request awaiting review.",
  below_minimum: "That is below the minimum withdrawal amount.",

  // --- authorization --------------------------------------------------------
  forbidden: "You don't have permission to do that.",
  unauthorized: "Your session has expired. Sign in again.",
  separation_of_duties: "A payout must be approved by someone other than the person who submitted it.",
  cannot_reassign: "Only an admin or manager can reassign a client to another rep.",
  salesperson_not_on_team: "That person isn't on your team.",
  client_not_in_scope: "That client isn't in your workspace.",
  csrf_check_failed: "Your session looks stale. Reload the page and try again.",

  // --- validation -----------------------------------------------------------
  company_name_required: "A company name is required.",
  client_required: "Choose a client first.",
  invalid_client: "That client no longer exists.",
  invalid_salesperson: "That person no longer exists.",
  no_fields_to_update: "Nothing changed.",
  id_required: "Missing record id.",
  not_found: "That record no longer exists.",

  // --- infrastructure -------------------------------------------------------
  database_not_configured: "The database isn't reachable right now. Try again shortly.",
  snapshot_write_removed:
    "This page is running an old version of the app. Reload to pick up the current one.",
  ai_disabled: "AI generation is turned off for this workspace.",
  ai_not_configured: "AI generation isn't configured on the server yet.",
};

const GENERIC = "That didn't save. Check your connection and try again.";

/** A human sentence for an API error (or a thrown Error carrying its code). */
export function errorMessage(err: unknown, fallback = GENERIC): string {
  const code =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : "";
  if (!code) return fallback;
  return MESSAGES[code] ?? fallback;
}

/** True when the failure means the user must resolve a payout first. */
export function isLockedByPayout(err: unknown): boolean {
  const code = err instanceof Error ? err.message : String(err ?? "");
  return code === "has_locked_commissions";
}
