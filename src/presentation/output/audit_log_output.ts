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

  const headers = [
    "TIME",
    "OUTCOME",
    "CATEGORY",
    "ACTION",
    "PRINCIPAL",
    "RESOURCE",
  ];
  writeOutput(bold(dim(
    headers.map((h, i) => {
      const widths = [16, 9, 12, 30, 20, 30];
      return h.padEnd(widths[i]);
    }).join("  "),
  )));

  for (const event of data.events) {
    const e = event as Record<string, string>;
    const time = formatTimestamp(e.timestamp ?? "");
    const outcome = outcomeColor(e.outcome ?? "");
    const category = e.category ?? "";
    const action = e.action ?? "";
    const principal = e.principalId ?? "";
    const resource = `${e.resourceKind ?? ""}:${e.resourceName ?? ""}`;

    writeOutput(
      `${dim(time.padEnd(16))}  ${
        outcome.padEnd(9 + (outcome.length - (e.outcome ?? "").length))
      }  ${category.padEnd(12)}  ${action.padEnd(30)}  ${
        principal.padEnd(20)
      }  ${resource}`,
    );
  }

  if (data.total !== undefined) {
    writeOutput("");
    writeOutput(
      dim(`Showing ${data.events.length} of ${data.total} events`) +
        (data.cursor ? dim(` (more available)`) : ""),
    );
  }
}
