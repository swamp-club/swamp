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

import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { SwampProvider, useSwamp } from "./client/SwampProvider.tsx";
import { useAuditStream } from "./client/useAuditStream.ts";
import { auditEnabled } from "./client/audit_state.ts";
import { useHealthStream } from "./client/useHealthStream.ts";
import { useApprovals } from "./client/useApprovals.ts";
import { pendingApprovals } from "./client/approvals.ts";
import { Logo } from "./components/Logo.tsx";
import { localToken, PAGE_WORKSPACE } from "./client/workspace_path.ts";
import {
  AppShellSkeleton,
  connectingLabel,
} from "./components/AppShellSkeleton.tsx";
import { Sidebar, SIDEBAR_ID, type View } from "./components/Sidebar.tsx";
import {
  MOBILE_MEDIA_QUERY,
  parseCollapsed,
  resolveEscape,
  SIDEBAR_COLLAPSED_KEY,
} from "./components/sidebar_state.ts";
import { useRouter } from "./hooks/useRouter.ts";
import { TimeRangeProvider } from "./client/time_range.ts";
import {
  RunActivityProvider,
  useDocumentVisible,
} from "./client/run_activity.ts";
import { TimeRangePicker } from "./components/TimeRangePicker.tsx";
import { Login } from "./views/Login.tsx";
import { Overview } from "./views/Overview.tsx";
import { Workflows } from "./views/Workflows.tsx";
import { WorkflowDetail } from "./views/WorkflowDetail.tsx";
import { Executions } from "./views/Executions.tsx";
import { Models } from "./views/Models.tsx";
import { ModelDetail } from "./views/ModelDetail.tsx";
import { System } from "./views/System.tsx";
import { Workers } from "./views/Workers.tsx";
import { Schedules } from "./views/Schedules.tsx";
import { Webhooks } from "./views/Webhooks.tsx";
import { Approvals } from "./views/Approvals.tsx";
import { Data } from "./views/Data.tsx";
import { Vaults } from "./views/Vaults.tsx";
import { Extensions } from "./views/Extensions.tsx";
import { Activity } from "./views/Activity.tsx";
import { RunDetail } from "./views/RunDetail.tsx";
import { DataDetail } from "./views/DataDetail.tsx";
import { ScheduleDetail } from "./views/ScheduleDetail.tsx";
import { WebhookDetail } from "./views/WebhookDetail.tsx";
import {
  SchedulesLocalState,
  WebhooksLocalState,
} from "./views/ServeOnlyStates.tsx";
import type { CopyFn } from "./views/AuditStates.tsx";
import { copyText } from "./components/clipboard.ts";
import { buildPath, isStartPath } from "./routes.ts";
import "./styles/shell.css";

// Views whose content is runs over time, which the dashboard-wide time
// range scopes; the shell shows the picker above them.
const TIMED_VIEWS: ReadonlySet<View> = new Set<View>([
  "overview",
  "workflows",
  "executions",
  "schedules",
  "webhooks",
  "approvals",
  "models",
]);
// Details whose content follows the time range. A run page doesn't: it is
// one run, and its recent-runs strip deliberately ignores the range.
const TIMED_DETAILS = new Set(["workflow", "model", "schedule", "webhook"]);

// Only `swamp start` serves the start page, so it loads as its own chunk.
const Start = lazy(() =>
  import("./views/start/Start.tsx").then((m) => ({ default: m.Start }))
);

export function App() {
  // The `swamp start` page talks only to its own loopback server, so it
  // must never mount the serve provider, its auth probe or its socket.
  if (isStartPath(location.pathname)) {
    return (
      <Suspense fallback={<div className="loading">Loading...</div>}>
        <Start />
      </Suspense>
    );
  }
  // A workspace page needs the token `swamp start` or `swamp dashboard`
  // handed it; without one every request would be refused.
  if (PAGE_WORKSPACE !== null && localToken() === null) {
    return <LocalTokenMissing />;
  }
  return (
    <SwampProvider>
      <AppShell />
    </SwampProvider>
  );
}

