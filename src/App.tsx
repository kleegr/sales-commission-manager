import { Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/layout/Layout";
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
import SalespersonPortal from "./pages/SalespersonPortal";
import AffiliateSignup from "./pages/AffiliateSignup";
import Presentation from "./pages/Presentation";
import Settings from "./pages/Settings";

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/people" element={<People />} />
        <Route path="/people/:id" element={<SalespersonDetail />} />
        <Route path="/plans" element={<Plans />} />
        <Route path="/plans/new" element={<PlanBuilder />} />
        <Route path="/plans/:id/edit" element={<PlanBuilder />} />
        <Route path="/plans/:id/projection" element={<PlanProjection />} />
        <Route path="/clients" element={<Clients />} />
        <Route path="/payments" element={<Payments />} />
        <Route path="/ledger" element={<Ledger />} />
        <Route path="/payouts" element={<Payouts />} />
        <Route path="/portal" element={<SalespersonPortal />} />
        <Route path="/signup" element={<AffiliateSignup />} />
        <Route path="/present" element={<Presentation />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
