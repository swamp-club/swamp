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
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "../styles/run-detail.css";
import { useRequest } from "../client/useRequest";
import { useSwamp } from "../client/SwampProvider";
import { runUnreadableHint } from "./run_load_error.ts";
import { extractArray, extractObject } from "../client/extract";
import {
  activeRunIds,
  type ResumableRun,
  resumeStateFor,
} from "../client/resume_state";
import { useActiveRunsRefetch } from "../client/useActiveRunsRefetch";
import type { HealthSnapshot } from "../client/useHealthStream";
import {
  nullableParam,
  oneOf,
  useQueryState,
} from "../client/useQueryState.ts";
import { type RecentRun, useRunSummary } from "../client/run_summary.ts";
import { ResumeAction } from "../components/ResumeAction";
import { RouteLink } from "../components/RouteLink";
import { RunHistoryBar } from "../components/RunHistoryBar.tsx";
import { TriggerBadge } from "../components/TriggerBadge";
import { copyText } from "../components/clipboard.ts";
import {
  Skeleton,
  SkeletonList,
  SkeletonRegion,
  SkeletonRunHistory,
} from "../components/Skeleton.tsx";
import { RunGraph } from "../components/RunGraph.tsx";
import { RunStatusIcon, statusLabel } from "../components/RunStatusIcon.tsx";
import {
  ItemLink,
  type JobRun,
  RunJobList,
  RunJobPanel,
  type StepContext,
} from "../components/RunSteps.tsx";
import {
  buildRunGraph,
  type DisplayStatus,
  elapsed,
  failureTarget,
  firstFailure,
  stepProgress,
  type WorkflowDefinitionLike,
} from "../components/run_graph_model.ts";
import { navigateTo } from "../hooks/useRouter.ts";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";
import {
  formatAbsoluteTime,
  formatDuration,
  formatRelativeTime,
} from "../lib/format.ts";
import { isPlainLeftClick, type RouteState } from "../routes.ts";
import { type ArtifactRef, documentTitle, shortRunId } from "./data_target.ts";
import { workflowReportLinks } from "./artifact_links.ts";
import {
  type DrawerItem,
  ITEM_PARAM,
  parseItemParam,
  withItemParam,
} from "./run_item_param.ts";
import {
  failureHref,
  FOCUS_FAILURE,
  FOCUS_PARAM,
  STEP_PARAM,
} from "./run_links.ts";
import { RunItemDrawer } from "./RunItemDrawer.tsx";

interface LogsData {
  path?: string;
  lines?: string[];
  lineCount?: number;
}

interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  /** Nested runs this run's steps wait on (swamp-club#2736). */
  nestedWaits?: {
    workflowName: string;
    runId: string;
    stepName: string;
    status?: string;
  }[];
  /** On a nested workflow's run: the parent run that started it. */
  parentRun?: {
    workflowName: string;
    runId: string;
    stepName: string;
  };
  status: string;
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  initiatedBy?: string;
  jobs: JobRun[];
  workflowDataArtifacts?: ArtifactRef[];
}

/** A `workflow.run.search` row for this run. */
interface RunRow extends ResumableRun {
  triggerSource?: string;
}

interface RunDetailProps {
  workflowName: string;
  runId?: string;
  /** Serve's live health snapshot; its active runs are runs serve drives. */
  health?: HealthSnapshot | null;
  onBack: () => void;
}

/** How often a run still in progress is re-read. */
const LIVE_POLL_MS = 2500;
const LIVE_STATUSES = new Set(["running", "pending"]);

type Tab = "graph" | "list";
const TABS: readonly Tab[] = ["graph", "list"];
const parseTab = oneOf(TABS, "graph");
const parseOptional = (raw: string | null): string | null => raw || null;

/**
 * One workflow run: a summary header, the job graph (or the step list),
 * and the reports and logs it produced. Reports and data open in a drawer
 * on this page; the tab, selected job and open item live in the URL, and
 * `?focus=failure` opens the run straight on its failed step's log.
 */
export function RunDetail(props: RunDetailProps) {
  // A different run is a different page: reset selection and drawer state.
  return <RunPage key={props.runId ?? props.workflowName} {...props} />;
}