/** A local dashboard page opened without its token (a pasted link, say). */
function LocalTokenMissing() {
  return (
    <div className="login-container">
      <div className="login-card" role="status">
        <p>
          This dashboard is only available from <code>swamp start</code> or{" "}
          <code>swamp dashboard</code>. Open it from the link they print.
        </p>
      </div>
    </div>
  );
}

function AppShell() {
  const {
    connected,
    connectionGeneration,
    token,
    authMode,
    sessionReady,
    logout,
    local,
  } = useSwamp();

  if (authMode === null || !sessionReady) {
    return <AppShellSkeleton label="Connecting" />;
  }

  if (authMode !== "none" && token === null) {
    return <Login />;
  }

  if (!connected) {
    return <AppShellSkeleton label={connectingLabel(local)} />;
  }

  return (
    <TimeRangeProvider>
      <Dashboard key={connectionGeneration} onLogout={logout} />
    </TimeRangeProvider>
  );
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const { local } = useSwamp();
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
  // A hidden tab closes the stream: no snapshots, no re-renders.
  const { health, denied: healthDenied } = useHealthStream(
    useDocumentVisible(),
  );
  const auditStream = useAuditStream();

  const approvals = useApprovals();
  // Only gates that can still be decided: expired ones are not pending.
  const approvalCount = pendingApprovals(approvals.data).length;

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

  const showTimeRange = detail
    ? TIMED_DETAILS.has(detail.kind)
    : TIMED_VIEWS.has(view);

  const appClass = `app${drawerOpen ? " drawer-open" : ""}${
    collapsed ? " sidebar-collapsed" : ""
  }`;

  const shell = (
    <div className={appClass}>
      <Sidebar
        activeView={view}
        onNavigate={navigateAndClose}
        health={health}
        approvalCount={approvalCount}
        auditEnabled={auditEnabled(auditStream.status)}
        local={local}
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
        {showTimeRange && (
          <div className="shell-topbar">
            <TimeRangePicker />
          </div>
        )}
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
          : local && (detail?.kind === "schedule" || view === "schedules")
          ? <LocalOffPage title="Schedules" state={SchedulesLocalState} />
          : local && (detail?.kind === "webhook" || view === "webhooks")
          ? <LocalOffPage title="Webhooks" state={WebhooksLocalState} />
          : detail?.kind === "schedule"
          ? (
            <ScheduleDetail
              key={detail.workflowName}
              workflowName={detail.workflowName}
              health={health}
              denied={healthDenied}
              onBack={closeDetail}
            />
          )
          : detail?.kind === "webhook"
          ? (
            <WebhookDetail
              key={detail.route}
              route={detail.route}
              health={health}
              denied={healthDenied}
              onBack={closeDetail}
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
                  approvalsRequest={approvals}
                />
              )}
              {view === "workflows" && (
                <Workflows health={health} onOpenWorkflow={openWorkflow} />
              )}
              {view === "executions" && (
                <Executions health={health} onOpenRun={openRun} />
              )}
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
                  approvalsRequest={approvals}
                />
              )}
              {view === "activity" && <Activity auditStream={auditStream} />}
              {view === "data" && <Data />}
              {view === "vaults" && <Vaults />}
              {view === "extensions" && <Extensions />}
              {view === "workers" && <Workers health={health} />}
              {view === "system" && (
                <System health={health} denied={healthDenied} />
              )}
            </>
          )}
      </main>
    </div>
  );
  // Run summaries in every view re-read on run activity and on coming back
  // into view, not on a clock (swamp-club#3444).
  return (
    <RunActivityProvider activeRuns={health?.activeRuns}>
      {shell}
    </RunActivityProvider>
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

/**
 * A page the local dashboard can't serve (no `swamp serve` behind it): its
 * title and what turning it on would give, like Activity's audit-off page.
 */
function LocalOffPage(
  { title, state: State }: {
    title: string;
    state: (props: { copy: CopyFn }) => ReactNode;
  },
) {
  return (
    <>
      <div className="page-header">
        <h1>{title}</h1>
      </div>
      <State copy={copyText} />
    </>
  );
}
