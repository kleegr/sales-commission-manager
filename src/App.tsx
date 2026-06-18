import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Layout } from "./components/layout/Layout";
import { useAuth } from "./store/AuthContext";
import { canAccess, homePath, type Role } from "./lib/roles";
import Dashboard from "./pages/Dashboard";
import People from "./pages/People";
import SalespersonDetail from "./pages/SalespersonDetail";
import Plans from "./pages/Plans";
import PlanBuilder from "./pages/PlanBuilder";
import PlanProjection from "./pages/PlanProjection";
import Clients from "./pages/Clients";
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

/** Route guard: redirect to the role's home if it may not see this path. */
function Guard({ children }: { children: JSX.Element }) {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const role = (user?.role ?? "salesperson") as Role;
  if (!canAccess(role, pathname)) {
    return <Navigate to={homePath(role)} replace />;
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
    <Layout>
      <Routes>
        <Route path="/" element={<Guard><Dashboard /></Guard>} />
        <Route path="/agency" element={<Guard><Agency /></Guard>} />
        <Route path="/people" element={<Guard><People /></Guard>} />
        <Route path="/people/:id" element={<Guard><SalespersonDetail /></Guard>} />
        <Route path="/plans" element={<Guard><Plans /></Guard>} />
        <Route path="/plans/new" element={<Guard><PlanBuilder /></Guard>} />
        <Route path="/plans/:id/edit" element={<Guard><PlanBuilder /></Guard>} />
        <Route path="/plans/:id/projection" element={<Guard><PlanProjection /></Guard>} />
        <Route path="/clients" element={<Guard><Clients /></Guard>} />
        <Route path="/payments" element={<Guard><Payments /></Guard>} />
        <Route path="/ledger" element={<Guard><Ledger /></Guard>} />
        <Route path="/payouts" element={<Guard><Payouts /></Guard>} />
        <Route path="/reports" element={<Guard><Reports /></Guard>} />
        <Route path="/goals" element={<Guard><Goals /></Guard>} />
        <Route path="/documents" element={<Guard><Documents /></Guard>} />
        <Route path="/portal" element={<Guard><Portal /></Guard>} />
        <Route path="/present" element={<Guard><Presentation /></Guard>} />
        <Route path="/settings" element={<Guard><Settings /></Guard>} />
        <Route path="*" element={<Navigate to={homePath(role)} replace />} />
      </Routes>
    </Layout>
  );
}
