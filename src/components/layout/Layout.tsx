import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  ScrollText,
  Building2,
  CreditCard,
  BookOpenText,
  Wallet,
  UserRound,
  Presentation,
  BarChart3,
  Settings as SettingsIcon,
  Moon,
  Sun,
  Menu,
  X,
  Coins,
  Database,
  HardDrive,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { classNames } from "../../lib/format";
import { useApp } from "../../store/AppContext";
import { useAuth } from "../../store/AuthContext";
import { useFeatures } from "../../store/FeaturesContext";
import { useEmbedded } from "../../lib/useEmbedded";
import { browserPrefStore, readSidebarPref, writeSidebarPref } from "../../lib/sidebar-pref";
import { canAccess, homePath, ROLE_LABEL, type Role } from "../../lib/roles";
import { featureAllowsPath, type FeatureFlags } from "../../lib/features";
import { DemoBar } from "./DemoBar";
import { Network, FileSignature, Target, Plug } from "lucide-react";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
}

const SECTIONS: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Overview",
    items: [
      { to: "/", label: "Dashboard", icon: <LayoutDashboard className="h-4 w-4" />, end: true },
      { to: "/agency", label: "Agency (all sub-accounts)", icon: <Network className="h-4 w-4" /> },
    ],
  },
  {
    heading: "Manage",
    items: [
      { to: "/people", label: "Salespeople", icon: <Users className="h-4 w-4" /> },
      { to: "/plans", label: "Commission Plans", icon: <ScrollText className="h-4 w-4" /> },
      { to: "/clients", label: "Clients", icon: <Building2 className="h-4 w-4" /> },
      { to: "/payments", label: "Payments", icon: <CreditCard className="h-4 w-4" /> },
    ],
  },
  {
    heading: "Commissions",
    items: [
      { to: "/ledger", label: "Commission Ledger", icon: <BookOpenText className="h-4 w-4" /> },
      { to: "/payouts", label: "Payouts", icon: <Wallet className="h-4 w-4" /> },
      { to: "/reports", label: "Reports", icon: <BarChart3 className="h-4 w-4" /> },
      { to: "/goals", label: "Goals & Milestones", icon: <Target className="h-4 w-4" /> },
    ],
  },
  {
    heading: "Documents",
    items: [
      { to: "/documents", label: "Proposals & Contracts", icon: <FileSignature className="h-4 w-4" /> },
    ],
  },
  {
    heading: "Portal",
    items: [
      { to: "/portal", label: "My Portal", icon: <UserRound className="h-4 w-4" /> },
      { to: "/present", label: "Recruiting View", icon: <Presentation className="h-4 w-4" /> },
    ],
  },
  {
    heading: "System",
    items: [
      { to: "/settings", label: "Settings & Data", icon: <SettingsIcon className="h-4 w-4" /> },
      { to: "/settings/integrations/kleegr", label: "Kleegr Integration", icon: <Plug className="h-4 w-4" /> },
    ],
  },
];

/**
 * Whether a nav item is visible for the given role + feature flags.
 *
 * `embedded` layers ONE extra rule on top of the normal role/feature gating:
 * inside a single Kleegr sub-account iframe the cross-sub-account "Agency"
 * overview is confusing for everyone except the agency owner, so it is hidden
 * there. In the standalone app `embedded` is always false, so this collapses to
 * the original `canAccess && featureAllowsPath` gate and the nav is unchanged.
 */
function navItemVisible(item: NavItem, role: Role, features: FeatureFlags, embedded: boolean): boolean {
  if (!canAccess(role, item.to)) return false;
  if (!featureAllowsPath(item.to, role, features)) return false;
  if (embedded && role !== "owner" && item.to === "/agency") return false;
  return true;
}