function RunPage({ workflowName, runId, health, onBack }: RunDetailProps) {
  const { local } = useSwamp();
  const historyReq = useRequest(
    "workflow.history.get",
    { workflowIdOrName: runId ?? workflowName },
  );
  const run = extractObject<WorkflowRun>(historyReq.data);
  const id = runId ?? run?.id;

  const definitionReq = useRequest("workflow.get", {
    workflowIdOrName: workflowName,
  });
  const definition = definitionReq.error
    ? null
    : extractObject<WorkflowDefinitionLike>(definitionReq.data);

  // Run search carries the trigger and the derived awaiting-resume state.
  const rowReq = useRequest(
    "workflow.run.search",
    { workflow: workflowName, query: id, limit: 1 },
    { enabled: id !== undefined },
  );
  const row = extractArray<RunRow>(rowReq.data).find((r) => r.runId === id);
  // Only a run with every gate decided gets the resume panel.
  const resumable = row && resumeStateFor(row) !== null ? row : undefined;
  // A run serve drives now is not offered a resume (swamp-club#3005).
  const served = id !== undefined && activeRunIds(health?.activeRuns).has(id);

  const logsReq = useRequest(
    "workflow.history.logs",
    { runIdOrWorkflow: runId ?? workflowName, tail: 200 },
  );
  const logs = extractLogs(logsReq.data);

  const refetchHistory = historyReq.refetch;
  const refetchRow = rowReq.refetch;
  const refetchLogs = logsReq.refetch;
  const refetchLive = useCallback(() => {
    refetchHistory();
    refetchLogs();
  }, [refetchHistory, refetchLogs]);
  const refetchRun = useCallback(() => {
    refetchLive();
    refetchRow();
  }, [refetchLive, refetchRow]);
  const rows = useMemo(
    () => (row ? [row] : run ? [{ runId: run.id, status: run.status }] : []),
    [row, run],
  );
  useActiveRunsRefetch(health?.activeRuns, rows, refetchRun);

  // Serve has no per-run event stream: re-read a run in progress. Only the
  // run and its logs change while it runs; the search row (trigger,
  // awaiting resume) is re-read when the run's status changes, when serve
  // starts or stops driving a run, and after a resume (swamp-club#3444).
  const live = run !== null && LIVE_STATUSES.has(run.status);
  usePolling(refetchLive, live ? LIVE_POLL_MS : null);
  const seenStatus = useRef(run?.status);
  useEffect(() => {
    if (seenStatus.current === run?.status) return;
    const first = seenStatus.current === undefined;
    seenStatus.current = run?.status;
    // The first answer is the row's own first fetch.
    if (!first) refetchRow();
  }, [run?.status, refetchRow]);
  const now = useNow(live ? 1000 : null);

  const graph = useMemo(
    () => (run ? buildRunGraph(run, definition) : null),
    [run, definition],
  );
  const taskTypes = useMemo(() => {
    const map = new Map<string, string>();
    for (const job of definition?.jobs ?? []) {
      for (const step of job.steps ?? []) {
        if (step.task?.type) map.set(step.name, step.task.type);
      }
    }
    return map;
  }, [definition]);

  // ── URL state: tab, selected job, open item, failure focus ────────────
  const [tab, setTab] = useQueryState<Tab>("tab", "graph", parseTab);
  const [selectedJob, setSelectedJob] = useQueryState<string | null>(
    "job",
    null,
    parseOptional,
    nullableParam,
  );
  const [focusParam, setFocusParam] = useQueryState<string | null>(
    FOCUS_PARAM,
    null,
    parseOptional,
    nullableParam,
  );
  const [stepParam, setStepParam] = useQueryState<string | null>(
    STEP_PARAM,
    null,
    parseOptional,
    nullableParam,
  );
  const [item, openItem, closeItem] = useDrawerItem();
  const selectedRun = run?.jobs.find((j) => j.name === selectedJob) ?? null;

  // A failure link asks for the failed step; it is resolved once the run
  // has loaded. The nonce re-scrolls when asked again on the same page.
  const [failureRequest, setFailureRequest] = useState<
    { step: string | null; nonce: number } | null
  >(() => focusParam === FOCUS_FAILURE ? { step: stepParam, nonce: 1 } : null);
  const [focusTarget, setFocusTarget] = useState<
    { job: string; step: string; nonce: number } | null
  >(null);

  useEffect(() => {
    if (!failureRequest || !run) return;
    const target = failureTarget(run, failureRequest.step);
    if (target) {
      setTab("graph");
      setSelectedJob(target.job);
      setFocusTarget({ ...target, nonce: failureRequest.nonce });
    }
    setFailureRequest(null);
    // The request is handled: drop `?focus=failure[&step=]` so closing an
    // unrelated drawer later (which fires `popstate` via `history.back()`)
    // doesn't read it off the URL and snap back here again.
    if (focusParam !== null) setFocusParam(null);
    if (stepParam !== null) setStepParam(null);
  }, [
    failureRequest,
    run,
    setTab,
    setSelectedJob,
    focusParam,
    stepParam,
    setFocusParam,
    setStepParam,
  ]);

  // A failure link followed while already on this run (see navigateToHref).
  useEffect(() => {
    const onPop = () => {
      const params = new URLSearchParams(location.search);
      if (params.get(FOCUS_PARAM) === FOCUS_FAILURE) {
        setFailureRequest({ step: params.get(STEP_PARAM), nonce: Date.now() });
      }
    };
    globalThis.addEventListener("popstate", onPop);
    return () => globalThis.removeEventListener("popstate", onPop);
  }, []);

  const viewFailure = useCallback(() => {
    setFocusParam(FOCUS_FAILURE);
    setStepParam(null);
    setFailureRequest({ step: null, nonce: Date.now() });
  }, [setFocusParam, setStepParam]);

  /** The reader picked a job: the failure focus no longer describes the page. */
  const selectJob = useCallback((job: string | null) => {
    setSelectedJob(job);
    if (focusParam !== null) setFocusParam(null);
    if (stepParam !== null) setStepParam(null);
  }, [setSelectedJob, focusParam, stepParam, setFocusParam, setStepParam]);

  // Escape closes the drawer, then the job panel, before leaving the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (item) closeItem();
      else if (selectedRun && tab === "graph") selectJob(null);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    globalThis.addEventListener("keydown", onKey, true);
    return () => globalThis.removeEventListener("keydown", onKey, true);
  }, [item, closeItem, selectedRun, tab, selectJob]);

  const shortId = id ? shortRunId(id) : null;
  useDocumentTitle(
    documentTitle(shortId ? `run ${shortId}` : "latest run", workflowName),
  );

  const ctx: StepContext = {
    runStatus: run?.status ?? "pending",
    now,
    onOpenItem: openItem,
    onNavigate: navigateTo,
    taskTypes,
    focusStep: focusTarget && selectedRun?.name === focusTarget.job
      ? focusTarget.step
      : null,
    focusNonce: focusTarget?.nonce,
  };
  const failureLink = run?.status === "failed" && id
    ? failureHref(workflowName, id)
    : null;

  return (
    <>
      <RunHeader
        workflowName={workflowName}
        run={run}
        runId={id}
        row={row}
        now={now}
        onBack={onBack}
        failureLink={failureLink}
        onViewFailure={viewFailure}
      />

      {!run && !historyReq.error && <RunSkeleton />}

      {!run && historyReq.error && (
        <div className="notice notice-danger rd-error" role="alert">
          <div>
            <strong>This run could not be loaded.</strong>
            <p>
              {historyReq.errorInfo?.reason === "not_found"
                ? "It may have been deleted, or the link is wrong."
                : runUnreadableHint(local)}
            </p>
            <code className="rd-error-detail">{historyReq.error}</code>
          </div>
          <div className="notice-links">
            <button
              type="button"
              className="btn-sm"
              onClick={historyReq.refetch}
            >
              Retry
            </button>
            <RouteLink
              to={{
                view: "workflows",
                detail: { kind: "workflow", workflowName },
              }}
            >
              Open {workflowName}
            </RouteLink>
          </div>
        </div>
      )}

      {run && graph && (
        <>
          <RunNotices
            run={run}
            resumable={resumable}
            served={served}
            onResumed={refetchRun}
            failureLink={failureLink}
            onViewFailure={viewFailure}
          />

          <section className="rd-section" aria-label="Jobs">
            <div className="rd-tabs">
              <div className="rd-tablist" role="tablist" aria-label="Jobs view">
                {TABS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    id={`rd-tab-${t}`}
                    aria-selected={tab === t}
                    aria-controls={`rd-tabpanel-${t}`}
                    tabIndex={tab === t ? 0 : -1}
                    className={`rd-tab${tab === t ? " active" : ""}`}
                    onClick={() => setTab(t)}
                    onKeyDown={(e) => {
                      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") {
                        return;
                      }
                      e.preventDefault();
                      const next = TABS[(TABS.indexOf(t) + 1) % TABS.length];
                      setTab(next);
                      document.getElementById(`rd-tab-${next}`)?.focus();
                    }}
                  >
                    {t === "graph" ? <GraphGlyph /> : <ListGlyph />}
                    {t === "graph" ? "Graph" : "List"}
                  </button>
                ))}
              </div>
              <span className="rd-tabs-meta">
                {graph.jobs.length} {graph.jobs.length === 1 ? "job" : "jobs"}
                {graph.edges.length > 0 &&
                  ` · ${graph.edges.length} ${
                    graph.edges.length === 1 ? "dependency" : "dependencies"
                  }`}
                {live && <span className="rd-live">Live</span>}
              </span>
            </div>

            {tab === "graph"
              ? (
                <div
                  id="rd-tabpanel-graph"
                  role="tabpanel"
                  aria-labelledby="rd-tab-graph"
                  className={`rd-graph-layout${
                    selectedRun ? " has-panel" : ""
                  }`}
                >
                  <div className="panel rd-graph-panel">
                    <RunGraph
                      graph={graph}
                      selected={selectedRun ? selectedRun.name : null}
                      onSelect={selectJob}
                      now={now}
                      onNavigate={navigateTo}
                    />
                  </div>
                  {selectedRun && (
                    <div className="panel rd-job-panel">
                      <RunJobPanel
                        key={selectedRun.name}
                        job={selectedRun}
                        graph={graph}
                        ctx={ctx}
                        onClose={() => selectJob(null)}
                      />
                    </div>
                  )}
                </div>
              )
              : (
                <div
                  id="rd-tabpanel-list"
                  role="tabpanel"
                  aria-labelledby="rd-tab-list"
                >
                  <RunJobList jobs={run.jobs} ctx={ctx} graph={graph} />
                </div>
              )}
          </section>

          <WorkflowReports run={run} onOpenItem={openItem} />

          {logs?.lines && logs.lines.length > 0 && (
            <LogsPanel logs={logs} live={live} />
          )}
        </>
      )}

      {item && <RunItemDrawer item={item} onClose={closeItem} />}
    </>
  );
}

