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

/**
 * Render functions for the `swamp worker` command group. Each supports both
 * "log" (human-readable) and "json" (structured) output modes per the
 * terminal-output design system.
 */

import { bold, cyan, dim, green, red, yellow } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type {
  WorkerListData,
  WorkerQueueListData,
  WorkerTokenCreateData,
  WorkerTokenListData,
  WorkerTokenRevokeData,
} from "../../libswamp/mod.ts";
import type { WorkerStatusEvent } from "../../worker/connect.ts";
import type { WorkerVerifyData } from "../../serve/protocol.ts";
import type { OutputMode } from "./output.ts";

const checkmark = "\u2713"; // ✓

function humanStopReason(reason: string): string {
  switch (reason) {
    case "max-dispatches":
      return "reached max dispatches";
    case "idle-timeout":
      return "idle timeout elapsed";
    case "signal":
      return "received shutdown signal";
    default:
      return reason;
  }
}

/** Pads each cell to its column width and joins with two spaces. */
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

function colorTokenState(state: string): string {
  const trimmed = state.trim();
  switch (trimmed) {
    case "enrolled":
      return state.replace(trimmed, green(trimmed));
    case "expired":
    case "revoked":
      return state.replace(trimmed, red(trimmed));
    default:
      return state;
  }
}

function colorWorkerStatus(status: string): string {
  const trimmed = status.trim();
  switch (trimmed) {
    case "idle":
      return status.replace(trimmed, green(trimmed));
    case "busy":
      return status.replace(trimmed, cyan(trimmed));
    case "disconnected":
      return status.replace(trimmed, red(trimmed));
    case "unverified":
    case "draining":
      return status.replace(trimmed, yellow(trimmed));
    default:
      return status;
  }
}

/**
 * Renders the result of minting an enrollment token. The plaintext is
 * printed exactly once — it lives only in the vault afterwards.
 */
export function renderWorkerTokenCreate(
  data: WorkerTokenCreateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const lines = [
    `${bold(cyan("Token:"))} ${bold(data.name)}`,
    `${bold(cyan("Expires:"))} ${data.expiresAt}`,
    ...(data.maxEnrollments !== 1
      ? [`${bold(cyan("Max enrollments:"))} ${data.maxEnrollments}`]
      : []),
    `${bold(cyan("Vault:"))} ${data.vaultRef.vaultName} ${
      dim(`(key ${data.vaultRef.secretKey})`)
    }`,
    "",
    `  ${bold(data.token)}`,
    "",
    yellow(
      "This token is shown once and will not be displayed again — store it now.",
    ),
  ];
  writeOutput(lines.join("\n"));
}

/**
 * Renders the enrollment token list. JSON mode emits the array of records.
 */
export function renderWorkerTokenList(
  data: WorkerTokenListData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data.tokens, null, 2));
    return;
  }
  if (data.tokens.length === 0) {
    writeOutput(
      [
        "No enrollment tokens found.",
        dim("Mint one with: swamp worker token create <name> --duration 24h"),
      ].join("\n"),
    );
    return;
  }
  const rows = data.tokens.map((token) => {
    let enrollment: string;
    if (token.maxEnrollments === 1) {
      enrollment = token.bindings[0]?.machineId ?? "-";
    } else {
      const allowance = token.maxEnrollments === "unlimited"
        ? "unlimited"
        : String(token.maxEnrollments);
      enrollment = `${token.bindingCount} / ${allowance}`;
    }
    return [
      token.name,
      token.effectiveState,
      token.expiresAt,
      enrollment,
    ];
  });
  const lines = tableLines(
    ["NAME", "STATE", "EXPIRES", "ENROLLMENTS"],
    rows,
    (column, value) => (column === 1 ? colorTokenState(value) : value),
  );
  writeOutput(lines.join("\n"));
}

/**
 * Renders the result of revoking an enrollment token.
 */
export function renderWorkerTokenRevoke(
  data: WorkerTokenRevokeData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data.alreadyRevoked) {
    writeOutput(`Token ${bold(data.name)} was already revoked.`);
    return;
  }
  const lines = [`${green(checkmark)} Token ${bold(data.name)} revoked.`];
  if (data.revokedAt) {
    lines.push(`${bold(cyan("Revoked at:"))} ${data.revokedAt}`);
  }
  writeOutput(lines.join("\n"));
}

/** Formats worker labels as comma-joined key=value pairs. */
function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "-";
  return entries.map(([key, value]) => `${key}=${value}`).join(",");
}

/**
 * Renders the worker pool list. JSON mode emits the array of records.
 */
export function renderWorkerList(
  data: WorkerListData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data.workers, null, 2));
    return;
  }
  if (data.workers.length === 0) {
    writeOutput(
      [
        "No workers found.",
        dim(
          "Workers appear here after enrolling with: swamp worker token create <name> --duration 24h",
        ),
      ].join("\n"),
    );
    return;
  }
  const rows = data.workers.map((worker) => [
    worker.name,
    worker.status,
    formatLabels(worker.labels),
    `${worker.platform}/${worker.arch}`,
    worker.lastSeenAt,
  ]);
  const lines = tableLines(
    ["NAME", "STATUS", "LABELS", "PLATFORM/ARCH", "LAST SEEN"],
    rows,
    (column, value) => (column === 1 ? colorWorkerStatus(value) : value),
  );
  writeOutput(lines.join("\n"));
  if (data.workers.some((w) => w.status === "unverified")) {
    writeOutput(
      dim(
        "Some workers are unverified — run 'swamp worker verify' to diagnose.",
      ),
    );
  }
  if (data.workers.some((w) => w.status === "draining")) {
    writeOutput(
      dim(
        "Some workers are draining — they will exit after finishing any in-flight work.",
      ),
    );
  }
}

