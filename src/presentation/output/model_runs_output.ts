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

import { bold, dim, green, red, yellow } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { maxOf } from "../../domain/array_extrema.ts";
import {
  type ActiveRun,
  STALE_TTL_MS,
} from "../../domain/models/active_run.ts";
import type { OutputMode } from "./output.ts";

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function tableLines(
  headers: string[],
  rows: string[][],
  colorCell?: (columnIndex: number, value: string) => string,
): string[] {
  const widths = headers.map((header, i) =>
    Math.max(header.length, maxOf(rows.map((row) => row[i].length)) ?? 0)
  );
  const lines: string[] = [
    dim(headers.map((header, i) => header.padEnd(widths[i])).join("  ")),
  ];
  for (const row of rows) {
    lines.push(
      row
        .map((cell, i) => {
          const padded = cell.padEnd(widths[i]);
          return colorCell ? colorCell(i, padded) : padded;
        })
        .join("  ")
        .trimEnd(),
    );
  }
  return lines;
}

export function writeModelRunsLog(runs: ActiveRun[]): void {
  if (runs.length === 0) {
    writeOutput("No tracked runs.");
    return;
  }

  const headers = [
    "STATUS",
    "KIND",
    "NAME",
    "ID",
    "AGE",
    "INITIATED BY",
    "PID",
    "HOST",
  ];
  const rows = runs.map((run) => {
    const stale = run.isStale(STALE_TTL_MS);
    const age = formatDuration(Date.now() - run.startedAt.getTime());
    const kind = run.runKind === "workflow" ? "workflow" : "method";
    const name = run.runKind === "workflow"
      ? run.workflowName ?? "unknown"
      : `${run.modelType ?? "unknown"}/${run.methodName ?? "unknown"}`;
    return [
      stale ? `${run.status} [STALE]` : run.status,
      kind,
      name,
      run.id.slice(0, 8),
      age,
      run.initiatedBy ?? "-",
      String(run.pid),
      run.hostname,
    ];
  });

  const lines = tableLines(headers, rows, (col, value) => {
    if (col === 0) {
      const trimmed = value.trim();
      if (trimmed.includes("[STALE]")) {
        return value.replace(trimmed, red(trimmed));
      }
      if (trimmed === "running") return value.replace(trimmed, green(trimmed));
      if (trimmed === "failed") return value.replace(trimmed, red(trimmed));
      if (trimmed === "cancelled") {
        return value.replace(trimmed, yellow(trimmed));
      }
    }
    if (col === 3 || col === 5) return dim(value);
    return value;
  });

  writeOutput(lines.join("\n"));
}

export function writeModelRunsJson(runs: ActiveRun[]): void {
  console.log(JSON.stringify({
    runs: runs.map((r) => ({
      id: r.id,
      runKind: r.runKind,
      modelType: r.modelType,
      methodName: r.methodName,
      workflowName: r.workflowName,
      pid: r.pid,
      hostname: r.hostname,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      heartbeatAt: r.heartbeatAt.toISOString(),
      stale: r.isStale(STALE_TTL_MS),
      initiatedBy: r.initiatedBy,
    })),
  }));
}

export interface DoctorRunProgress {
  readonly progress?:
    readonly import("../../domain/remote/run_progress.ts").RunProgressSnapshot[];
  readonly progressScope?: string;
}