// ── header ──────────────────────────────────────────────────────────────

function runDisplayStatus(status: string): DisplayStatus {
  switch (status) {
    case "succeeded":
    case "failed":
    case "running":
    case "pending":
    case "cancelled":
      return status;
    case "suspended":
      return "waiting";
    case "interrupted":
      return "cancelled";
    default:
      return "unknown";
  }
}

const RUN_LABELS: Record<string, string> = {
  suspended: "Suspended",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
  pending: "Queued",
};

/**
 * "View failure log": opens the failed job's panel on its step log. A real
 * link, so it can be opened in a new tab or shared.
 */
function FailureLogLink(
  { href, onView, className }: {
    href: string;
    onView: () => void;
    className: string;
  },
) {
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        if (!isPlainLeftClick(e)) return;
        e.preventDefault();
        onView();
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <path
          d="M2.5 2.5h9v9h-9zM4.5 5h5M4.5 7h5M4.5 9h3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      View failure log
    </a>
  );
}

function RunHeader(
  { workflowName, run, runId, row, now, onBack, failureLink, onViewFailure }: {
    workflowName: string;
    run: WorkflowRun | null;
    runId?: string;
    row?: RunRow;
    now: number;
    onBack: () => void;
    failureLink: string | null;
    onViewFailure: () => void;
  },
) {
  const status = run ? runDisplayStatus(run.status) : null;
  const live = run !== null && LIVE_STATUSES.has(run.status);
  const duration = run ? elapsed(run, now, live) : undefined;
  const progress = run ? stepProgress(run) : null;

  return (
    <header className="rd-header">
      <nav className="breadcrumb rd-breadcrumb" aria-label="Breadcrumb">
        <RouteLink to={{ view: "workflows", detail: null }}>
          Workflows
        </RouteLink>
        <span aria-hidden="true">›</span>
        <RouteLink
          to={{ view: "workflows", detail: { kind: "workflow", workflowName } }}
        >
          {workflowName}
        </RouteLink>
        <span aria-hidden="true">›</span>
        <span aria-current="page">
          {runId ? `run ${shortRunId(runId)}` : "latest run"}
        </span>
      </nav>
      <div className="rd-title-row">
        <button type="button" className="back-button" onClick={onBack}>
          &larr; Back
        </button>
        <h1 className="rd-title">{workflowName}</h1>
        {run && status
          ? (
            <span className={`rd-status rd-status-${status}`}>
              <RunStatusIcon status={status} size={14} label="" />
              {RUN_LABELS[run.status] ?? statusLabel(status)}
            </span>
          )
          : <Skeleton width={92} height={24} radius={12} />}
        {failureLink && (
          <FailureLogLink
            href={failureLink}
            onView={onViewFailure}
            className="rd-failure-btn"
          />
        )}
      </div>

      <dl className="rd-facts">
        <Fact label="Trigger">
          {!run
            ? <Skeleton width={56} height={14} />
            : run.parentRun
            ? (
              <span className="rd-fact-inline">
                <TriggerBadge trigger="nested" />
                <RouteLink
                  to={{
                    view: "workflows",
                    detail: {
                      kind: "run",
                      workflowName: run.parentRun.workflowName,
                      runId: run.parentRun.runId,
                    },
                  }}
                  title={`Started by step ${run.parentRun.stepName}`}
                >
                  {run.parentRun.workflowName}
                </RouteLink>
              </span>
            )
            : row
            ? <TriggerBadge trigger={row.triggerSource} />
            : <Skeleton width={56} height={14} />}
        </Fact>
        <Fact label="Started">
          {run?.startedAt
            ? (
              <time
                dateTime={run.startedAt}
                title={formatAbsoluteTime(run.startedAt)}
              >
                {formatRelativeTime(run.startedAt, now)}
              </time>
            )
            : run
            ? "Not yet"
            : <Skeleton width={64} height={14} />}
        </Fact>
        <Fact label="Duration">
          {run
            ? (
              <span className="mono">
                {duration !== undefined ? formatDuration(duration) : "—"}
              </span>
            )
            : <Skeleton width={48} height={14} />}
        </Fact>
        <Fact label="Steps">
          {progress
            ? (
              <span className="rd-fact-inline">
                <span className="mono">
                  {progress.done}/{progress.total}
                </span>
                <span
                  className={`rd-progress rd-progress-${status}`}
                  role="progressbar"
                  aria-label="Steps finished"
                  aria-valuemin={0}
                  aria-valuemax={progress.total}
                  aria-valuenow={progress.done}
                >
                  <span
                    style={{
                      width: `${
                        progress.total === 0
                          ? 0
                          : (progress.done / progress.total) * 100
                      }%`,
                    }}
                  />
                </span>
              </span>
            )
            : <Skeleton width={72} height={14} />}
        </Fact>
        <Fact label="Run">
          {runId
            ? (
              <span className="rd-fact-inline">
                <code className="mono rd-run-id" title={runId}>
                  {shortRunId(runId)}
                </code>
                <CopyButton text={runId} label="Copy run ID" />
              </span>
            )
            : <Skeleton width={84} height={14} />}
        </Fact>
        {run?.initiatedBy && (
          <Fact label="By">
            <span className="rd-by" title={run.initiatedBy}>
              {run.initiatedBy}
            </span>
          </Fact>
        )}
      </dl>

      <RecentRuns
        workflowName={workflowName}
        currentRunId={runId}
        runStatus={run?.status}
      />
    </header>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rd-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "ok" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  const copy = () => {
    copyText(text)
      .then((ok) => {
        if (!mounted.current) return;
        setState(ok ? "ok" : "failed");
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), 1600);
      })
      .catch(() => {
        if (mounted.current) setState("failed");
      });
  };
  return (
    <button
      type="button"
      className={`rd-copy${state === "ok" ? " is-done" : ""}`}
      onClick={copy}
      aria-label={label}
      title={state === "ok"
        ? "Copied"
        : state === "failed"
        ? "Copy failed"
        : label}
    >
      {state === "ok"
        ? (
          <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M3 7.4l2.6 2.6L11 4.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )
        : (
          <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
            <rect
              x="4.5"
              y="4.5"
              width="7.5"
              height="7.5"
              rx="1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <path
              d="M9.5 4.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
            />
          </svg>
        )}
      <span className="visually-hidden" role="status">
        {state === "ok" ? "Copied" : state === "failed" ? "Copy failed" : ""}
      </span>
    </button>
  );
}