function ThemeToggle() {
  const { data, dispatch } = useApp();
  const dark = data.settings.theme === "dark";
  return (
    <button
      onClick={() => dispatch({ type: "SET_THEME", theme: dark ? "light" : "dark" })}
      className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle theme"
    >
      {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </button>
  );
}

function NavContents({ onNavigate }: { onNavigate?: () => void }) {
  const { data } = useApp();
  const { user } = useAuth();
  const { features } = useFeatures();
  const embedded = useEmbedded();
  const role = (user?.role ?? "salesperson") as Role;

  const pendingAffiliates = data.salespeople.filter(
    (s) => s.source === "affiliate_portal" && s.approvalStatus === "pending",
  ).length;

  const sections = SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => navItemVisible(item, role, features, embedded)),
  })).filter((section) => section.items.length > 0);

  return (
    <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
      {sections.map((section) => (
        <div key={section.heading}>
          <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
            {section.heading}
          </p>
          <ul className="space-y-0.5">
            {section.items.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    classNames(
                      "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                      isActive
                        ? "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
                        : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white",
                    )
                  }
                >
                  {item.icon}
                  <span className="flex-1">{item.label}</span>
                  {item.to === "/people" && pendingAffiliates > 0 && (
                    <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700 dark:bg-violet-500/20 dark:text-violet-300">
                      {pendingAffiliates}
                    </span>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function Brand() {
  const { data } = useApp();
  return (
    <div className="flex items-center gap-2.5 px-5 py-4">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white shadow-sm">
        <Coins className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">
          {data.settings.companyName || "Commission Manager"}
        </p>
        <p className="text-[11px] text-slate-400">Commission Manager</p>
      </div>
    </div>
  );
}

function UserCard() {
  const { user, logout, demo } = useAuth();
  if (!user) return null;
  const initials = user.name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">
        {initials}
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-[12px] font-medium text-slate-700 dark:text-slate-200">{user.name}</p>
        <p className="truncate text-[10px] text-slate-400">
          {ROLE_LABEL[user.role]}
          {demo ? " · review mode" : ""}
        </p>
      </div>
      {!demo && (
        <button
          onClick={() => void logout()}
          title="Sign out"
          aria-label="Sign out"
          className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-rose-600 dark:hover:bg-slate-800"
        >
          <LogOut className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function DataSourceBadge() {
  const { backend, tenant, readOnly } = useApp();
  const onNeon = backend === "neon";
  const detecting = backend === "unknown";
  return (
    <div className="flex items-center gap-2">
      <span
        className={classNames(
          "flex h-6 w-6 flex-none items-center justify-center rounded-md",
          onNeon
            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400"
            : "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
        )}
      >
        {onNeon ? <Database className="h-3.5 w-3.5" /> : <HardDrive className="h-3.5 w-3.5" />}
      </span>
      <div className="min-w-0 leading-tight">
        <p className="truncate text-[11px] font-medium text-slate-600 dark:text-slate-300">
          {detecting ? "Detecting…" : onNeon ? "Neon Postgres" : "Browser storage"}
        </p>
        <p className="truncate text-[10px] text-slate-400">
          {onNeon ? `${tenant}${readOnly ? " · read-only" : ""}` : "local fallback"}
        </p>
      </div>
    </div>
  );
}

function WorkspaceBadge() {
  const { user } = useAuth();
  if (!user) return null;
  const name = user.tenantName || user.tenantSlug;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-300">
        <Building2 className="h-4 w-4" />
      </span>
      <div className="min-w-0 leading-tight">
        <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Sub-account</p>
        <p className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{name}</p>
      </div>
      <span className="hidden flex-none rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-300 sm:inline">
        {ROLE_LABEL[user.role]}
      </span>
    </div>
  );
}

/** Shared pending-affiliate badge for the embedded rail (both density modes). */
function PendingBadge({ count, compact }: { count: number; compact: boolean }) {
  if (count <= 0) return null;
  return (
    <span
      className={classNames(
        "flex items-center justify-center rounded-full bg-violet-500 font-semibold leading-none text-white",
        compact
          ? "absolute right-1 top-1 h-4 min-w-[16px] px-1 text-[9px]"
          : "h-4 min-w-[16px] flex-none px-1 text-[10px]",
      )}
    >
      {count}
    </span>
  );
}

/**
 * Collapsed rail item: an icon plus an INSTANT flyout label on hover/focus.
 *
 * The label is portalled to <body> and positioned `fixed` rather than being an
 * absolutely-positioned child of the link. That is not gold-plating: the rail's
 * <nav> is a scroll container (`overflow-y-auto`), and per CSS overflow rules a
 * non-visible value on one axis forces the other axis to compute to `auto` too
 * -- so an in-flow flyout would be clipped at the 56px rail edge (or, worse,
 * introduce a horizontal scrollbar). Portalling escapes the clip and every
 * ancestor stacking context in one move.
 *
 * Replaces the native `title` attribute, whose ~1s delay and unstyled chrome
 * made the rail read as though it had no labels at all. `aria-label` stays, so
 * the accessible name is unchanged for screen readers.
 */
function RailIconLink({ item, pending }: { item: NavItem; pending: number }) {
  const ref = useRef<HTMLAnchorElement | null>(null);
  const [tip, setTip] = useState<{ top: number; left: number } | null>(null);

  const hide = useCallback(() => setTip(null), []);
  const show = useCallback(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setTip({ top: r.top + r.height / 2, left: r.right + 8 });
  }, []);

  // Coordinates are captured at hover time, so anything that moves the anchor
  // afterwards (rail scroll, iframe resize) would leave the flyout stranded.
  // Dismiss instead of tracking -- the pointer is about to leave anyway.
  useEffect(() => {
    if (!tip) return;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [tip, hide]);

  return (
    <>
      <NavLink
        ref={ref}
        to={item.to}
        end={item.end}
        aria-label={item.label}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={hide}
        className={({ isActive }) =>
          classNames(
            "relative flex h-10 w-10 flex-none items-center justify-center rounded-lg transition",
            isActive
              ? "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
              : "text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white",
          )
        }
      >
        {item.icon}
        {item.to === "/people" && <PendingBadge count={pending} compact />}
      </NavLink>
      {tip &&
        createPortal(
          <span
            role="tooltip"
            style={{ top: tip.top, left: tip.left }}
            className="pointer-events-none fixed z-[70] -translate-y-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white shadow-lg dark:bg-slate-700"
          >
            {item.label}
          </span>,
          document.body,
        )}
    </>
  );
}

/** Expanded rail item: icon + full text label, matching the standalone sidebar. */
function RailWideLink({
  item,
  pending,
  onNavigate,
}: {
  item: NavItem;
  pending: number;
  onNavigate?: () => void;
}) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        classNames(
          "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition",
          isActive
            ? "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
            : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white",
        )
      }
    >
      <span className="flex-none">{item.icon}</span>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.to === "/people" && <PendingBadge count={pending} compact={false} />}
    </NavLink>
  );
}

/**
 * Navigation for the embedded (Kleegr iframe) shell, in two densities.
 *
 * Collapsed keeps the original flat icon list (with flyout labels). Expanded
 * restores the section headings the flat list had to drop, so the six groups
 * -- Overview / Manage / Commissions / Documents / Portal / System -- are
 * legible again without leaving the iframe.
 */
function EmbeddedNavRail({ expanded, onNavigate }: { expanded: boolean; onNavigate?: () => void }) {
  const { data } = useApp();
  const { user } = useAuth();
  const { features } = useFeatures();
  const role = (user?.role ?? "salesperson") as Role;

  const pendingAffiliates = data.salespeople.filter(
    (s) => s.source === "affiliate_portal" && s.approvalStatus === "pending",
  ).length;

  // Hide the Agency item here for non-owners (embedded === true) via the shared
  // visibility rule, then either group by section or flatten to a single list.
  const sections = SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => navItemVisible(item, role, features, true)),
  })).filter((section) => section.items.length > 0);

  if (!expanded) {
    return (
      <nav className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto py-3">
        {sections
          .flatMap((section) => section.items)
          .map((item) => (
            <RailIconLink key={item.to} item={item} pending={pendingAffiliates} />
          ))}
      </nav>
    );
  }

  return (
    <nav className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2 py-3">
      {sections.map((section) => (
        <div key={section.heading}>
          <p className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
            {section.heading}
          </p>
          <ul className="space-y-0.5">
            {section.items.map((item) => (
              <li key={item.to}>
                <RailWideLink item={item} pending={pendingAffiliates} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Expand/collapse control for the embedded rail. */
function RailToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
      title={expanded ? "Collapse sidebar" : "Expand sidebar"}
      className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    >
      {expanded ? <PanelLeftClose className="h-5 w-5" /> : <PanelLeftOpen className="h-5 w-5" />}
    </button>
  );
}

/** Width below which an expanded rail overlays the content instead of pushing it. */
const RAIL_OVERLAY_BELOW = 640;

/**
 * Tracks whether the app shell is too narrow to give up 224px to an expanded
 * rail.
 *
 * Measures the ELEMENT, not the viewport: inside GHL the iframe is only a slice
 * of the window, so Tailwind's `sm:`/`lg:` breakpoints (which resolve against
 * the viewport) would report a roomy desktop while the frame itself is 420px
 * wide. A ResizeObserver on the shell is the only reading that matches what the
 * user actually sees.
 */
function useNarrowShell(ref: RefObject<HTMLElement>): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setNarrow(el.getBoundingClientRect().width < RAIL_OVERLAY_BELOW);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return narrow;
}

/**
 * Compact shell for the Kleegr / GoHighLevel iframe: a narrow rail and NO tall
 * header / agency-name block, so the app does not stack a 256px sidebar +
 * header on top of GHL's own chrome.
 *
 * The rail has two densities. It still DEFAULTS to the 56px icon-only mode --
 * unchanged for anyone who never touches the toggle -- but the user can now
 * expand it to 224px with labels, and that choice is remembered in
 * localStorage across reloads and sub-account switches. On a frame too narrow
 * to spare the width, expanding overlays the content rather than squeezing it.
 */
function EmbeddedShell({ children }: { children: ReactNode }) {
  const { data } = useApp();
  const location = useLocation();
  const shellRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrowShell(shellRef);
  const [expanded, setExpanded] = useState(() => readSidebarPref(browserPrefStore(), false));

  const setAndRemember = useCallback((next: boolean) => {
    setExpanded(next);
    writeSidebarPref(browserPrefStore(), next);
  }, []);
  const collapse = useCallback(() => setAndRemember(false), [setAndRemember]);

  // Expanded + too narrow to give up the width: float the rail over the content
  // instead of pushing it into a sliver.
  const overlay = expanded && narrow;

  // While floating, the rail behaves like a drawer: Escape, a backdrop click,
  // or picking a destination all dismiss it. Dismissal goes through the same
  // persisted setter as the toggle, so "collapsed" means one thing everywhere.
  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") collapse();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay, collapse]);

  return (
    <div className="flex min-h-screen flex-col">
      <DemoBar />
      <div ref={shellRef} className="relative flex min-h-0 flex-1">
        {overlay && (
          <>
            <div
              onClick={collapse}
              aria-hidden
              className="fixed inset-0 z-30 bg-slate-900/40 backdrop-blur-sm"
            />
            {/* Holds the content column still while the rail floats above it. */}
            <div className="w-14 flex-none" aria-hidden />
          </>
        )}

        {/*
          The rail is viewport-bounded, not content-bounded. The shell is
          `min-h-screen`, so a long page would otherwise stretch the rail to the
          full document height and drag the toggle below the fold -- unreachable
          without scrolling to the bottom of the page. `sticky top-0` +
          `max-h-screen` keeps it in view, and the nav's `min-h-0` lets the link
          list scroll inside it so the footer controls stay pinned.

          Exactly ONE position utility is emitted: Tailwind ships `sticky` and
          `fixed` in the same layer, so which one wins is decided by stylesheet
          order, not by the order we concatenate class names.
        */}
        <aside
          className={classNames(
            "z-40 flex flex-none flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900",
            expanded ? "w-56" : "w-14 items-center",
            overlay ? "fixed inset-y-0 left-0 shadow-xl" : "sticky top-0 max-h-screen",
          )}
        >
          <div
            className={classNames(
              "flex flex-none items-center py-3",
              expanded ? "gap-2 px-3" : "justify-center",
            )}
          >
            <span
              className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-brand-600 text-white shadow-sm"
              title="Commission Manager"
            >
              <Coins className="h-5 w-5" />
            </span>
            {expanded && (
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-slate-900 dark:text-white">
                  {data.settings.companyName || "Commission Manager"}
                </p>
                <p className="truncate text-[10px] text-slate-400">Commission Manager</p>
              </div>
            )}
          </div>

          <EmbeddedNavRail expanded={expanded} onNavigate={overlay ? collapse : undefined} />

          <div
            className={classNames(
              "mb-2 mt-1 flex flex-none gap-1",
              expanded ? "items-center justify-end px-2" : "flex-col items-center",
            )}
          >
            <ThemeToggle />
            <RailToggle expanded={expanded} onToggle={() => setAndRemember(!expanded)} />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <main key={location.pathname} className="mx-auto w-full max-w-7xl flex-1 px-4 py-5 lg:px-6">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const embedded = useEmbedded();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  // Embedded in the Kleegr / GoHighLevel iframe: compact shell. The standalone
  // layout below is returned unchanged.
  if (embedded) return <EmbeddedShell>{children}</EmbeddedShell>;

  return (
    <div className="flex min-h-screen flex-col">
      <DemoBar />
      <div className="flex min-h-0 flex-1 lg:flex">
        {/* Desktop sidebar */}
        <aside className="hidden w-64 flex-none flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 lg:flex">
          <Brand />
          <NavContents />
          <div className="space-y-3 border-t border-slate-200 px-4 py-3 dark:border-slate-800">
            <UserCard />
            <DataSourceBadge />
          </div>
        </aside>

        {/* Mobile drawer */}
        {mobileOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
            <aside className="absolute inset-y-0 left-0 flex w-72 flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
              <div className="flex items-center justify-between">
                <Brand />
                <button
                  onClick={() => setMobileOpen(false)}
                  className="mr-3 inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <NavContents onNavigate={() => setMobileOpen(false)} />
              <div className="space-y-3 border-t border-slate-200 px-4 py-3 dark:border-slate-800">
                <UserCard />
                <DataSourceBadge />
              </div>
            </aside>
          </div>
        )}

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="z-30 flex items-center gap-3 border-b border-slate-200 bg-white/80 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80 lg:px-8">
            <button
              onClick={() => setMobileOpen(true)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 lg:hidden"
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>
            <WorkspaceBadge />
            <div className="flex-1" />
            <ThemeToggle />
          </header>

          <main key={location.pathname} className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 lg:px-8 lg:py-8">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
