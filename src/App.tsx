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
import SalespersonPortal from "./pages/SalespersonPortal";
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

export default function App() {
  const { user } = useAuth();
  const role = (user?.role ?? "salesperson") as Role;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Guard><Dashboard /></Guard>} />
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
        <Route path="/portal" element={<Guard><SalespersonPortal /></Guard>} />
        <Route path="/present" element={<Guard><Presentation /></Guard>} />
        <Route path="/settings" element={<Guard><Settings /></Guard>} />
        <Route path="*" element={<Navigate to={homePath(role)} replace />} />
      </Routes>
    </Layout>
  );
}
