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
  WorkerTokenCreateData,
  WorkerTokenListData,
  WorkerTokenRevokeData,
} from "../../libswamp/mod.ts";
import type { OutputMode } from "./output.ts";

const checkmark = "\u2713"; // ✓

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
  const rows = data.tokens.map((token) => [
    token.name,
    token.effectiveState,
    token.expiresAt,
    token.boundInstanceUuid ?? "-",
  ]);
  const lines = tableLines(
    ["NAME", "STATE", "EXPIRES", "BOUND INSTANCE"],
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
}
