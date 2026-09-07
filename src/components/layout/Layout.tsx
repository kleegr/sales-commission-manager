import { useEffect, useRef, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard, Users, ScrollText, Building2, CreditCard, BookOpenText,
  Wallet, UserRound, Presentation, BarChart3, Settings as SettingsIcon,
  Moon, Sun, Coins, Database, HardDrive, LogOut, Network, FileSignature,
  Target, Plug, ChevronDown,
} from "lucide-react";
import { classNames } from "../../lib/format";
import { useApp } from "../../store/AppContext";
import { useAuth } from "../../store/AuthContext";
import { useFeatures } from "../../store/FeaturesContext";
import { useEmbedded } from "../../lib/useEmbedded";
import { canAccess, homePath, ROLE_LABEL, type Role } from "../../lib/roles";
import { featureAllowsPath, type FeatureFlags } from "../../lib/features";
import { DemoBar } from "./DemoBar";

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
      { to: "/agency", label: "Agency overview", icon: <Network className="h-4 w-4" /> },
    ],
  },
  {
    heading: "Team & clients",
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
    heading: "Resources",
    items: [
      { to: "/portal", label: "My Portal", icon: <UserRound className="h-4 w-4" /> },
      { to: "/present", label: "Recruiting View", icon: <Presentation className="h-4 w-4" /> },
    ],
  },
  {
    heading: "Settings",
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
  const { backend, tenant, readOnly, isOfflineData } = useApp();
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
          {detecting ? "Checking connection…" : onNeon ? "Connected" : isOfflineData ? "Offline" : "Local data"}
        </p>
        <p className="truncate text-[10px] text-slate-400">
          {onNeon
            ? `${tenant}${readOnly ? " · read-only" : ""}`
            : // The server was unreachable, so these numbers are a cached
              // snapshot rather than live data — say so, don't imply otherwise.
              isOfflineData
              ? "showing cached data"
              : "local fallback"}
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
        <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{user.role === "owner" ? "Agency workspace" : "Sub-account"}</p>
        <p className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{name}</p>
      </div>
      <span className="hidden flex-none rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-300 sm:inline">
        {ROLE_LABEL[user.role]}
      </span>
    </div>
  );
}

/** Use the longest route match so integration settings never select two links. */
function currentItem(items: NavItem[], pathname: string) {
  return items.filter(item => pathname === item.to ||
    (!item.end && pathname.startsWith(item.to + "/")))
    .sort((a, b) => b.to.length - a.to.length)[0];
}

export function Layout({ children }: { children: ReactNode }) {
  const embedded = useEmbedded();
  const { pathname } = useLocation();
  const { user } = useAuth();
  const { data } = useApp();
  const { features } = useFeatures();
  const accountRef = useRef<HTMLDetailsElement>(null);
  const role = (user?.role ?? "salesperson") as Role;
  const sections = SECTIONS.map(section => ({ ...section,
    items: section.items.filter(item => navItemVisible(item, role, features, embedded)),
  })).filter(section => section.items.length > 0);
  const selected = currentItem(sections.flatMap(section => section.items), pathname);
  const activeSection = selected ? sections.find(section => section.items.includes(selected)) : undefined;
  const pending = data.salespeople.filter(person =>
    person.source === "affiliate_portal" && person.approvalStatus === "pending").length;

  useEffect(() => {
    if (accountRef.current) accountRef.current.open = false;
    // Keep the active tab visible after deep links and browser back/forward on phones.
    document.querySelector('[data-primary-navigation] [aria-current="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (accountRef.current && !accountRef.current.contains(event.target as Node)) {
        accountRef.current.open = false;
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && accountRef.current?.open) {
        accountRef.current.open = false;
        accountRef.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return (
    <div className="app-shell flex min-h-screen min-w-0 flex-col">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <DemoBar />
      <header className="app-topbar sticky top-0 z-30 border-b border-slate-200/80 bg-white/95 backdrop-blur-xl dark:border-slate-800 dark:bg-slate-900/95">
        <div className="mx-auto flex max-w-[1600px] items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
          {!embedded && (
            <Link to={homePath(role)} aria-label="Commission Manager home" className="mr-3 hidden items-center gap-2.5 border-r border-slate-200 pr-6 dark:border-slate-700 md:flex">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm"><Coins className="h-5 w-5" /></span>
              <span className="text-sm font-semibold tracking-tight">Commission Manager</span>
            </Link>
          )}
          <div className="min-w-0 flex-1"><WorkspaceBadge /></div>
          <ThemeToggle />
          <details ref={accountRef} className="account-menu relative flex-none">
            <summary aria-label="Account and connection" className="flex cursor-pointer list-none items-center gap-2 rounded-full border border-slate-200 px-2 py-1.5 text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
              <UserRound className="h-4 w-4" /><span className="hidden text-xs font-medium sm:inline">Account</span><ChevronDown className="h-3.5 w-3.5" />
            </summary>
            <div className="absolute right-0 top-full mt-2 w-64 space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-xl dark:border-slate-700 dark:bg-slate-900">
              <UserCard />
              <div className="border-t border-slate-100 pt-3 dark:border-slate-800"><DataSourceBadge /></div>
            </div>
          </details>
        </div>
        <nav aria-label="Primary navigation" data-primary-navigation className="mx-auto flex max-w-[1600px] gap-1 overflow-x-auto px-4 sm:px-6 lg:px-8">
          {sections.map(section => {
            const active = section === activeSection;
            return (
              <Link key={section.heading} to={active && selected ? selected.to : section.items[0].to}
                aria-current={active ? "true" : undefined}
                className={classNames("top-nav-link relative flex shrink-0 items-center gap-2 whitespace-nowrap px-3 py-3 text-sm font-medium transition sm:px-4",
                  active ? "text-brand-700 dark:text-brand-300" : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white")}>
                {section.items[0].icon}
                {section.heading}
                {section.heading === "Team & clients" && pending > 0 && <span aria-label={`${pending} pending affiliates`} className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700 dark:bg-violet-500/20 dark:text-violet-300">{pending}</span>}
                {active && <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-brand-600 dark:bg-brand-400" />}
              </Link>
            );
          })}
        </nav>
        {activeSection && (
          <nav aria-label={`${activeSection.heading} navigation`} className="border-t border-slate-100 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-950/30">
            <div className="mx-auto flex max-w-[1600px] items-center gap-1.5 overflow-x-auto px-4 py-2 sm:px-6 lg:px-8">
              {activeSection.items.map(item => (
                <Link key={item.to} to={item.to}
                  aria-current={selected === item ? "page" : undefined}
                  className={classNames("flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition",
                    selected === item ? "bg-white text-brand-700 shadow-sm ring-1 ring-slate-200/70 dark:bg-slate-800 dark:text-brand-300 dark:ring-slate-700" : "text-slate-500 hover:bg-white hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100")}>
                  {item.icon}{item.label}
                </Link>
              ))}
            </div>
          </nav>
        )}
      </header>
      <main id="main-content" tabIndex={-1} key={pathname} className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6 outline-none sm:px-6 lg:px-8 lg:py-8">
        {children}
      </main>
    </div>
  );
}
