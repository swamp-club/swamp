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
 * Render functions for the `swamp access token` command group. Each supports
 * both "log" (human-readable) and "json" (structured) output modes per the
 * terminal-output design system.
 */

import { bold, cyan, dim, green, red, yellow } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type {
  ServerTokenCreateData,
  ServerTokenListData,
  ServerTokenRevokeData,
  ServerTokenRotateData,
} from "../../libswamp/mod.ts";
import type { OutputMode } from "./output.ts";

const checkmark = "✓";

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
    case "active":
      return state.replace(trimmed, green(trimmed));
    case "expired":
    case "revoked":
      return state.replace(trimmed, red(trimmed));
    default:
      return state;
  }
}

export function renderServerTokenCreate(
  data: ServerTokenCreateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const lines = [
    `${bold(cyan("Token:"))} ${bold(data.name)}`,
    `${bold(cyan("Principal:"))} ${data.principalId}`,
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

export function renderServerTokenList(
  data: ServerTokenListData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data.tokens, null, 2));
    return;
  }
  if (data.tokens.length === 0) {
    writeOutput(
      [
        "No server tokens found.",
        dim(
          "Mint one with: swamp access token mint <name> --principal user:<id>",
        ),
      ].join("\n"),
    );
    return;
  }
  const rows = data.tokens.map((token) => [
    token.name,
    token.effectiveState,
    token.principalId,
    token.expiresAt,
    token.lastUsedAt ?? "-",
  ]);
  const lines = tableLines(
    ["NAME", "STATE", "PRINCIPAL", "EXPIRES", "LAST USED"],
    rows,
    (column, value) => (column === 1 ? colorTokenState(value) : value),
  );
  writeOutput(lines.join("\n"));
}

export function renderServerTokenRevoke(
  data: ServerTokenRevokeData,
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

export function renderServerTokenRotate(
  data: ServerTokenRotateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const lines = [
    `${green(checkmark)} Token ${bold(data.name)} rotated.`,
    `${bold(cyan("Principal:"))} ${data.principalId}`,
    `${bold(cyan("Expires:"))} ${data.expiresAt}`,
    `${bold(cyan("Vault:"))} ${data.vaultRef.vaultName} ${
      dim(`(key ${data.vaultRef.secretKey})`)
    }`,
    "",
    `  ${bold(data.token)}`,
    "",
    yellow(
      "Previous token has been revoked. Store the new token now — it will not be shown again.",
    ),
  ];
  writeOutput(lines.join("\n"));
}
