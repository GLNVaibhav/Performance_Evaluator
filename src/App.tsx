import { Routes, Route, Navigate } from "react-router-dom";
import Landing from "@/pages/Landing";
import Auth from "@/pages/Auth";
import { RequireAuth } from "@/components/RequireAuth";
import DashboardLayout from "@/components/DashboardLayout";
import Dashboard from "@/pages/Dashboard";
import RunDetail from "@/pages/RunDetail";
import NewRun from "@/pages/NewRun";
import Compare from "@/pages/Compare";
import BoundarySearch from "@/pages/BoundarySearch";
import Regression from "@/pages/Regression";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/auth" element={<Auth />} />
      <Route
        path="/app"
        element={
          <RequireAuth>
            <DashboardLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="runs/:runId" element={<RunDetail />} />
        <Route path="new" element={<NewRun />} />
        <Route path="compare" element={<Compare />} />
        <Route path="boundary" element={<BoundarySearch />} />
        <Route path="regression" element={<Regression />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
