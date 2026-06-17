import { useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  ScrollText,
  Layers,
  Building2,
  CreditCard,
  BookOpenText,
  Wallet,
  UserRound,
  UserPlus,
  Presentation,
  Settings as SettingsIcon,
  Moon,
  Sun,
  Menu,
  X,
  Coins,
} from "lucide-react";
import { classNames } from "../../lib/format";
import { useApp } from "../../store/AppContext";

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
    ],
  },
  {
    heading: "Portals",
    items: [
      { to: "/portal", label: "Salesperson View", icon: <UserRound className="h-4 w-4" /> },
      { to: "/signup", label: "Affiliate Signup", icon: <UserPlus className="h-4 w-4" /> },
      { to: "/present", label: "Recruiting View", icon: <Presentation className="h-4 w-4" /> },
    ],
  },
  {
    heading: "System",
    items: [
      { to: "/settings", label: "Settings & Data", icon: <SettingsIcon className="h-4 w-4" /> },
    ],
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
  const pendingAffiliates = data.salespeople.filter(
    (s) => s.source === "affiliate_portal" && s.approvalStatus === "pending",
  ).length;

  return (
    <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
      {SECTIONS.map((section) => (
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

export function Layout({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  return (
    <div className="min-h-screen lg:flex">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 flex-none flex-col border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 lg:flex">
        <Brand />
        <NavContents />
        <div className="border-t border-slate-200 px-4 py-3 text-[11px] text-slate-400 dark:border-slate-800">
          Prototype · browser storage only
        </div>
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
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
          </aside>
        </div>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white/80 px-4 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80 lg:px-8">
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

        <main
          key={location.pathname}
          className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 lg:px-8 lg:py-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
