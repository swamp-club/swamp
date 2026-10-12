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
import type { MouseEvent } from "react";
import type { WorkflowFacets } from "../lib/workflow_facets.ts";
import type { RouteState } from "../routes.ts";
import { navigateTo } from "../hooks/useRouter.ts";
import { RouteLink } from "../components/RouteLink.tsx";
import {
  RunHistoryBar,
  type RunHistoryEntry,
  RunningBadge,
} from "../components/RunHistoryBar.tsx";
import { Skeleton, SkeletonRunHistory } from "../components/Skeleton.tsx";
import { FailureLink } from "../components/FailureLink.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import { TriggerBadge } from "../components/TriggerBadge.tsx";
import {
  formatAbsoluteTime,
  formatCompactCount,
  formatCount,
  formatDuration,
  formatRelativeTime,
  pluralize,
} from "../lib/format.ts";

import type { RunStats } from "./workflow_list.ts";

// Structural subsets of the catalog entry and the run summary, so the card
// renders (and tests) without pulling in the request hooks.
export interface CardWorkflow {
  name: string;
  description?: string;
  stepCount?: number;
}

export interface CardRunSummary extends RunStats {
  running: number;
  /** Newest first. */
  recent: RunHistoryEntry[];
}

export interface WorkflowCardProps {
  workflow: CardWorkflow;
  facets: WorkflowFacets;
  /** The effective cron expression (file or serve override). */
  cron?: string;
  /** Runs in the dashboard time range; undefined when it never ran. */
  summary?: CardRunSummary;
  /** The summary is still loading: show placeholders, not "No runs". */
  summaryPending?: boolean;
  /** The server can't report runs: say nothing rather than "No runs". */
  summaryUnavailable?: boolean;
  onOpen?: (workflowName: string) => void;
  /** Clock for relative times; tests pin it. */
  now?: number;
}

/**
 * One workflow in the Workflows grid. The name is the link (so the card is
 * reachable by Tab and opens in a new tab on cmd/middle-click); clicking
 * anywhere else on the card opens it too, except on the run pips, which
 * open their own run.
 */
export function WorkflowCard(
  {
    workflow,
    facets,
    cron,
    summary,
    summaryPending = false,
    summaryUnavailable = false,
    onOpen,
    now,
  }: WorkflowCardProps,
) {
  const to: RouteState = {
    view: "workflows",
    detail: { kind: "workflow", workflowName: workflow.name },
  };
  const runs = summary?.runs ?? 0;
  const running = summary?.running ?? 0;
  const last = summary?.recent[0];
  const lastFinished = summary?.recent.find((r) => !UNFINISHED.has(r.status));
  const failedRun = lastFinished?.status === "failed" ? lastFinished : null;
  const lastStartedAt = summary?.lastStartedAt ?? last?.startedAt;

  const onCardClick = (e: MouseEvent<HTMLElement>) => {
    // Links and buttons inside the card handle their own clicks.
    const target = e.target as { closest?: (sel: string) => unknown } | null;
    if (target?.closest?.("a, button")) return;
    // Selecting the name to copy it is not a click on the card.
    const page = globalThis as {
      getSelection?: () => { toString(): string } | null;
    };
    if (page.getSelection?.()?.toString()) return;
    if (onOpen) onOpen(workflow.name);
    else navigateTo(to);
  };

  return (
    <article className="card wf-card" onClick={onCardClick}>
      <div className="card-header wf-card-header">
        <h3 className="card-name wf-card-name">
          <RouteLink to={to} className="wf-card-link" title={workflow.name}>
            {workflow.name}
          </RouteLink>
        </h3>
        <span className="wf-card-status">
          {failedRun && !summaryPending && (
            <FailureLink workflowName={workflow.name} runId={failedRun.runId} />
          )}
          {summaryPending
            ? <Skeleton width={64} height={18} radius={4} />
            : running > 0
            ? <RunningBadge count={running} />
            : last
            ? <StatusPill status={last.status} />
            : null}
        </span>
      </div>

      {workflow.description && (
        <p className="wf-card-desc" title={workflow.description}>
          {workflow.description}
        </p>
      )}

      <div className="card-meta wf-card-meta">
        <TriggerList facets={facets} cron={cron} />
        {workflow.stepCount !== undefined && (
          <span className="wf-card-steps">
            {pluralize(workflow.stepCount, "step")}
          </span>
        )}
        {lastStartedAt && (
          <time
            className="wf-card-last"
            dateTime={lastStartedAt}
            title={`Last run ${formatAbsoluteTime(lastStartedAt)}`}
          >
            {formatRelativeTime(lastStartedAt, now)}
          </time>
        )}
      </div>

      {!summaryUnavailable && (
        <div className="wf-card-history">
          {summaryPending ? <SkeletonRunHistory height={14} /> : (
            <RunHistoryBar
              runs={summary?.recent ?? []}
              workflowName={workflow.name}
              noun="runs in range"
            />
          )}
        </div>
      )}

      {!summaryUnavailable && (
        <div className="wf-card-foot">
          {summaryPending ? <Skeleton width={110} height={10} /> : (
            <span
              className="wf-card-counts"
              title={summary
                ? `${pluralize(runs, "run")}: ${
                  formatCount(summary.succeeded)
                } passed, ${formatCount(summary.failed)} failed${
                  summary.durationMs > 0
                    ? `, ${formatDuration(summary.durationMs)} total`
                    : ""
                }`
                : undefined}
            >
              {runs === 0 ? "No runs in range" : (
                <>
                  {formatCompactCount(runs)} {runs === 1 ? "run" : "runs"}
                  {summary && summary.failed > 0 && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="wf-card-failed">
                        {formatCompactCount(summary.failed)} failed
                      </span>
                    </>
                  )}
                </>
              )}
            </span>
          )}
          {summary && summary.durationMs > 0 && (
            <span
              className="wf-card-time"
              title="Total execution time of finished runs in range"
            >
              {formatDuration(summary.durationMs)}
            </span>
          )}
        </div>
      )}
    </article>
  );
}

const UNFINISHED = new Set(["running", "suspended", "pending"]);

/** Cron expression, webhook route(s), or Manual. */
function TriggerList(
  { facets, cron }: { facets: WorkflowFacets; cron?: string },
) {
  const [firstRoute, ...moreRoutes] = facets.webhooks;
  return (
    <span className="wf-triggers">
      {facets.scheduled && (
        <span className="wf-trigger">
          <TriggerBadge trigger="schedule" />
          {cron && (
            <span className="cron-badge" title={`Cron: ${cron}`}>{cron}</span>
          )}
        </span>
      )}
      {firstRoute && (
        <span className="wf-trigger">
          <TriggerBadge trigger="webhook" />
          <span className="wf-route" title={facets.webhooks.join("\n")}>
            {firstRoute}
            {moreRoutes.length > 0 && (
              <span className="wf-route-more">+{moreRoutes.length}</span>
            )}
          </span>
        </span>
      )}
      {!facets.scheduled && !firstRoute && <TriggerBadge trigger="manual" />}
    </span>
  );
}
