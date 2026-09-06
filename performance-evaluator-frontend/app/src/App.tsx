import { HashRouter, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/layout/AppShell";
import { MissionControlPage } from "./pages/MissionControlPage";
import { RunHistoryPage } from "./pages/RunHistoryPage";
import { RunDetailPage } from "./pages/RunDetailPage";
import { ArchitecturePage } from "./pages/ArchitecturePage";

export default function App() {
  return (
    <HashRouter>
      <AppShell>
        <Routes>
          <Route path="/" element={<MissionControlPage />} />
          <Route path="/history" element={<RunHistoryPage />} />
          <Route path="/history/:runId" element={<RunDetailPage />} />
          <Route path="/architecture" element={<ArchitecturePage />} />
        </Routes>
      </AppShell>
    </HashRouter>
  );
}
