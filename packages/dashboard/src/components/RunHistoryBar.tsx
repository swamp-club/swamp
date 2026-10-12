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

import { buildPath, isPlainLeftClick, type RouteState } from "../routes.ts";
import { navigateTo } from "../hooks/useRouter.ts";
import { formatDuration, formatShortDateTime } from "../lib/format.ts";

export interface RunHistoryEntry {
  runId: string;
  status: string;
  startedAt?: string;
  duration?: number;
  /** Needed to link the pip; falls back to the bar's `workflowName`. */
  workflowName?: string;
}

interface RunHistoryBarProps {
  /** Runs newest first, as the run search and summary return them. */
  runs: readonly RunHistoryEntry[];
  /** Workflow the runs belong to, for links. */
  workflowName?: string;
  /** Number of pips; slots without a run render as empty placeholders. */
  slots?: number;
  /** Pip height in px. */
  height?: number;
  /** What the runs are, for the accessible label ("schedule runs"). */
  noun?: string;
  /** A run to mark as the one being looked at (e.g. a table row's run). */
  highlightRunId?: string;
}

const STATUS_CLASS: Record<string, string> = {
  succeeded: "ok",
  failed: "fail",
  running: "running",
  suspended: "suspended",
  cancelled: "cancelled",
  pending: "pending",
};

function pipTitle(run: RunHistoryEntry): string {
  const parts = [run.status];
  if (run.duration !== undefined) parts.push(formatDuration(run.duration));
  if (run.startedAt) parts.push(formatShortDateTime(run.startedAt));
  return `${parts.join(" · ")}\nrun ${run.runId.slice(0, 8)}`;
}

/**
 * One pip per recent run, oldest on the left and newest on the right,
 * colored by status. Each pip links to its run; running pips pulse.
 */
export function RunHistoryBar(
  {
    runs,
    workflowName,
    slots = 20,
    height = 14,
    noun = "runs",
    highlightRunId,
  }: RunHistoryBarProps,
) {
  const shown = runs.slice(0, slots).reverse();
  const empty = Math.max(0, slots - shown.length);
  const failed = shown.filter((r) => r.status === "failed").length;
  const label = shown.length === 0
    ? `No ${noun} yet`
    : `Last ${shown.length} ${noun}: ${
      shown.length - failed
    } not failed, ${failed} failed`;

  return (
    <div
      className="run-history"
      role="list"
      aria-label={label}
      style={{ height }}
    >
      {Array.from({ length: empty }, (_, i) => (
        <span
          key={`empty-${i}`}
          className="run-pip empty"
          aria-hidden="true"
        />
      ))}
      {shown.map((run) => {
        const wf = run.workflowName ?? workflowName;
        const current = run.runId === highlightRunId;
        const cls = `run-pip ${STATUS_CLASS[run.status] ?? "other"}${
          current ? " current" : ""
        }`;
        const title = pipTitle(run);
        if (!wf) {
          return (
            <span
              key={run.runId}
              role="listitem"
              className={cls}
              title={title}
            />
          );
        }
        const to: RouteState = {
          view: "workflows",
          detail: { kind: "run", workflowName: wf, runId: run.runId },
        };
        return (
          <a
            key={run.runId}
            role="listitem"
            className={cls}
            href={buildPath(to)}
            title={title}
            aria-current={current ? "true" : undefined}
            aria-label={title.replace("\n", ", ")}
            onClick={(e) => {
              // Pips sit inside clickable cards and rows: open the run,
              // not the container.
              e.stopPropagation();
              if (!isPlainLeftClick(e)) return;
              e.preventDefault();
              navigateTo(to);
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * The established "in progress" marker. One run: a pulsing dot and
 * "Running". Several: stacked dots and "Running ×N", so a busy workflow
 * reads differently from a single run at a glance.
 */
export function RunningBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  const multi = count > 1;
  return (
    <span
      className={`running-badge${multi ? " multi" : ""}`}
      title={multi ? `${count} runs in progress` : "1 run in progress"}
    >
      <span className="running-dots" aria-hidden="true">
        <span />
        {multi && <span />}
        {count > 2 && <span />}
      </span>
      {multi ? `Running ×${count}` : "Running"}
    </span>
  );
}
