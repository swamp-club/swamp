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

import { bold, cyan, dim, green, red, yellow } from "@std/fmt/colors";
import {
  escapeControlCharacters as esc,
  escapeControlCharactersInText,
} from "../../domain/control_characters.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type {
  PrunableWorker,
  WorkerPruneResult,
} from "../../libswamp/worker/prune.ts";
import type {
  WorkerListData,
  WorkerTokenListData,
} from "../../libswamp/worker/list.ts";
import type { WorkerQueueListData } from "../../libswamp/worker/queue_list.ts";
import type { WorkerTokenCreateData } from "../../libswamp/worker/token_create.ts";
import type { WorkerTokenRevokeData } from "../../libswamp/worker/token_revoke.ts";
import type { WorkerTokenRotateData } from "../../libswamp/worker/token_rotate.ts";
import { ROTATION_HEADROOM_MS } from "../../domain/models/worker/enrollment_token_model.ts";
import type { WorkerTokenRevealData } from "../../libswamp/worker/token_reveal.ts";
import type { WorkerStatusEvent } from "../../worker/connect.ts";
import type { WorkerVerifyData } from "../../serve/protocol.ts";
import type { OutputMode } from "./output.ts";

const checkmark = "\u2713";

function humanStopReason(reason: string): string {
  switch (reason) {
    case "max-dispatches":
      return "reached max dispatches";
    case "idle-timeout":
      return "idle timeout elapsed";
    case "signal":
      return "received shutdown signal";
    default:
      return esc(reason);
  }
}

function tableLines(
  headers: string[],
  rawRows: string[][],
  colorCell?: (columnIndex: number, value: string) => string,
): string[] {
  const rows = rawRows.map((row) => row.map((cell) => esc(String(cell))));
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
 * the plaintext token prints exactly once; afterwards it lives only in the
 * vault
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
    `${bold(cyan("Token:"))} ${bold(esc(data.name))}`,
    `${bold(cyan("Expires:"))} ${esc(data.expiresAt)}`,
    ...(data.maxEnrollments !== 1
      ? [
        `${bold(cyan("Max enrollments:"))} ${esc(String(data.maxEnrollments))}`,
      ]
      : []),
    // an older serve sends no labels
    ...(Object.keys(data.labels ?? {}).length > 0
      ? [`${bold(cyan("Labels:"))} ${esc(formatTokenLabels(data.labels))}`]
      : []),
    `${bold(cyan("Vault:"))} ${esc(data.vaultRef.vaultName)} ${
      dim(`(key ${esc(data.vaultRef.secretKey)})`)
    }`,
    "",
    `  ${bold(esc(data.token))}`,
    "",
    yellow(
      "This token is shown once and will not be displayed again — store it now.",
    ),
  ];
  writeOutput(lines.join("\n"));
}

function formatTokenLabels(labels: Record<string, string> | undefined): string {
  const pairs = Object.entries(labels ?? {}).map(([key, value]) =>
    `${key}=${value}`
  );
  return pairs.length > 0 ? pairs.join(",") : "-";
}

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
      formatTokenLabels(token.labels),
    ];
  });
  const lines = tableLines(
    ["NAME", "STATE", "EXPIRES", "ENROLLMENTS", "LABELS"],
    rows,
    (column, value) => (column === 1 ? colorTokenState(value) : value),
  );
  writeOutput(lines.join("\n"));
}

export function renderWorkerTokenRevoke(
  data: WorkerTokenRevokeData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const name = esc(data.name);
  const lines = data.alreadyRevoked
    ? [`Token ${bold(name)} was already revoked.`]
    : [`${green(checkmark)} Token ${bold(name)} revoked.`];
  if (!data.alreadyRevoked && data.revokedAt) {
    lines.push(`${bold(cyan("Revoked at:"))} ${esc(data.revokedAt)}`);
  }
  if (data.disconnectedWorkers === undefined) {
    // A local revoke cannot see the live pool; a running orchestrator
    // catches it on its next token revalidation pass.
    if (!data.alreadyRevoked) {
      lines.push(
        dim(
          "A running orchestrator disconnects workers on this token at its next token check (about every 30 seconds).",
        ),
      );
    }
  } else if (data.disconnectedWorkers.length > 0) {
    lines.push(
      `${bold(cyan("Disconnected workers:"))} ${
        data.disconnectedWorkers.map((worker) => bold(esc(worker))).join(", ")
      }`,
    );
  } else if (!data.alreadyRevoked) {
    lines.push(dim("No connected workers were enrolled on this token."));
  }
  writeOutput(lines.join("\n"));
}