/**
 * The workflow's recent runs as a strip with this run highlighted, and
 * links to the runs either side. Uses the run summary; on a server without
 * it, falls back to the run search; hidden if both fail.
 */
function RecentRuns(
  { workflowName, currentRunId, runStatus }: {
    workflowName: string;
    currentRunId?: string;
    /** This run's status: the strip is re-read when it changes. */
    runStatus?: string;
  },
) {
  const summary = useRunSummary({
    workflows: [workflowName],
    recentLimit: 30,
    allTime: true,
  });
  const fallback = useRequest(
    "workflow.run.search",
    { workflow: workflowName, limit: 30 },
    { enabled: summary.error !== null },
  );
  const refetchSummary = summary.refetch;
  const refetchFallback = fallback.refetch;
  const seenStatus = useRef(runStatus);
  useEffect(() => {
    if (seenStatus.current === runStatus) return;
    seenStatus.current = runStatus;
    refetchSummary();
    refetchFallback();
  }, [runStatus, refetchSummary, refetchFallback]);
  const fromSummary = summary.summary?.workflows.find((w) =>
    w.workflowName === workflowName
  )?.recent;
  const runs: RecentRun[] | null = fromSummary ??
    (summary.summary
      ? []
      : fallback.data
      ? extractArray<RecentRun & { workflowName: string }>(fallback.data)
        .filter((r) => r.workflowName === workflowName)
      : null);
  if (summary.error !== null && fallback.error !== null) return null;
  if (runs === null) {
    return (
      <div className="rd-history" aria-hidden="true">
        <span className="rd-history-label">Recent runs</span>
        <span className="rd-history-bar">
          <SkeletonRunHistory slots={30} height={14} />
        </span>
      </div>
    );
  }
  if (runs.length === 0) return null;

  const index = currentRunId
    ? runs.findIndex((r) => r.runId === currentRunId)
    : -1;
  const older = index >= 0 ? runs[index + 1] : undefined;
  const newer = index > 0 ? runs[index - 1] : undefined;
  const link = (r: RecentRun): RouteState => ({
    view: "workflows",
    detail: { kind: "run", workflowName, runId: r.runId },
  });

  return (
    <div className="rd-history">
      <span className="rd-history-label">Recent runs</span>
      <span className="rd-history-bar">
        <RunHistoryBar
          runs={runs}
          workflowName={workflowName}
          slots={30}
          height={14}
          currentRunId={currentRunId}
        />
      </span>
      <span className="rd-history-nav">
        {older
          ? (
            <RouteLink
              to={link(older)}
              className="rd-hop"
              title="The run before this one"
            >
              ‹ Older
            </RouteLink>
          )
          : <span className="rd-hop is-disabled">‹ Older</span>}
        {newer
          ? (
            <RouteLink
              to={link(newer)}
              className="rd-hop"
              title="The run after this one"
            >
              Newer ›
            </RouteLink>
          )
          : <span className="rd-hop is-disabled">Newer ›</span>}
      </span>
    </div>
  );
}

