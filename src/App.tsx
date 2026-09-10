import {lazy,Suspense} from 'react';
import {PreferencesProvider} from './components/tracker/Experience';
const Operations = lazy(()=>import('./pages/tracker/Operations'));
import {TrackerProvider,TrackerGate} from './components/TrackerGate';
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Layout } from "./components/layout/Layout";
import { useAuth } from "./store/AuthContext";
import { useFeatures } from "./store/FeaturesContext";
import { featureAllowsPath } from "./lib/features";
import { canAccess, homePath, type Role } from "./lib/roles";
import { EmptyState } from "./components/ui";
import { Lock } from "lucide-react";
const Dashboard = lazy(()=>import('./pages/Dashboard'));
const People = lazy(()=>import('./pages/People'));
const SalespersonDetail = lazy(()=>import('./pages/SalespersonDetail'));
const Plans = lazy(()=>import('./pages/Plans'));
const PlanBuilder = lazy(()=>import('./pages/PlanBuilder'));
const PlanProjection = lazy(()=>import('./pages/PlanProjection'));
const Clients = lazy(()=>import('./pages/Clients'));
const ClientDetail = lazy(()=>import('./pages/ClientDetail'));
const Payments = lazy(()=>import('./pages/Payments'));
const Ledger = lazy(()=>import('./pages/Ledger'));
const Payouts = lazy(()=>import('./pages/Payouts'));
const Reports = lazy(()=>import('./pages/Reports'));
const Goals = lazy(()=>import('./pages/Goals'));
const SalespersonPortal = lazy(()=>import('./pages/SalespersonPortal'));
const AffiliatePortal = lazy(()=>import('./pages/AffiliatePortal'));
const Agency = lazy(()=>import('./pages/Agency'));
const Documents = lazy(()=>import('./pages/Documents'));
const Presentation = lazy(()=>import('./pages/Presentation'));
const Settings = lazy(()=>import('./pages/Settings'));
const KleegrIntegration = lazy(()=>import('./pages/KleegrIntegration'));

/** Route guard: redirect to the role's home if it may not see this path, or
 *  show a "feature turned off" notice if the tenant has the feature disabled.
 *  We render an inline notice (instead of redirecting) for feature blocks so a
 *  role whose home route is itself gated can never enter a redirect loop. */
function Guard({ children }: { children: JSX.Element }) {
  const { user } = useAuth();
  const { features } = useFeatures();
  const { pathname } = useLocation();
  const role = (user?.role ?? "salesperson") as Role;
  if (!canAccess(role, pathname)) {
    return <Navigate to={homePath(role)} replace />;
  }
  if (!featureAllowsPath(pathname, role, features)) {
    return (
      <EmptyState
        icon={<Lock className="h-6 w-6" />}
        title="This area is turned off"
        description="This feature is disabled for your workspace. An owner or admin can re-enable it under Settings → Feature access."
      />
    );
  }
  return children;
}

/** The /portal route shows the affiliate/partner portal or the salesperson portal. */
function Portal() {
  const { user } = useAuth();
  const role = (user?.role ?? "salesperson") as Role;
  if (role === "affiliate" || role === "partner") return <AffiliatePortal />;
  return <SalespersonPortal />;
}

export default function App() {
  const { user } = useAuth();
  const role = (user?.role ?? "salesperson") as Role;

  return (
    <TrackerProvider><PreferencesProvider><Layout><Suspense fallback={<p className="st-loading" role="status">Loading page…</p>}>
      <Routes>
        <Route path="/operations" element={<Guard><Operations /></Guard>} />
        <Route path="/" element={<Guard><TrackerGate resource="dashboard"><Dashboard /></TrackerGate></Guard>} />
        <Route path="/agency" element={<Guard><TrackerGate resource="agency"><Agency /></TrackerGate></Guard>} />
        <Route path="/people" element={<Guard><TrackerGate resource="people"><People /></TrackerGate></Guard>} />
        <Route path="/people/:id" element={<Guard><TrackerGate resource="people"><SalespersonDetail /></TrackerGate></Guard>} />
        <Route path="/plans" element={<Guard><TrackerGate resource="plans"><Plans /></TrackerGate></Guard>} />
        <Route path="/plans/new" element={<Guard><TrackerGate resource="plans"><PlanBuilder /></TrackerGate></Guard>} />
        <Route path="/plans/:id/edit" element={<Guard><TrackerGate resource="plans"><PlanBuilder /></TrackerGate></Guard>} />
        <Route path="/plans/:id/projection" element={<Guard><TrackerGate resource="plans"><PlanProjection /></TrackerGate></Guard>} />
        <Route path="/clients" element={<Guard><TrackerGate resource="leads"><Clients /></TrackerGate></Guard>} />
        <Route path="/clients/:id" element={<Guard><TrackerGate resource="leads"><ClientDetail /></TrackerGate></Guard>} />
        <Route path="/payments" element={<Guard><TrackerGate resource="payments"><Payments /></TrackerGate></Guard>} />
        <Route path="/ledger" element={<Guard><TrackerGate resource="ledger"><Ledger /></TrackerGate></Guard>} />
        <Route path="/payouts" element={<Guard><TrackerGate resource="payouts"><Payouts /></TrackerGate></Guard>} />
        <Route path="/reports" element={<Guard><TrackerGate resource="reports"><Reports /></TrackerGate></Guard>} />
        <Route path="/goals" element={<Guard><TrackerGate resource="goals"><Goals /></TrackerGate></Guard>} />
        <Route path="/documents" element={<Guard><Documents /></Guard>} />
        <Route path="/portal" element={<Guard><TrackerGate resource="portal"><Portal /></TrackerGate></Guard>} />
        <Route path="/present" element={<Guard><TrackerGate resource="plans"><Presentation /></TrackerGate></Guard>} />
        <Route path="/settings" element={<Guard><Settings /></Guard>} />
        <Route path="/settings/integrations/kleegr" element={<Guard><KleegrIntegration /></Guard>} />
        <Route path="/workspace-overview" element={<Guard><TrackerGate resource="dashboard"><Dashboard /></TrackerGate></Guard>} />
        <Route path="/campaigns" element={<Guard><TrackerGate resource="campaigns" /></Guard>} />
<Route path="/opportunities" element={<Guard><TrackerGate resource="opportunities" /></Guard>} />
<Route path="/media" element={<Guard><TrackerGate resource="media" /></Guard>} />
<Route path="/tracker-settings" element={<Guard><TrackerGate resource="settings" /></Guard>} />
<Route path="/sync-review" element={<Guard><TrackerGate resource="integrations" /></Guard>} />
        <Route path="*" element={<Navigate to={homePath(role)} replace />} />
      </Routes>
    </Suspense></Layout></PreferencesProvider></TrackerProvider>
  );
}
