// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { bold, cyan, dim, green, yellow } from "@std/fmt/colors";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "./output.ts";

export function renderDeviceVerification(deviceCode: string): void {
  const lines = renderCard(
    bold("Verify your device"),
    [[{ label: "Code", value: bold(yellow(deviceCode)) }]],
  );
  lines.push("");
  lines.push(
    "  Confirm this code matches in your browser before signing in.",
  );

  writeOutput(lines.join("\n"));
}

export interface AuthLoginSuccessData {
  username: string;
  email?: string;
  name?: string;
  serverUrl: string;
  apiKey: string;
}

export function renderAuthLoginSuccess(
  data: AuthLoginSuccessData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(
      {
        authenticated: true,
        serverUrl: data.serverUrl,
        username: data.username,
      },
      null,
      2,
    ));
  } else {
    // Identity rows
    const identity: CardRow[] = [
      { label: "User", value: bold(`@${data.username}`) },
    ];
    if (data.name) {
      identity.push({ label: "Name", value: data.name });
    }
    if (data.email) {
      identity.push({ label: "Email", value: data.email });
    }

    // Session rows
    const session: CardRow[] = [
      { label: "Server", value: data.serverUrl },
      { label: "Key", value: maskApiKey(data.apiKey) },
    ];

    const lines = renderCard(
      `${green("✔")} ${bold("Authenticated")}`,
      [identity, session],
    );

    writeOutput(lines.join("\n"));
  }
}

interface CardRow {
  label: string;
  value: string;
}

/** Mask an API key, showing prefix and last 4 chars. */
function maskApiKey(key: string): string {
  if (key.length <= 16) return key.slice(0, 8) + dim("•••");
  return key.slice(0, 12) + dim("•••") + key.slice(-4);
}

/**
 * Render a box-drawn card with a header and grouped rows.
 * Uses double-line box drawing for the outer frame and a
 * single-line divider between header and body.
 */
function renderCard(
  header: string,
  groups: CardRow[][],
): string[] {
  // Calculate widths from raw text (before ANSI codes)
  const allRows = groups.flat();
  const labelWidth = Math.max(...allRows.map((r) => r.label.length));
  // Row content: "  label   value  " = 2 + labelWidth + 3 + valueWidth + 2
  // We need the visual width for the box, but values may contain ANSI codes.
  // Use a fixed minimum + the longest raw label to keep things aligned,
  // then let the right border float based on actual content.

  // For the header, we need enough width for the header text too.
  // Since values contain ANSI codes, we calculate the raw visible width.
  const rawValueWidth = Math.max(
    ...allRows.map((r) => stripAnsi(r.value).length),
  );
  const headerTextWidth = stripAnsi(header).length;
  const rowInnerWidth = 2 + labelWidth + 3 + rawValueWidth + 2;
  const contentWidth = Math.max(rowInnerWidth, headerTextWidth + 4);

  const lines: string[] = [];

  // Top border
  lines.push(green(`  ╔${"═".repeat(contentWidth)}╗`));

  // Header
  const headerPad = " ".repeat(contentWidth - headerTextWidth - 2);
  lines.push(green("  ║") + `  ${header}${headerPad}` + green("║"));

  // Divider
  lines.push(green(`  ╠${"═".repeat(contentWidth)}╣`));

  // Body groups
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];

    // Spacer before each group
    lines.push(green("  ║") + " ".repeat(contentWidth) + green("║"));

    for (const row of group) {
      const paddedLabel = row.label.padEnd(labelWidth);
      const visibleValueLen = stripAnsi(row.value).length;
      const valuePad = " ".repeat(rawValueWidth - visibleValueLen);
      // Extra padding if contentWidth > rowInnerWidth
      const extraPad = " ".repeat(contentWidth - rowInnerWidth);
      lines.push(
        green("  ║") + "  " + bold(cyan(paddedLabel)) + "   " + row.value +
          valuePad + extraPad + "  " + green("║"),
      );
    }

    // Spacer after last group
    if (gi === groups.length - 1) {
      lines.push(green("  ║") + " ".repeat(contentWidth) + green("║"));
    }
  }

  // Bottom border
  lines.push(green(`  ╚${"═".repeat(contentWidth)}╝`));

  return lines;
}

/** Strip ANSI escape codes to get visible character length. */
function stripAnsi(str: string): string {
  // deno-lint-ignore no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}
