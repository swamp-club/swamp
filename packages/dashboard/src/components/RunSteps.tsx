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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  buildPath,
  type DetailView,
  isPlainLeftClick,
  type RouteState,
} from "../routes.ts";
import { formatAbsoluteTime, formatDuration } from "../lib/format.ts";
import { stepArtifactLink } from "../views/artifact_links.ts";
import type { DrawerItem } from "../views/run_item_param.ts";
import { CodeBlock } from "./CodeBlock.tsx";
import { StepSignalWait, type StepSignalWaitInfo } from "./StepSignalWait.tsx";
import { RunStatusIcon, statusLabel } from "./RunStatusIcon.tsx";
import { StepLog } from "./StepLog.tsx";
import { logFromOutputs, pickLogArtifact } from "./step_log.ts";
import {
  describeCondition,
  displayStatus,
  elapsed,
  isLive,
  type RunGraph,
  type StepRunLike,
} from "./run_graph_model.ts";

export interface ApprovalInfo {
  status: "approved" | "rejected" | "timed_out";
  approvedBy?: string;
  approvedAt?: string;
  rejectedBy?: string;
  rejectedAt?: string;
  timeoutAt?: string;
  reason?: string;
}

/** A step as `workflow.history.get` returns it. */
export interface StepRun extends StepRunLike {
  modelName?: string;
  methodName?: string;
  approval?: ApprovalInfo;
  wait?: StepSignalWaitInfo;
  outputs?: Record<string, unknown>;
}

export interface JobRun {
  name: string;
  status: string;
  steps: StepRun[];
  startedAt?: string;
  completedAt?: string;
  duration?: number;
}

/** Shared by every step row: how links open and what time it is. */
export interface StepContext {
  runStatus: string;
  now: number;
  /** Opens a report or data item in the page's drawer. */
  onOpenItem: (item: DrawerItem) => void;
  /** In-app navigation for plain clicks on other links. */
  onNavigate: (to: RouteState) => void;
  /** Task type per step name, from the definition, when known. */
  taskTypes?: ReadonlyMap<string, string>;
  /** A step to open and scroll to (a failure link's target). */
  focusStep?: string | null;
  /** Changes each time the focus is requested, to re-scroll. */
  focusNonce?: number;
}

function isDrawerItem(detail: DetailView): detail is DrawerItem {
  return detail?.kind === "data" || detail?.kind === "report" ||
    detail?.kind === "runReport";
}

/**
 * A link to a report or data item: a plain click opens it in the drawer,
 * a modified or middle click opens its full page in a new tab.
 */
export function ItemLink(
  { to, onOpen, className, title, children }: {
    to: RouteState;
    onOpen: (item: DrawerItem) => void;
    className?: string;
    title?: string;
    children: ReactNode;
  },
) {
  const detail = to.detail;
  return (
    <a
      href={buildPath(to)}
      className={className}
      title={title}
      onClick={(e) => {
        if (!isPlainLeftClick(e) || !isDrawerItem(detail)) return;
        e.preventDefault();
        onOpen(detail);
      }}
    >
      {children}
    </a>
  );
}

/** A link to another dashboard page, navigating in-app on a plain click. */
export function NavLink(
  { to, onNavigate, className, children, title }: {
    to: RouteState;
    onNavigate: (to: RouteState) => void;
    className?: string;
    title?: string;
    children: ReactNode;
  },
) {
  return (
    <a
      href={buildPath(to)}
      className={className}
      title={title}
      onClick={(e) => {
        if (!isPlainLeftClick(e)) return;
        e.preventDefault();
        onNavigate(to);
      }}
    >
      {children}
    </a>
  );
}

const TASK_BADGES: Record<string, string> = {
  manual_approval: "approval",
  wait_for_signal: "signal",
  workflow: "nested workflow",
  assert: "assert",
};

/** Why a step was skipped, in words. */
export function skipReasonText(
  reason: StepRunLike["skipReason"],
): string | null {
  if (!reason) return null;
  switch (reason.kind) {
    case "dependency":
      return "Skipped: a dependency's condition was not met";
    case "guarded":
      return reason.expression
        ? `Skipped by its guard: ${reason.expression}`
        : "Skipped by its guard";
    case "job_skipped":
      return "Skipped with its job";
    default:
      return "Skipped";
  }
}

