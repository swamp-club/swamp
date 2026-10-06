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

import { useCallback, useEffect, useRef, useState } from "react";
import { SwampProvider, useSwamp } from "./client/SwampProvider";
import { useAuditStream } from "./client/useAuditStream";
import { useHealthStream } from "./client/useHealthStream";
import { useRequest } from "./client/useRequest";
import { extractArray } from "./client/extract";
import { Logo } from "./components/Logo";
import { Sidebar, SIDEBAR_ID, type View } from "./components/Sidebar";
import {
  MOBILE_MEDIA_QUERY,
  parseCollapsed,
  resolveEscape,
  SIDEBAR_COLLAPSED_KEY,
} from "./components/sidebar_state.ts";
import { useRouter } from "./hooks/useRouter";
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
import { Activity } from "./views/Activity";
import { RunDetail } from "./views/RunDetail";
import { DataDetail } from "./views/DataDetail";
import { buildPath } from "./routes.ts";

export function App() {
  return (
    <SwampProvider>
      <AppShell />
    </SwampProvider>
  );
}

function AppShell() {
  const { connected, token, authMode, sessionReady, logout } = useSwamp();

  if (authMode === null || !sessionReady) {
    return <div className="loading">Connecting...</div>;
  }

  if (authMode !== "none" && token === null) {
    return <Login />;
  }

  if (!connected) {
    return <div className="loading">Connecting to swamp serve...</div>;
  }

  return <Dashboard onLogout={logout} />;
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const {
    view,
    detail,
    navigate,
    openModel,
    openWorkflow,
    openRun,
    closeDetail,
    goUp,
  } = useRouter();
  const { health, denied: healthDenied } = useHealthStream();
  const auditStream = useAuditStream();

  const { data: approvalsData, refetch: refetchApprovals } = useRequest(
    "workflow.approvals",
  );
  const approvalCount = extractArray(approvalsData).length;

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const toggleCollapsed = useCallback(() => {
    const next = !collapsed;
    writeCollapsed(next);
    setCollapsed(next);
  }, [collapsed]);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // Return focus to the menu button when the drawer closes, but only while
  // the mobile layout is showing it.
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const wasDrawerOpen = useRef(false);
  useEffect(() => {
    if (
      wasDrawerOpen.current && !drawerOpen &&
      globalThis.matchMedia(MOBILE_MEDIA_QUERY).matches
    ) {
      menuButtonRef.current?.focus();
    }
    wasDrawerOpen.current = drawerOpen;
  }, [drawerOpen]);

  const navigateAndClose = useCallback((next: View) => {
    setDrawerOpen(false);
    navigate(next);
  }, [navigate]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const isMobile = globalThis.matchMedia(MOBILE_MEDIA_QUERY).matches;
      const action = resolveEscape(drawerOpen && isMobile, detail !== null);
      if (action === "close-drawer") {
        e.preventDefault();
        setDrawerOpen(false);
      } else if (action === "leave-detail") {
        e.preventDefault();
        // Deep-linked items step up to their model or run; other details
        // close to their list view as before.
        goUp();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [drawerOpen, detail, goUp]);

  const appClass = `app${drawerOpen ? " drawer-open" : ""}${
    collapsed ? " sidebar-collapsed" : ""
  }`;

  return (
    <div className={appClass}>
      <Sidebar
        activeView={view}
        onNavigate={navigateAndClose}
        health={health}
        approvalCount={approvalCount}
        onLogout={onLogout}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        drawerOpen={drawerOpen}
        onCloseDrawer={closeDrawer}
      />
      <div className="sidebar-backdrop" onClick={closeDrawer} />
      <main className="main">
        <div className="mobile-topbar">
          <button
            type="button"
            ref={menuButtonRef}
            className="mobile-menu-button"
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            aria-controls={SIDEBAR_ID}
            onClick={() => setDrawerOpen(true)}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              <path d="M3 5h14M3 10h14M3 15h14" />
            </svg>
          </button>
          <Logo size="sm" />
        </div>
        {detail?.kind === "data" || detail?.kind === "report" ||
            detail?.kind === "runReport"
          ? (
            <DataDetail
              key={buildPath({ view, detail })}
              detail={detail}
              onBack={goUp}
            />
          )
          : detail?.kind === "run"
          ? (
            <RunDetail
              workflowName={detail.workflowName}
              runId={detail.runId}
              health={health}
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
                <Overview
                  health={health}
                  healthDenied={healthDenied}
                  onOpenRun={openRun}
                  onApprovalsChanged={refetchApprovals}
                />
              )}
              {view === "workflows" && (
                <Workflows onOpenWorkflow={openWorkflow} />
              )}
              {view === "executions" && <Executions onOpenRun={openRun} />}
              {view === "models" && <Models onOpenModel={openModel} />}
              {view === "schedules" && (
                <Schedules health={health} denied={healthDenied} />
              )}
              {view === "webhooks" && (
                <Webhooks health={health} denied={healthDenied} />
              )}
              {view === "approvals" && (
                <Approvals
                  health={health}
                  onApprovalsChanged={refetchApprovals}
                />
              )}
              {view === "activity" && <Activity auditStream={auditStream} />}
              {view === "data" && <Data />}
              {view === "vaults" && <Vaults />}
              {view === "extensions" && <Extensions />}
              {view === "system" && (
                <System health={health} denied={healthDenied} />
              )}
            </>
          )}
      </main>
    </div>
  );
}

function readCollapsed(): boolean {
  try {
    return parseCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY));
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(value));
  } catch {
    // Storage blocked: the preference lasts for this page load only.
  }
}
