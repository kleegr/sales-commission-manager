import { useState, type ReactNode } from "react";
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
} from "lucide-react";
import { classNames } from "../../lib/format";
import { useApp } from "../../store/AppContext";
import { useAuth } from "../../store/AuthContext";
import { useFeatures } from "../../store/FeaturesContext";
import { canAccess, homePath, ROLE_LABEL, type Role } from "../../lib/roles";
import { featureAllowsPath } from "../../lib/features";
import { DemoBar } from "./DemoBar";
import { Network, FileSignature, Target } from "lucide-react";

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
    items: [{ to: "/settings", label: "Settings & Data", icon: <SettingsIcon className="h-4 w-4" /> }],
  },
];

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
  const role = (user?.role ?? "salesperson") as Role;

  const pendingAffiliates = data.salespeople.filter(
    (s) => s.source === "affiliate_portal" && s.approvalStatus === "pending",
  ).length;

  const sections = SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) => canAccess(role, item.to) && featureAllowsPath(item.to, role, features),
    ),
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

export function Layout({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

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