export function renderWorkerTokenRotate(
  data: WorkerTokenRotateData,
  mode: OutputMode,
  nowMs: number = Date.now(),
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const rawOldUntil = data.predecessorExpiresAt ?? data.expiresAt;
  const oldUntil = esc(rawOldUntil);
  const lines = [
    `${green(checkmark)} Token ${bold(esc(data.name))} rotated.`,
    `${bold(cyan("Expires:"))} ${esc(data.expiresAt)}`,
  ];
  if (data.predecessorExpiresAt !== null) {
    lines.push(
      `${bold(cyan("Old token valid until:"))} ${
        esc(data.predecessorExpiresAt)
      }`,
    );
  }
  if (
    !data.delivered &&
    Date.parse(rawOldUntil) - nowMs < ROTATION_HEADROOM_MS
  ) {
    // never suggest rotating again: a second rotation retires the old token
    lines.push(
      yellow(
        `No connected worker was sent the new token by this command, and the old token expires at ${oldUntil}, likely before a running orchestrator's next token check can deliver it. Restart connected workers with the new token now. Next time, rotate with --server, which delivers at once.`,
      ),
    );
  } else if (!data.delivered) {
    // never suggest rotating again: a second rotation retires the old token
    lines.push(
      yellow(
        `No connected worker was sent the new token by this command. A running orchestrator sends it to them at its next token check, about every 30 seconds; rotating again before then retires the old token they hold. With no orchestrator running, workers keep the old token until ${oldUntil}; restart them with the new token before then.`,
      ),
    );
  }
  if (data.rotated.length > 0 || data.notRotated.length > 0) {
    lines.push(`${bold(cyan("Workers:"))}`);
  } else if (data.delivered) {
    lines.push(dim("No connected workers were enrolled on this token."));
  }
  for (const worker of data.rotated) {
    lines.push(
      worker.persisted
        ? `  ${green(checkmark)} ${bold(esc(worker.worker))} rotated`
        : `  ${yellow("!")} ${
          bold(esc(worker.worker))
        } rotated in memory only ${
          dim(
            "(no token file was written; after a restart it does not have the new token)",
          )
        }`,
    );
  }
  for (const worker of data.notRotated) {
    lines.push(
      `  ${red("✗")} ${bold(esc(worker.worker))} not rotated ${
        dim(`(${esc(worker.reason)})`)
      }`,
    );
  }
  if (data.unconnectedBindings !== null && data.unconnectedBindings > 0) {
    lines.push(
      dim(
        `${
          esc(String(data.unconnectedBindings))
        } enrolled machine(s) not connected — they can enroll with the old token until ${oldUntil}.`,
      ),
    );
  }
  if (data.retiredBindings !== null && data.retiredBindings > 0) {
    lines.push(
      yellow(
        `${
          esc(String(data.retiredBindings))
        } enrolled machine(s) not connected still hold a token an earlier rotation retired — they need the new token to enroll.`,
      ),
    );
  }
  const leftBehind = !data.delivered || data.notRotated.length > 0 ||
    data.rotated.some((worker) => !worker.persisted) ||
    (data.unconnectedBindings ?? 0) > 0 || (data.retiredBindings ?? 0) > 0;
  lines.push(
    "",
    `  ${bold(esc(data.token))}`,
    "",
    yellow("The new token is shown once — store it now."),
  );
  if (leftBehind) {
    lines.push(
      dim(
        "Give it to hosts that were not rotated: swamp worker connect <url> --token-file <file>",
      ),
    );
  }
  writeOutput(lines.join("\n"));
}

export function renderWorkerTokenReveal(
  data: WorkerTokenRevealData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    // the secret goes straight to stdout, never through the logger
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  writeOutput(`${bold(cyan("Token:"))} ${bold(esc(data.name))}`);
  writeOutput(`${bold(cyan("Expires:"))} ${esc(data.expiresAt)}`);
  if (data.expired) {
    writeOutput(yellow("Warning: this token has expired."));
  }
  console.log(`\n  ${bold(esc(data.token))}\n`);
  writeOutput(
    yellow("Store this token securely — do not share it in logs or messages."),
  );
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "-";
  return entries.map(([key, value]) => `${key}=${value}`).join(",");
}

