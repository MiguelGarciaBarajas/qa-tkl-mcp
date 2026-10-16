import { HashRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import { ConnectorHealthPage } from "./pages/ConnectorHealthPage";
import { StoryTraceabilityPage } from "./pages/StoryTraceabilityPage";
import { CoverageGapsPage } from "./pages/CoverageGapsPage";
import { KnowledgeInventoryPage } from "./pages/KnowledgeInventoryPage";
import { ConflictsPage } from "./pages/ConflictsPage";
import { EvaluationPage } from "./pages/EvaluationPage";
import { SourceConnectionsPage } from "./pages/SourceConnectionsPage";
import { AgentWorkbenchPage } from "./pages/AgentWorkbenchPage";
import { AskTklPage } from "./pages/AskTklPage";
import { UnifiedIntelligencePage } from "./pages/UnifiedIntelligencePage";
import { SectionTabs } from "./components/SectionTabs";

function LegacyRedirect({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate replace to={`${to}${search}`} />;
}

export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate replace to="/investigate" />} />
          <Route
            path="investigate"
            element={<SectionTabs label="Investigation views" tabs={[
              { to: "/investigate", label: "Search", end: true },
              { to: "/investigate/ask", label: "Ask TKL" },
            ]} />}
          >
            <Route index element={<UnifiedIntelligencePage />} />
            <Route path="ask" element={<AskTklPage />} />
          </Route>
          <Route
            path="insights"
            element={<SectionTabs label="Quality insight views" tabs={[
              { to: "/insights/coverage", label: "Coverage" },
              { to: "/insights/traceability", label: "Traceability" },
            ]} />}
          >
            <Route index element={<Navigate replace to="coverage" />} />
            <Route path="coverage" element={<CoverageGapsPage />} />
            <Route path="traceability" element={<StoryTraceabilityPage />} />
          </Route>
          <Route
            path="reviews"
            element={<SectionTabs label="Review queue views" tabs={[
              { to: "/reviews/proposals", label: "Proposals" },
              { to: "/reviews/conflicts", label: "Conflicts" },
            ]} />}
          >
            <Route index element={<Navigate replace to="proposals" />} />
            <Route path="proposals" element={<AgentWorkbenchPage />} />
            <Route path="conflicts" element={<ConflictsPage />} />
          </Route>
          <Route
            path="sources"
            element={<SectionTabs label="Source administration views" tabs={[
              { to: "/sources/connections", label: "Connections" },
              { to: "/sources/health", label: "Health" },
            ]} />}
          >
            <Route index element={<Navigate replace to="connections" />} />
            <Route path="connections" element={<SourceConnectionsPage />} />
            <Route path="health" element={<ConnectorHealthPage />} />
          </Route>
          <Route
            path="knowledge"
            element={<SectionTabs label="Knowledge health views" tabs={[
              { to: "/knowledge/inventory", label: "Inventory" },
              { to: "/knowledge/evaluation", label: "Evaluation" },
            ]} />}
          >
            <Route index element={<Navigate replace to="inventory" />} />
            <Route path="inventory" element={<KnowledgeInventoryPage />} />
            <Route path="evaluation" element={<EvaluationPage />} />
          </Route>
          <Route path="intelligence" element={<LegacyRedirect to="/investigate" />} />
          <Route path="ask" element={<LegacyRedirect to="/investigate/ask" />} />
          <Route path="coverage-gaps" element={<LegacyRedirect to="/insights/coverage" />} />
          <Route path="traceability" element={<LegacyRedirect to="/insights/traceability" />} />
          <Route path="agents" element={<LegacyRedirect to="/reviews/proposals" />} />
          <Route path="conflicts" element={<LegacyRedirect to="/reviews/conflicts" />} />
          <Route path="source-connections" element={<LegacyRedirect to="/sources/connections" />} />
          <Route path="admin/health" element={<LegacyRedirect to="/sources/health" />} />
          <Route path="knowledge-inventory" element={<LegacyRedirect to="/knowledge/inventory" />} />
          <Route path="evaluation" element={<LegacyRedirect to="/knowledge/evaluation" />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