// ── notices, reports, logs ──────────────────────────────────────────────

function RunNotices(
  { run, resumable, served, onResumed, failureLink, onViewFailure }: {
    run: WorkflowRun;
    resumable?: RunRow;
    served: boolean;
    onResumed: () => void;
    failureLink: string | null;
    onViewFailure: () => void;
  },
) {
  const failure = run.status === "failed" ? firstFailure(run) : null;
  return (
    <>
      {failure && (
        <div className="notice notice-danger rd-failure">
          <div className="rd-failure-text">
            <strong>
              Failed in <span className="mono">{failure.job}</span>
              <span aria-hidden="true">›</span>
              <span className="mono">{failure.step}</span>
            </strong>
            {failure.error && (
              <pre className="rd-failure-error">{failure.error}</pre>
            )}
          </div>
          {failureLink && (
            <FailureLogLink
              href={failureLink}
              onView={onViewFailure}
              className="btn-sm rd-failure-action"
            />
          )}
        </div>
      )}
      {run.status === "suspended" && (run.nestedWaits?.length ?? 0) > 0 && (
        <div className="notice notice-warning">
          <div>
            {run.nestedWaits!.map((wait) => (
              <div key={wait.runId}>
                Step <span className="mono">{wait.stepName}</span>{" "}
                waits on nested workflow{" "}
                <RouteLink
                  to={{
                    view: "workflows",
                    detail: {
                      kind: "run",
                      workflowName: wait.workflowName,
                      runId: wait.runId,
                    },
                  }}
                >
                  {wait.workflowName}{" "}
                  <span className="mono">{shortRunId(wait.runId)}</span>
                </RouteLink>
                {wait.status ? ` (${wait.status})` : ""}
              </div>
            ))}
          </div>
        </div>
      )}
      {resumable && (
        <div className="panel rd-resume">
          <ResumeAction
            run={resumable}
            onResumed={onResumed}
            resuming={served}
          />
        </div>
      )}
    </>
  );
}

