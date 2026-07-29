// ============================================================================
// useEmbedded  (client)
//
// Detects whether Sales Commission Manager is running EMBEDDED inside the
// Kleegr / GoHighLevel iframe, so the app shell can render a compact chrome
// instead of stacking a full sidebar + tall header on top of GHL's own UI.
//
// Two independent signals, either one is sufficient:
//
//   1. We are inside an iframe: window.self !== window.top. When the parent is
//      CROSS-ORIGIN (Kleegr / GHL) merely reading window.top throws a
//      SecurityError -- which itself proves we are framed, so the catch also
//      returns true.
//
//   2. We were launched from Kleegr: the launch redirect lands the browser on
//      ".../?kleegr=connected" (see api/kleegr/launch.ts). On first load we
//      latch that into sessionStorage ("scm.embedded" = "1") and treat the flag
//      as embedded thereafter, so the compact shell survives client-side route
//      changes that drop the query string.
//
// Standalone (non-embedded) use sees neither signal and is entirely unchanged.
// ============================================================================

import { useEffect, useState } from "react";

const EMBED_FLAG_KEY = "scm.embedded";

/** True when this document is not the top-level window (cross-origin -> true). */
function inIframe(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    // Cross-origin parent: the property access throws, which means we ARE framed.
    return true;
  }
}

/** Read the persisted launch flag, latching it on the first ?kleegr=connected load. */
function embeddedFlag(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get("kleegr") === "connected") {
      window.sessionStorage.setItem(EMBED_FLAG_KEY, "1");
      return true;
    }
    return window.sessionStorage.getItem(EMBED_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

/** Synchronous one-shot check (also latches the ?kleegr=connected flag). */
function detectEmbedded(): boolean {
  return inIframe() || embeddedFlag();
}

/** React hook: true when the app is embedded in the Kleegr / GoHighLevel iframe. */
export function useEmbedded(): boolean {
  const [embedded, setEmbedded] = useState<boolean>(detectEmbedded);
  useEffect(() => {
    // Re-evaluate after mount: latch the launch flag and settle window.top.
    setEmbedded(detectEmbedded());
  }, []);
  return embedded;
}