function formatAge(ms: number): string {
  if (ms < 1_000) return "<1s";
  if (ms < 60_000) return `${Math.floor(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h${
    Math.floor((ms % 3_600_000) / 60_000)
  }m`;
}

export function renderWorkerQueue(
  data: WorkerQueueListData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data.items, null, 2));
    return;
  }
  if (data.items.length === 0) {
    writeOutput("No steps are currently queued.");
    return;
  }
  const rows = data.items.map((item) => [
    item.requirement,
    item.stepName ?? `${item.modelType}.${item.methodName}`,
    item.modelType,
    item.queuedAt,
    formatAge(item.ageMs),
  ]);
  const lines = tableLines(
    ["REQUIREMENT", "STEP", "MODEL", "QUEUED AT", "AGE"],
    rows,
  );
  writeOutput(lines.join("\n"));
}

/**
 * Renders worker dial-home status events as they happen. Log mode is a
 * line-per-event stream (the command runs until shutdown); json mode emits
 * one JSON object per line for machine consumption.
 */
export function renderWorkerStatus(
  event: WorkerStatusEvent,
  mode: OutputMode,
): void {
  if (mode === "json") {
    writeOutput(JSON.stringify(event));
    return;
  }
  switch (event.kind) {
    case "connecting":
      writeOutput(
        dim(`Connecting to ${event.url} (attempt ${event.attempt})...`),
      );
      break;
    case "enrolled":
      writeOutput(
        `${green(checkmark)} Enrolled as ${bold(cyan(event.workerId))}`,
      );
      break;
    case "disconnected":
      writeOutput(yellow(`Disconnected: ${event.reason}`));
      break;
    case "retrying":
      writeOutput(dim(`Reconnecting in ${Math.round(event.delayMs / 1000)}s`));
      break;
    case "stopped":
      writeOutput(dim(`Worker stopped: ${humanStopReason(event.reason)}`));
      break;
    case "draining":
      writeOutput(
        yellow(
          `Draining (${
            humanStopReason(event.reason)
          }) — finishing in-flight work...`,
        ),
      );
      break;
    case "drain_complete":
      writeOutput(dim("Drain complete — disconnecting"));
      break;
    case "dispatch_started": {
      const where = event.workflowName
        ? ` (${event.workflowName}${
          event.stepName ? ` › ${event.stepName}` : ""
        })`
        : "";
      writeOutput(
        `${cyan("▶")} Dispatch ${bold(event.dispatchId.slice(0, 8))}: ${
          bold(`${event.modelType}.${event.methodName}`)
        }${where}`,
      );
      break;
    }
    case "dispatch_finished": {
      const took = `${Math.round(event.durationMs)}ms`;
      if (event.status === "success") {
        writeOutput(
          `${green(checkmark)} Dispatch ${
            bold(event.dispatchId.slice(0, 8))
          }: ${event.modelType}.${event.methodName} succeeded in ${took}`,
        );
      } else {
        writeOutput(
          `${red("✗")} Dispatch ${
            bold(event.dispatchId.slice(0, 8))
          }: ${event.modelType}.${event.methodName} failed in ${took}${
            event.error ? ` — ${event.error}` : ""
          }`,
        );
      }
      break;
    }
  }
}

/**
 * Renders fleet probe verification results. JSON mode emits the full
 * structured response; log mode shows a per-worker pass/fail table.
 */
export function renderWorkerVerify(
  data: WorkerVerifyData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data.workers.length === 0) {
    writeOutput(
      dim("No connected workers found to verify."),
    );
    return;
  }
  const rows = data.workers.map((w) => {
    const statusLabel = w.status === "pass"
      ? checkmark + " pass"
      : w.status === "fail"
      ? "✗ fail"
      : "! error";
    const detail = w.status === "error"
      ? (w.error ?? "")
      : (w.failures ?? []).join("; ");
    return [w.name, statusLabel, w.platform ?? "-", w.arch ?? "-", detail];
  });
  const lines = tableLines(
    ["WORKER", "STATUS", "PLATFORM", "ARCH", "DETAILS"],
    rows,
    (col, value) => {
      if (col !== 1) return value;
      if (value.includes("pass")) return green(value);
      if (value.includes("fail")) return red(value);
      return yellow(value);
    },
  );
  writeOutput(lines.join("\n"));
  writeOutput("");
  if (data.passed === data.total) {
    writeOutput(green(`All ${data.total} worker(s) passed verification.`));
  } else {
    const failCount = data.workers.filter((w) => w.status === "fail").length;
    const errorCount = data.workers.filter((w) => w.status === "error").length;
    const parts: string[] = [];
    if (failCount > 0) parts.push(`${failCount} failed`);
    if (errorCount > 0) parts.push(`${errorCount} unreachable`);
    writeOutput(
      red(
        `${
          parts.join(", ")
        } of ${data.total} worker(s) did not pass verification.`,
      ),
    );
  }
}