export function renderWorkerList(
  data: WorkerListData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (data.workers.length === 0) {
    if (data.filteredDisconnectedCount) {
      writeOutput(
        [
          "No connected workers found.",
          dim(
            `${esc(String(data.filteredDisconnectedCount))} disconnected ${
              data.filteredDisconnectedCount === 1 ? "worker" : "workers"
            } hidden — use 'swamp worker list --all' to show all.`,
          ),
        ].join("\n"),
      );
    } else {
      writeOutput(
        [
          "No workers found.",
          dim(
            "Workers appear here after enrolling with: swamp worker token create <name> --duration 24h",
          ),
        ].join("\n"),
      );
    }
    return;
  }
  const rows = data.workers.map((worker) => {
    const load = `${worker.activeDispatchIds.length}/${worker.capacity}`;
    return [
      worker.name,
      worker.status,
      load,
      formatLabels(worker.labels),
      `${worker.platform}/${worker.arch}`,
      worker.lastSeenAt,
    ];
  });
  const lines = tableLines(
    ["NAME", "STATUS", "SLOTS", "LABELS", "PLATFORM/ARCH", "LAST SEEN"],
    rows,
    (column, value) => (column === 1 ? colorWorkerStatus(value) : value),
  );
  writeOutput(lines.join("\n"));
  if (data.filteredDisconnectedCount) {
    writeOutput(
      dim(
        `${esc(String(data.filteredDisconnectedCount))} disconnected ${
          data.filteredDisconnectedCount === 1 ? "worker" : "workers"
        } hidden — use 'swamp worker list --all' to show all.`,
      ),
    );
  }
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
    ["REQUIREMENT", "STEP", "BEHAVIOR", "QUEUED AT", "AGE"],
    rows,
  );
  writeOutput(lines.join("\n"));
}

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
        dim(
          `Connecting to ${esc(event.url)} (attempt ${
            esc(String(event.attempt))
          })...`,
        ),
      );
      break;
    case "enrolled":
      writeOutput(
        `${green(checkmark)} Enrolled as ${bold(cyan(esc(event.workerId)))}`,
      );
      break;
    case "disconnected":
      writeOutput(yellow(`Disconnected: ${esc(event.reason)}`));
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
        ? ` (${esc(event.workflowName)}${
          event.stepName ? ` › ${esc(event.stepName)}` : ""
        })`
        : "";
      writeOutput(
        `${cyan("▶")} Dispatch ${bold(esc(event.dispatchId).slice(0, 8))}: ${
          bold(esc(`${event.modelType}.${event.methodName}`))
        }${where}`,
      );
      break;
    }
    case "dispatch_finished": {
      const took = `${Math.round(event.durationMs)}ms`;
      const dispatchId = bold(esc(event.dispatchId).slice(0, 8));
      const method = esc(`${event.modelType}.${event.methodName}`);
      if (event.status === "success") {
        writeOutput(
          `${
            green(checkmark)
          } Dispatch ${dispatchId}: ${method} succeeded in ${took}`,
        );
      } else {
        writeOutput(
          `${red("✗")} Dispatch ${dispatchId}: ${method} failed in ${took}${
            event.error
              ? ` — ${escapeControlCharactersInText(event.error)}`
              : ""
          }`,
        );
      }
      break;
    }
  }
}

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
    writeOutput(
      green(`All ${esc(String(data.total))} worker(s) passed verification.`),
    );
  } else {
    const failCount = data.workers.filter((w) => w.status === "fail").length;
    const errorCount = data.workers.filter((w) => w.status === "error").length;
    const parts: string[] = [];
    if (failCount > 0) parts.push(`${failCount} failed`);
    if (errorCount > 0) parts.push(`${errorCount} unreachable`);
    writeOutput(
      red(
        `${parts.join(", ")} of ${
          esc(String(data.total))
        } worker(s) did not pass verification.`,
      ),
    );
  }
}

export function renderWorkerPrunePreview(
  workers: PrunableWorker[],
  dryRun: boolean,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ dryRun, prunable: workers }, null, 2));
    return;
  }
  if (workers.length === 0) {
    writeOutput(dim("No stale workers to prune."));
    return;
  }
  const label = dryRun ? "Would prune" : "Pruning";
  writeOutput(`${label} ${bold(String(workers.length))} worker(s):\n`);
  for (const w of workers) {
    writeOutput(
      `  ${dim("•")} ${bold(esc(w.name))} (token: ${
        esc(w.tokenName)
      }, disconnected: ${esc(w.disconnectedAt ?? "unknown")})`,
    );
  }
  writeOutput("");
}

export function renderWorkerPruneResult(
  result: WorkerPruneResult,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const parts: string[] = [];
  if (result.workersDeleted > 0) {
    parts.push(
      `${green(checkmark)} Pruned ${
        bold(String(result.workersDeleted))
      } worker(s)`,
    );
  }
  if (result.bindingsPruned > 0) {
    parts.push(
      `${green(checkmark)} Cleaned ${
        bold(String(result.bindingsPruned))
      } binding(s) from ${esc(String(result.tokensCleaned))} token(s)`,
    );
  }
  if (result.workersFailed > 0) {
    parts.push(
      `${yellow("!")} ${
        esc(String(result.workersFailed))
      } worker(s) failed to delete`,
    );
  }
  if (parts.length === 0) {
    writeOutput(dim("Nothing to prune."));
    return;
  }
  writeOutput(parts.join("\n"));
}
