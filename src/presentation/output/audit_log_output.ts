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
import type { AuditQueryResponse } from "../../serve/protocol.ts";
import type { OutputMode } from "./output.ts";

const COL_WIDTHS = [16, 9, 12, 30, 20, 30];
const HEADERS = [
  "TIME",
  "OUTCOME",
  "CATEGORY",
  "ACTION",
  "PRINCIPAL",
  "RESOURCE",
];

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${month}-${day} ${hours}:${minutes}:${seconds}`;
  } catch {
    return iso.substring(5, 19);
  }
}

function outcomeColor(outcome: string): string {
  switch (outcome) {
    case "success":
      return green(outcome);
    case "failure":
      return red(outcome);
    case "denied":
      return yellow(outcome);
    default:
      return outcome;
  }
}

function formatEventRow(e: Record<string, string>): string {
  const time = formatTimestamp(e.timestamp ?? "");
  const outcome = outcomeColor(e.outcome ?? "");
  const category = e.category ?? "";
  const action = e.action ?? "";
  const principal = e.principalId ?? "";
  const resource = `${e.resourceKind ?? ""}:${e.resourceName ?? ""}`;

  return `${dim(time.padEnd(COL_WIDTHS[0]))}  ${
    outcome.padEnd(COL_WIDTHS[1] + (outcome.length - (e.outcome ?? "").length))
  }  ${category.padEnd(COL_WIDTHS[2])}  ${action.padEnd(COL_WIDTHS[3])}  ${
    principal.padEnd(COL_WIDTHS[4])
  }  ${resource}`;
}

export function renderAuditLogHeader(mode: OutputMode): void {
  if (mode === "json") return;
  writeOutput(bold(dim(
    HEADERS.map((h, i) => h.padEnd(COL_WIDTHS[i])).join("  "),
  )));
}

export function renderAuditEvent(
  event: Record<string, string>,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(event));
    return;
  }
  writeOutput(formatEventRow(event));
}

export function renderAuditLog(
  data: AuditQueryResponse,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data.events.length === 0) {
    writeOutput("No audit events found matching the filters.");
    return;
  }

  renderAuditLogHeader(mode);

  for (const event of data.events) {
    renderAuditEvent(event as Record<string, string>, mode);
  }

  if (data.total !== undefined) {
    writeOutput("");
    if (data.cursor) {
      writeOutput(
        dim(
          `Showing ${data.events.length} of ${data.total} events — next page: --cursor ${data.cursor}`,
        ),
      );
    } else {
      writeOutput(
        dim(`Showing ${data.events.length} of ${data.total} events`),
      );
    }
  }
}