export function writeDoctorRunsLog(
  active: ActiveRun[],
  stale: ActiveRun[],
  reaped: number,
  fix: boolean,
  orphanedWorkflowRuns?: number,
  orphanedReaped?: number,
  orphanedMethodRuns?: number,
  orphanedMethodReaped?: number,
  orphanedMethodError?: string,
  progressByRun?: ReadonlyMap<string, DoctorRunProgress>,
  webhookAdmissions?:
    readonly import("../../domain/remote/run_progress.ts").WebhookAdmissionSnapshot[],
): void {
  if (
    active.length === 0 && stale.length === 0 &&
    (!orphanedWorkflowRuns || orphanedWorkflowRuns === 0) &&
    (!orphanedMethodRuns || orphanedMethodRuns === 0) &&
    orphanedMethodError === undefined && !webhookAdmissions?.length &&
    !progressByRun?.size
  ) {
    writeOutput("No active or stale runs.");
    return;
  }

  const lines: string[] = [];

  const runName = (r: ActiveRun) =>
    r.runKind === "workflow"
      ? r.workflowName ?? "unknown"
      : `${r.modelType ?? "unknown"}/${r.methodName ?? "unknown"}`;

  if (active.length > 0) {
    lines.push(bold(`${active.length} active run(s):`));
    const headers = ["KIND", "NAME", "ID", "AGE", "PID"];
    const rows = active.map((r) => [
      r.runKind === "workflow" ? "workflow" : "method",
      runName(r),
      r.id.slice(0, 8),
      formatDuration(Date.now() - r.startedAt.getTime()),
      String(r.pid),
    ]);
    const table = tableLines(headers, rows, (col, value) => {
      if (col === 2) return dim(value);
      return value;
    });
    for (const line of table) lines.push(line);
  }

  if (stale.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(bold(red(`${stale.length} stale run(s) detected:`)));
    const headers = ["KIND", "NAME", "ID", "HEARTBEAT AGE", "PID", "HOST"];
    const rows = stale.map((r) => [
      r.runKind === "workflow" ? "workflow" : "method",
      runName(r),
      r.id.slice(0, 8),
      formatDuration(Date.now() - r.heartbeatAt.getTime()),
      String(r.pid),
      r.hostname,
    ]);
    const table = tableLines(headers, rows, (col, value) => {
      if (col === 2) return dim(value);
      if (col === 3) return red(value);
      return value;
    });
    for (const line of table) lines.push(line);

    if (fix) {
      lines.push("");
      lines.push(green(`Reaped ${reaped} stale run(s).`));
    } else {
      lines.push("");
      lines.push(dim("Run with --fix to automatically reap stale runs."));
    }
  }

  if (orphanedWorkflowRuns && orphanedWorkflowRuns > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      bold(
        red(
          `${orphanedWorkflowRuns} orphaned workflow run(s) whose owner is gone:`,
        ),
      ),
    );
    if (fix && orphanedReaped) {
      lines.push(green(`Reaped ${orphanedReaped} orphaned workflow run(s).`));
    } else if (!fix) {
      lines.push(
        dim("Run with --fix to automatically reap orphaned workflow runs."),
      );
    }
  }

  if (orphanedMethodRuns && orphanedMethodRuns > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      bold(
        red(
          `${orphanedMethodRuns} orphaned method run(s) whose owner is gone:`,
        ),
      ),
    );
    if (fix && orphanedMethodReaped) {
      lines.push(
        green(`Cancelled ${orphanedMethodReaped} orphaned method run(s).`),
      );
    } else if (!fix) {
      lines.push(
        dim("Run with --fix to cancel orphaned method runs."),
      );
    }
  }

  if (orphanedMethodError !== undefined) {
    if (lines.length > 0) lines.push("");
    lines.push(
      red(
        `Could not check method runs for a gone owner: ${orphanedMethodError}`,
      ),
    );
  }

  for (const [runId, diagnostics] of progressByRun ?? []) {
    lines.push("");
    lines.push(
      `Progress for ${runId} (${
        diagnostics.progressScope ?? "unknown scope"
      }):`,
    );
    if (!diagnostics.progress?.length) {
      lines.push("  No live step observations available.");
    }
    for (const step of diagnostics.progress ?? []) {
      lines.push(
        `  ${
          step.scope === "method"
            ? `${step.model}/${step.method}`
            : step.scope === "run"
            ? step.workflow
            : `${step.workflow}/${step.job}/${step.step}`
        }: ${step.phase} (${formatDuration(step.phaseElapsedMs)})`,
      );
      lines.push(`    Last progress: ${step.lastProgressAt}`);
      if (step.worker) lines.push(`    Worker: ${step.worker}`);
      if (step.traceId) lines.push(`    Trace: ${step.traceId}`);
      if (step.phase === "waiting_for_lock") {
        lines.push(
          `    Lock: ${step.resource ?? "unknown"}; holder run: ${
            step.holderRunId ?? "unknown"
          }`,
        );
      }
    }
  }
  if (webhookAdmissions?.length) {
    lines.push("", bold("Webhook admissions:"));
    for (const entry of webhookAdmissions) {
      lines.push(
        `  ${entry.receiptId} (${entry.workflow}): ${entry.phase} (${
          formatDuration(entry.phaseElapsedMs)
        })`,
      );
      if (entry.runId) lines.push(`    Run: ${entry.runId}`);
      lines.push(`    Last progress: ${entry.lastProgressAt}`);
      if (entry.traceId) lines.push(`    Receipt trace: ${entry.traceId}`);
      if (entry.blockingRunIds.length) {
        lines.push(
          `    Admission slots held by: ${entry.blockingRunIds.join(", ")}`,
        );
      }
      if (entry.unknownBlockers) {
        lines.push(
          `    Holders without a run ID yet: ${entry.unknownBlockers}`,
        );
      }
    }
  }
  writeOutput(lines.join("\n"));
}

