// Dependency-free, DOM-free tests for the self-scoped portal view decision.
// Run via `tsx src/lib/portal-state.test.ts` (wired into `npm test`).
//
// The regression these lock in: a valid, linked salesperson must NEVER be shown
// the "No profile found" empty state, not even for one frame, while the first
// /api/state round trip is in flight.
import { portalView, type PortalViewInput } from "./portal-state";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`);
  }
}

/** The state at the very first paint after a Kleegr launch. */
function launch(over: Partial<PortalViewInput> = {}): PortalViewInput {
  return {
    hydrating: true,
    hasProfile: false,
    linkedSalespersonId: "sp_1",
    retryExhausted: false,
    ...over,
  };
}

console.log("\n[Portal view · the launch flash]");
ok("first paint of a linked rep is a skeleton, not an empty state", portalView(launch()) === "loading");
ok(
  "an unlinked account also waits while hydrating (link status is known, data is not)",
  portalView(launch({ linkedSalespersonId: null })) === "loading",
);
ok(
  "the dataset landing flips straight to the portal",
  portalView(launch({ hydrating: false, hasProfile: true })) === "ready",
);

console.log("\n[Portal view · after hydration]");
ok(
  "linked but no row yet -> keep waiting for the one-shot retry",
  portalView(launch({ hydrating: false })) === "loading",
);
ok(
  "linked, retry done, still no row -> unavailable (not 'no profile')",
  portalView(launch({ hydrating: false, retryExhausted: true })) === "unavailable",
);
ok(
  "genuinely unlinked -> the empty state is the truth",
  portalView(launch({ hydrating: false, linkedSalespersonId: null })) === "unlinked",
);
ok(
  "an undefined link (no session field) is treated as unlinked",
  portalView(launch({ hydrating: false, linkedSalespersonId: undefined })) === "unlinked",
);
ok(
  "an empty-string link is treated as unlinked",
  portalView(launch({ hydrating: false, linkedSalespersonId: "" })) === "unlinked",
);

console.log("\n[Portal view · a profile in hand always wins]");
ok(
  "reload() in flight does not blank a page that already has data",
  portalView(launch({ hydrating: true, hasProfile: true })) === "ready",
);
ok(
  "a profile with no session link still renders (e.g. admin/demo scoping)",
  portalView({ hydrating: false, hasProfile: true, linkedSalespersonId: null, retryExhausted: true }) === "ready",
);

console.log("\n[Portal view · never flashes the empty state]");
{
  // Walk the real launch timeline frame by frame; "unlinked" must not appear
  // until the session itself says the account has no link.
  const timeline: PortalViewInput[] = [
    launch(),
    launch({ hydrating: false }),
    launch({ hydrating: false, hasProfile: true }),
  ];
  ok(
    "no frame of a linked launch renders the empty state",
    timeline.every((f) => portalView(f) !== "unlinked"),
  );
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