function WorkflowReports(
  { run, onOpenItem }: {
    run: WorkflowRun;
    onOpenItem: (item: DrawerItem) => void;
  },
) {
  const reports = workflowReportLinks(
    run.workflowDataArtifacts,
    run.workflowName,
    run.id,
  );
  if (reports.length === 0) return null;
  return (
    <section className="panel rd-reports" aria-labelledby="rd-reports-title">
      <div className="panel-header">
        <h2 className="panel-title" id="rd-reports-title">
          Workflow reports <span className="panel-count">{reports.length}</span>
        </h2>
      </div>
      <div className="rd-report-list">
        {reports.map((report) =>
          report.to && (
            <ItemLink
              key={report.label}
              to={report.to}
              onOpen={onOpenItem}
              className="rd-report"
              title={`Open ${report.label}`}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path
                  d="M4 1.5h5.5L13 5v9a.5.5 0 0 1-.5.5h-8.5a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5zM9.5 1.5V5H13M6 8.5h5M6 11h3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
              </svg>
              <span>{report.label}</span>
            </ItemLink>
          )
        )}
      </div>
    </section>
  );
}

function LogsPanel({ logs, live }: { logs: LogsData; live: boolean }) {
  const lines = logs.lines ?? [];
  const preRef = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  // While live, keep the newest line in view unless the reader scrolled up.
  useEffect(() => {
    const el = preRef.current;
    if (el && live && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, live]);
  return (
    <section className="panel rd-logs" aria-labelledby="rd-logs-title">
      <div className="panel-header">
        <h2 className="panel-title" id="rd-logs-title">
          Execution logs{" "}
          <span className="panel-count">
            {logs.lineCount ?? lines.length} lines
          </span>
        </h2>
      </div>
      <pre
        ref={preRef}
        className="code-block rd-log-lines"
        tabIndex={0}
        aria-label="Execution log"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {lines.map((line, i) => {
          const isError = /\[ERR\]|\[error\]|failed|Error/i.test(line);
          const isWarn = /\[WRN\]|\[warning\]|warn/i.test(line);
          return (
            <span
              key={i}
              className={`rd-log-line${
                isError ? " is-error" : isWarn ? " is-warn" : ""
              }`}
            >
              {line}
            </span>
          );
        })}
      </pre>
    </section>
  );
}

// ── loading ─────────────────────────────────────────────────────────────

/** The run page's shape: columns of job cards, and a step list beside. */
function RunSkeleton() {
  const columns = [2, 3, 2, 1];
  return (
    <SkeletonRegion label="Loading run" className="rd-skeleton">
      <div className="rd-tabs">
        <Skeleton width={150} height={30} radius={7} />
        <Skeleton width={110} height={12} />
      </div>
      <div className="rd-graph-layout has-panel">
        <div className="panel rd-graph-panel rd-skel-graph">
          {columns.map((count, c) => (
            <div className="rd-skel-column" key={c}>
              {Array.from(
                { length: count },
                (_, r) => (
                  <div className="rd-skel-card" key={r}>
                    <Skeleton width={18} height={18} radius="50%" />
                    <span className="rd-skel-lines">
                      <Skeleton width={r % 2 ? "70%" : "55%"} height={11} />
                      <Skeleton width="40%" height={9} />
                    </span>
                  </div>
                ),
              )}
            </div>
          ))}
        </div>
        <div className="panel rd-job-panel">
          <div className="panel-header">
            <Skeleton width={140} height={14} />
          </div>
          <SkeletonList rows={4} label="Loading steps" />
        </div>
      </div>
    </SkeletonRegion>
  );
}

function GraphGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.2">
        <rect x="1" y="5" width="4" height="4" rx="1" />
        <rect x="9" y="1.5" width="4" height="4" rx="1" />
        <rect x="9" y="8.5" width="4" height="4" rx="1" />
        <path d="M5 7c2 0 2-3.5 4-3.5M5 7c2 0 2 3.5 4 3.5" />
      </g>
    </svg>
  );
}

function ListGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M5 3.5h7.5M5 7h7.5M5 10.5h7.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="2" cy="3.5" r="1" fill="currentColor" />
      <circle cx="2" cy="7" r="1" fill="currentColor" />
      <circle cx="2" cy="10.5" r="1" fill="currentColor" />
    </svg>
  );
}

// ── hooks ───────────────────────────────────────────────────────────────

/** Calls `fn` every `intervalMs` while non-null. */
function usePolling(fn: () => void, intervalMs: number | null): void {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (intervalMs === null) return;
    const timer = setInterval(() => latest.current(), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
}

/** The current time, ticking every `intervalMs` while non-null. */
function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (intervalMs === null) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function readItemParam(): DrawerItem | null {
  try {
    return parseItemParam(
      new URLSearchParams(globalThis.location?.search ?? "").get(ITEM_PARAM),
    );
  } catch {
    return null;
  }
}

/**
 * The item open in the drawer, mirrored to `?item=`. Opening pushes a
 * history entry so Back closes the drawer; switching items in an open
 * drawer replaces it.
 */
function useDrawerItem(): [
  DrawerItem | null,
  (item: DrawerItem) => void,
  () => void,
] {
  const [item, setItem] = useState<DrawerItem | null>(readItemParam);
  useEffect(() => {
    const onPop = () => setItem(readItemParam());
    globalThis.addEventListener("popstate", onPop);
    return () => globalThis.removeEventListener("popstate", onPop);
  }, []);
  const open = useCallback((next: DrawerItem) => {
    const url = withItemParam(location.href, next);
    if (readItemParam() !== null && history.state?.runDrawer) {
      history.replaceState(history.state, "", url);
    } else {
      history.pushState({ ...history.state, runDrawer: true }, "", url);
    }
    setItem(next);
  }, []);
  const close = useCallback(() => {
    if (history.state?.runDrawer) {
      history.back();
    } else {
      history.replaceState(
        history.state,
        "",
        withItemParam(location.href, null),
      );
    }
    setItem(null);
  }, []);
  return [item, open, close];
}

function extractLogs(payload: unknown): LogsData | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;

  // payload.data.log.lines
  if (obj.data && typeof obj.data === "object") {
    const d = obj.data as Record<string, unknown>;
    if (d.log && typeof d.log === "object") {
      const log = d.log as Record<string, unknown>;
      if (Array.isArray(log.lines)) {
        return log as unknown as LogsData;
      }
    }
    // payload.data.lines
    if (Array.isArray(d.lines)) {
      return d as unknown as LogsData;
    }
  }

  // payload.log.lines
  if (obj.log && typeof obj.log === "object") {
    const log = obj.log as Record<string, unknown>;
    if (Array.isArray(log.lines)) {
      return log as unknown as LogsData;
    }
  }

  // payload.lines
  if (Array.isArray(obj.lines)) {
    return obj as unknown as LogsData;
  }

  return null;
}
