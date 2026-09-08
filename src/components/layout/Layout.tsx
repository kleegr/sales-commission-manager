import { useEffect, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard, Users, ScrollText, Building2, CreditCard, BookOpenText,
  Wallet, UserRound, Presentation, BarChart3, Settings as SettingsIcon,
  Network, FileSignature,
  Target, Plug,
} from "lucide-react";
import { classNames } from "../../lib/format";
import { useApp } from "../../store/AppContext";
import { useAuth } from "../../store/AuthContext";
import { useFeatures } from "../../store/FeaturesContext";
import { useEmbedded } from "../../lib/useEmbedded";
import { canAccess, type Role } from "../../lib/roles";
import { featureAllowsPath, type FeatureFlags } from "../../lib/features";

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
      { to: "/people", label: "Team", icon: <Users className="h-4 w-4" /> },
      { to: "/plans", label: "Commission Plans", icon: <ScrollText className="h-4 w-4" /> },
      { to: "/opportunities", label: "Opportunities", icon: <Target className="h-4 w-4" /> },
      { to: "/campaigns", label: "Campaigns", icon: <Network className="h-4 w-4" /> },
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
      { to: "/media", label: "Media library", icon: <FileSignature className="h-4 w-4" /> },
      { to: "/portal", label: "My Portal", icon: <UserRound className="h-4 w-4" /> },
      { to: "/present", label: "Recruiting View", icon: <Presentation className="h-4 w-4" /> },
    ],
  },
  {
    heading: "Settings",
    items: [
      { to: "/tracker-settings", label: "Workspace rules", icon: <SettingsIcon className="h-4 w-4" /> },
      { to: "/sync-review", label: "Sync & review", icon: <Plug className="h-4 w-4" /> },
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
  const role = (user?.role ?? "salesperson") as Role;
  const sections = SECTIONS.map(section => ({ ...section,
    items: section.items.filter(item => navItemVisible(item, role, features, embedded)),
  })).filter(section => section.items.length > 0);
  const selected = currentItem(sections.flatMap(section => section.items), pathname);
  const activeSection = selected ? sections.find(section => section.items.includes(selected)) : undefined;
  const pending = data.salespeople.filter(person =>
    person.source === "affiliate_portal" && person.approvalStatus === "pending").length;

  useEffect(() => {
    // Keep the active tab visible after deep links and browser back/forward on phones.
    document.querySelector('[data-primary-navigation] [aria-current="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  return (
    <div className="app-shell flex min-h-screen min-w-0 flex-col">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <header className="app-topbar sticky top-0 z-30 border-b border-slate-200/80 bg-white/95 backdrop-blur-xl dark:border-slate-800 dark:bg-slate-900/95">
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

