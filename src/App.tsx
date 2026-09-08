import {TrackerProvider,TrackerGate} from './components/TrackerGate';
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Layout } from "./components/layout/Layout";
import { useAuth } from "./store/AuthContext";
import { useFeatures } from "./store/FeaturesContext";
import { featureAllowsPath } from "./lib/features";
import { canAccess, homePath, type Role } from "./lib/roles";
import { EmptyState } from "./components/ui";
import { Lock } from "lucide-react";
import Dashboard from "./pages/Dashboard";
import People from "./pages/People";
import SalespersonDetail from "./pages/SalespersonDetail";
import Plans from "./pages/Plans";
import PlanBuilder from "./pages/PlanBuilder";
import PlanProjection from "./pages/PlanProjection";
import Clients from "./pages/Clients";
import ClientDetail from "./pages/ClientDetail";
import Payments from "./pages/Payments";
import Ledger from "./pages/Ledger";
import Payouts from "./pages/Payouts";
import Reports from "./pages/Reports";
import Goals from "./pages/Goals";
import SalespersonPortal from "./pages/SalespersonPortal";
import AffiliatePortal from "./pages/AffiliatePortal";
import Agency from "./pages/Agency";
import Documents from "./pages/Documents";
import Presentation from "./pages/Presentation";
import Settings from "./pages/Settings";
import KleegrIntegration from "./pages/KleegrIntegration";

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
    <TrackerProvider><Layout>
      <Routes>
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
    </Layout></TrackerProvider>
  );
}