/** One step: status, name, timing, and whatever explains its outcome. */
export function StepRow({ step, ctx }: { step: StepRun; ctx: StepContext }) {
  const status = displayStatus(step.status, ctx.runStatus);
  const isFailure = status === "failed" && !step.allowedFailure;
  const focused = !!ctx.focusStep && ctx.focusStep === step.name;
  const hasLog = pickLogArtifact(step.dataArtifacts) !== null ||
    logFromOutputs(step.outputs) !== null;
  // A step that failed the run opens on its log: that is what the reader
  // came for.
  const [expanded, setExpanded] = useState(isFailure || focused);
  const rowRef = useRef<HTMLLIElement>(null);
  const logId = useId();

  useEffect(() => {
    if (!focused) return;
    setExpanded(true);
    const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")
      .matches;
    // After the panel and the log have painted.
    const frame = requestAnimationFrame(() =>
      rowRef.current?.scrollIntoView({
        block: "nearest",
        behavior: reduce ? "auto" : "smooth",
      })
    );
    return () => cancelAnimationFrame(frame);
  }, [focused, ctx.focusNonce]);

  const duration = elapsed(step, ctx.now, isLive(status));
  const taskType = ctx.taskTypes?.get(step.name) ??
    (step.nestedRun
      ? "workflow"
      : step.approval || step.status === "waiting_approval"
      ? "manual_approval"
      : step.wait
      ? "wait_for_signal"
      : undefined);
  const badge = taskType ? TASK_BADGES[taskType] : undefined;
  const skip = status === "skipped" ? skipReasonText(step.skipReason) : null;
  const artifacts = (step.dataArtifacts ?? [])
    .map((ref) => ({ ref, link: stepArtifactLink(ref) }))
    .filter((a) => a.link !== null);
  const hasOutputs = step.outputs !== undefined &&
    Object.keys(step.outputs).length > 0;

  return (
    <li
      ref={rowRef}
      className={`rs-step rs-step-${status}${focused ? " is-focused" : ""}`}
    >
      <RunStatusIcon status={status} size={15} />
      <div className="rs-step-body">
        <div className="rs-step-title">
          <span className="rs-step-name">{step.name}</span>
          {badge && <span className="rs-badge">{badge}</span>}
          {step.allowedFailure && (
            <span className="rs-badge rs-badge-warn">allowed to fail</span>
          )}
        </div>
        {step.modelName && (
          <div className="rs-step-sub mono">
            {step.modelName}
            {step.methodName ? `.${step.methodName}` : ""}
          </div>
        )}
        {skip && <div className="rs-step-sub">{skip}</div>}
        {step.error && <pre className="rs-error">{step.error}</pre>}
        <StepSignalWait status={step.status} wait={step.wait} />
        {step.approval && <ApprovalNote approval={step.approval} />}
        {step.nestedRun && (
          <div className="rs-step-nested">
            <span aria-hidden="true">↳</span> Nested run{" "}
            <NavLink
              to={{
                view: "workflows",
                detail: {
                  kind: "run",
                  workflowName: step.nestedRun.workflowName,
                  runId: step.nestedRun.runId,
                },
              }}
              onNavigate={ctx.onNavigate}
            >
              {step.nestedRun.workflowName}{" "}
              <span className="mono">{step.nestedRun.runId.slice(0, 8)}</span>
            </NavLink>
            {step.nestedRun.detached && " (left suspended)"}
          </div>
        )}
        {artifacts.length > 0 && (
          <div className="rs-artifacts">
            {artifacts.map(({ ref, link }) =>
              link!.to
                ? (
                  <ItemLink
                    key={ref.dataId}
                    to={link!.to}
                    onOpen={ctx.onOpenItem}
                    className="rs-chip"
                    title={`Open ${ref.name} v${ref.version}`}
                  >
                    {ref.tags?.type === "report" && (
                      <span className="rs-chip-kind">report</span>
                    )}
                    {link!.label}
                  </ItemLink>
                )
                : (
                  <span className="rs-chip is-static" key={ref.dataId}>
                    {link!.label}
                  </span>
                )
            )}
          </div>
        )}
        {expanded && hasLog && (
          <div id={logId}>
            <StepLog
              artifacts={step.dataArtifacts}
              outputs={step.outputs}
              failed={isFailure}
              onOpenItem={ctx.onOpenItem}
            />
          </div>
        )}
        {hasOutputs && (
          <details className="rs-outputs">
            <summary>Outputs</summary>
            <CodeBlock code={JSON.stringify(step.outputs, null, 2)} />
          </details>
        )}
      </div>
      <span className="rs-step-aside">
        <span
          className="rs-step-time mono"
          title={step.startedAt
            ? `Started ${formatAbsoluteTime(step.startedAt)}`
            : undefined}
        >
          {duration !== undefined ? formatDuration(duration) : ""}
        </span>
        {hasLog && (
          <button
            type="button"
            className="rs-log-toggle"
            aria-expanded={expanded}
            aria-controls={logId}
            onClick={() => setExpanded((e) => !e)}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path
                d="M3 2l3.5 3L3 8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Log
          </button>
        )}
      </span>
    </li>
  );
}

function ApprovalNote({ approval }: { approval: ApprovalInfo }) {
  const tone = approval.status === "approved"
    ? "success"
    : approval.status === "rejected"
    ? "danger"
    : "warning";
  const at = (iso?: string) => (iso ? ` at ${formatAbsoluteTime(iso)}` : "");
  return (
    <div className={`rs-note rs-note-${tone}`}>
      {approval.status === "approved" &&
        `Approved by ${approval.approvedBy ?? "unknown"}${
          at(approval.approvedAt)
        }`}
      {approval.status === "rejected" &&
        `Rejected by ${approval.rejectedBy ?? "unknown"}${
          at(approval.rejectedAt)
        }${approval.reason ? `: ${approval.reason}` : ""}`}
      {approval.status === "timed_out" &&
        `Timed out${at(approval.timeoutAt)}`}
    </div>
  );
}