export function writeDoctorRunsJson(
  totalTracked: number,
  activeRuns: ActiveRun[],
  staleRuns: ActiveRun[],
  reaped: number,
  orphanedWorkflowRuns?: number,
  orphanedReaped?: number,
  orphanedMethodRuns?: number,
  orphanedMethodReaped?: number,
  orphanedMethodError?: string,
  progressByRun?: ReadonlyMap<string, DoctorRunProgress>,
  webhookAdmissions?:
    readonly import("../../domain/remote/run_progress.ts").WebhookAdmissionSnapshot[],
): void {
  // A run is stale because doctor listed it as stale: an expired heartbeat,
  // or an owner process that is gone while its heartbeat is still fresh.
  const mapRun = (stale: boolean) => (r: ActiveRun) => ({
    id: r.id,
    runKind: r.runKind,
    modelType: r.modelType,
    methodName: r.methodName,
    workflowName: r.workflowName,
    pid: r.pid,
    hostname: r.hostname,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    heartbeatAt: r.heartbeatAt.toISOString(),
    stale,
    ...progressByRun?.get(r.id),
  });
  console.log(JSON.stringify({
    totalTracked,
    ...(progressByRun
      ? {
        liveProgress: [...progressByRun.values()].flatMap((entry) =>
          entry.progress ?? []
        ),
      }
      : {}),
    ...(webhookAdmissions !== undefined ? { webhookAdmissions } : {}),
    active: activeRuns.length,
    stale: staleRuns.length,
    reaped,
    ...(orphanedWorkflowRuns !== undefined
      ? { orphanedWorkflowRuns, orphanedReaped: orphanedReaped ?? 0 }
      : {}),
    ...(orphanedMethodRuns !== undefined
      ? {
        orphanedMethodRuns,
        orphanedMethodReaped: orphanedMethodReaped ?? 0,
      }
      : {}),
    ...(orphanedMethodError !== undefined ? { orphanedMethodError } : {}),
    activeRuns: activeRuns.map(mapRun(false)),
    staleRuns: staleRuns.map(mapRun(true)),
  }));
}

export function createModelRunsOutput(mode: OutputMode) {
  return {
    writeRuns: mode === "json" ? writeModelRunsJson : writeModelRunsLog,
    writeEmpty: (msg: string) => {
      if (mode === "json") {
        console.log(JSON.stringify({ runs: [] }));
      } else {
        writeOutput(msg);
      }
    },
  };
}
