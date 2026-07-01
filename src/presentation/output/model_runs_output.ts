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
import type { ActiveRun } from "../../domain/models/active_run.ts";
import type { OutputMode } from "./output.ts";

const STALE_TTL_MS = 90_000;

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
    Math.max(header.length, ...rows.map((row) => row[i].length))
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

  const headers = ["STATUS", "KIND", "NAME", "ID", "AGE", "PID", "HOST"];
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
    if (col === 3) return dim(value);
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
    })),
  }));
}

export function writeDoctorRunsLog(
  active: ActiveRun[],
  stale: ActiveRun[],
  reaped: number,
  fix: boolean,
): void {
  if (active.length === 0 && stale.length === 0) {
    writeOutput("No active or stale model method runs.");
    return;
  }

  const lines: string[] = [];

  if (active.length > 0) {
    lines.push(bold(`${active.length} active run(s):`));
    const headers = ["MODEL", "METHOD", "ID", "AGE", "PID"];
    const rows = active.map((r) => [
      r.modelType ?? "unknown",
      r.methodName ?? "unknown",
      r.id.slice(0, 8),
      formatDuration(Date.now() - r.startedAt.getTime()),
      String(r.pid),
    ]);
    lines.push(...tableLines(headers, rows, (col, value) => {
      if (col === 2) return dim(value);
      return value;
    }));
  }

  if (stale.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(bold(red(`${stale.length} stale run(s) detected:`)));
    const headers = ["MODEL", "METHOD", "ID", "HEARTBEAT AGE", "PID"];
    const rows = stale.map((r) => [
      r.modelType ?? "unknown",
      r.methodName ?? "unknown",
      r.id.slice(0, 8),
      formatDuration(Date.now() - r.heartbeatAt.getTime()),
      String(r.pid),
    ]);
    lines.push(...tableLines(headers, rows, (col, value) => {
      if (col === 2) return dim(value);
      if (col === 3) return red(value);
      return value;
    }));

    if (fix) {
      lines.push("");
      lines.push(green(`Reaped ${reaped} stale run(s).`));
    } else {
      lines.push("");
      lines.push(dim("Run with --fix to automatically reap stale runs."));
    }
  }

  writeOutput(lines.join("\n"));
}

export function writeDoctorRunsJson(
  totalTracked: number,
  active: number,
  stale: number,
  reaped: number,
): void {
  console.log(JSON.stringify({ totalTracked, active, stale, reaped }));
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