/** A job's steps as a list. */
export function StepList(
  { steps, ctx }: { steps: StepRun[]; ctx: StepContext },
) {
  if (steps.length === 0) {
    return <p className="rs-empty">This job has no steps.</p>;
  }
  return (
    <ol className="rs-steps">
      {steps.map((step) => <StepRow key={step.name} step={step} ctx={ctx} />)}
    </ol>
  );
}

/**
 * The side panel for the job selected in the graph: its status and timing,
 * what it waited on, and its steps.
 */
export function RunJobPanel(
  { job, graph, ctx, onClose, headingRef }: {
    job: JobRun;
    graph: RunGraph;
    ctx: StepContext;
    onClose: () => void;
    headingRef?: (el: HTMLHeadingElement | null) => void;
  },
) {
  const node = graph.jobs.find((j) => j.name === job.name);
  const status = node?.status ?? displayStatus(job.status, ctx.runStatus);
  const duration = elapsed(job, ctx.now, isLive(status));
  const needs = graph.edges.filter((e) => e.to === job.name);
  const feeds = graph.edges.filter((e) => e.from === job.name);
  const statusOf = (name: string) =>
    graph.jobs.find((j) => j.name === name)?.status ?? "unknown";

  return (
    <section className="rj-panel" aria-labelledby="rj-panel-title">
      <header className="rj-head">
        <RunStatusIcon status={status} size={20} />
        <div className="rj-title-wrap">
          <h2
            id="rj-panel-title"
            className="rj-title"
            tabIndex={-1}
            ref={headingRef}
          >
            {job.name}
          </h2>
          <div className="rj-sub">
            <span className={`rj-status rs-text-${status}`}>
              {statusLabel(status)}
            </span>
            {duration !== undefined && (
              <span className="mono">{formatDuration(duration)}</span>
            )}
            {node && node.stepsTotal > 0 && (
              <span>
                {node.stepsDone}/{node.stepsTotal} steps
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          className="rj-close"
          aria-label="Close job panel"
          title="Close (Esc)"
          onClick={onClose}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M3 3l8 8M11 3l-8 8"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>
      {node?.status === "failed" && node.failedStep && (
        <div className="rj-failure" role="note">
          <RunStatusIcon status="failed" size={16} label="" />
          <div>
            <div className="rj-failure-title">
              <span className="mono">{node.failedStep.name}</span> failed
            </div>
            {node.failedStep.error && (
              <pre className="rj-failure-error">{node.failedStep.error}</pre>
            )}
          </div>
        </div>
      )}
      {(needs.length > 0 || feeds.length > 0) && (
        <dl className="rj-deps">
          {needs.length > 0 && (
            <div>
              <dt>Needs</dt>
              <dd>
                {needs.map((e) => (
                  <span
                    key={e.from}
                    className={`rj-dep rj-dep-${e.state}`}
                    title={`Runs when ${e.from} ${
                      describeCondition(e.condition)
                    }${e.state === "unmet" ? " — not met" : ""}`}
                  >
                    <RunStatusIcon status={statusOf(e.from)} size={12} />
                    {e.from}
                    {e.condition && e.condition.type !== "succeeded" && (
                      <span className="rj-dep-cond">
                        {describeCondition(e.condition)}
                      </span>
                    )}
                  </span>
                ))}
              </dd>
            </div>
          )}
          {feeds.length > 0 && (
            <div>
              <dt>Feeds</dt>
              <dd>
                {feeds.map((e) => (
                  <span key={e.to} className={`rj-dep rj-dep-${e.state}`}>
                    <RunStatusIcon status={statusOf(e.to)} size={12} />
                    {e.to}
                  </span>
                ))}
              </dd>
            </div>
          )}
        </dl>
      )}
      <StepList steps={job.steps ?? []} ctx={ctx} />
    </section>
  );
}

/** Every job with its steps: the "List" tab. */
export function RunJobList(
  { jobs, ctx, graph }: { jobs: JobRun[]; ctx: StepContext; graph: RunGraph },
) {
  return (
    <div className="rj-list">
      {jobs.map((job) => {
        const node = graph.jobs.find((j) => j.name === job.name);
        const status = node?.status ??
          displayStatus(job.status, ctx.runStatus);
        const duration = elapsed(job, ctx.now, isLive(status));
        return (
          <section className="panel rj-list-job" key={job.name}>
            <div className="panel-header">
              <h3 className="panel-title">
                <RunStatusIcon status={status} size={16} />
                {job.name}
                <span className={`rj-status rs-text-${status}`}>
                  {statusLabel(status)}
                </span>
              </h3>
              {duration !== undefined && (
                <span className="mono rj-list-time">
                  {formatDuration(duration)}
                </span>
              )}
            </div>
            <StepList steps={job.steps ?? []} ctx={ctx} />
          </section>
        );
      })}
    </div>
  );
}
