// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { useEffect, useState } from "react";
import { SwampProvider, useSwamp } from "./client/SwampProvider";
import { useHealthStream } from "./client/useHealthStream";
import { useRequest } from "./client/useRequest";
import { extractArray } from "./client/extract";
import { Sidebar, type View } from "./components/Sidebar";
import { Login } from "./views/Login";
import { Overview } from "./views/Overview";
import { Workflows } from "./views/Workflows";
import { WorkflowDetail } from "./views/WorkflowDetail";
import { Executions } from "./views/Executions";
import { Models } from "./views/Models";
import { ModelDetail } from "./views/ModelDetail";
import { System } from "./views/System";
import { Schedules } from "./views/Schedules";
import { Webhooks } from "./views/Webhooks";
import { Approvals } from "./views/Approvals";
import { Data } from "./views/Data";
import { Vaults } from "./views/Vaults";
import { Extensions } from "./views/Extensions";
import { RunDetail } from "./views/RunDetail";

export function App() {
  return (
    <SwampProvider>
      <AppShell />
    </SwampProvider>
  );
}

function AppShell() {
  const { connected, token, authMode, logout } = useSwamp();

  if (authMode === null) {
    return <div className="loading">Connecting...</div>;
  }

  if (authMode !== "none" && !token) {
    return <Login />;
  }

  if (!connected) {
    return <div className="loading">Connecting to swamp serve...</div>;
  }

  return <Dashboard onLogout={logout} />;
}

type DetailView =
  | { kind: "run"; workflowName: string; runId?: string }
  | { kind: "workflow"; workflowName: string }
  | { kind: "model"; modelName: string }
  | null;

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [view, setView] = useState<View>("overview");
  const [detail, setDetail] = useState<DetailView>(null);
  const health = useHealthStream();

  const { data: approvalsData } = useRequest("workflow.approvals");
  const approvals = extractArray<{ steps?: unknown[] }>(approvalsData);
  const approvalCount = approvals.reduce(
    (n, a) => n + (Array.isArray(a.steps) ? a.steps.length : 0),
    0,
  );

  const openRun = (workflowName: string, runId?: string) => {
    setDetail({ kind: "run", workflowName, runId });
  };

  const openWorkflow = (workflowName: string) => {
    setDetail({ kind: "workflow", workflowName });
  };

  const openModel = (modelName: string) => {
    setDetail({ kind: "model", modelName });
  };

  const closeDetail = () => setDetail(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && detail) {
        e.preventDefault();
        closeDetail();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [detail]);

  const navigate = (v: View) => {
    setDetail(null);
    setView(v);
  };

  return (
    <div className="app">
      <Sidebar
        activeView={view}
        onNavigate={navigate}
        health={health}
        approvalCount={approvalCount}
        onLogout={onLogout}
      />
      <main className="main">
        {detail?.kind === "run"
          ? (
            <RunDetail
              workflowName={detail.workflowName}
              runId={detail.runId}
              onBack={closeDetail}
            />
          )
          : detail?.kind === "workflow"
          ? (
            <WorkflowDetail
              workflowName={detail.workflowName}
              onBack={closeDetail}
              onOpenRun={openRun}
            />
          )
          : detail?.kind === "model"
          ? (
            <ModelDetail
              modelName={detail.modelName}
              onBack={closeDetail}
            />
          )
          : (
            <>
              {view === "overview" && (
                <Overview health={health} onOpenRun={openRun} />
              )}
              {view === "workflows" && (
                <Workflows onOpenWorkflow={openWorkflow} />
              )}
              {view === "executions" && <Executions onOpenRun={openRun} />}
              {view === "models" && <Models onOpenModel={openModel} />}
              {view === "schedules" && <Schedules health={health} />}
              {view === "webhooks" && <Webhooks health={health} />}
              {view === "approvals" && <Approvals />}
              {view === "data" && <Data />}
              {view === "vaults" && <Vaults />}
              {view === "extensions" && <Extensions />}
              {view === "system" && <System health={health} />}
            </>
          )}
      </main>
    </div>
  );
}
