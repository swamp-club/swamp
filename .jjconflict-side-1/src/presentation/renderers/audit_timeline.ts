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

import { bold, cyan, dim, red, yellow } from "@std/fmt/colors";
import type { AuditTimelineEvent, EventHandlers } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import {
  getSwampLogger,
  writeOutput,
} from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import type { AuditEntry } from "../../domain/audit/audit_entry.ts";
import { auditEntryToData } from "../../domain/audit/audit_entry.ts";

/**
 * Formats an ISO timestamp to a short time string (HH:MM:SS).
 */
function formatTime(isoTimestamp: string): string {
  try {
    const date = new Date(isoTimestamp);
    return date.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return isoTimestamp.substring(11, 19);
  }
}

/**
 * Renders the formatted audit timeline table.
 */
function renderTimelineTable(
  entries: readonly AuditEntry[],
  hoursAnalyzed: number,
  totalSwamp: number,
  totalDirect: number,
): void {
  const logger = getSwampLogger(["audit"]);
  logger.info(
    `Audit timeline (last ${hoursAnalyzed}h): ${totalSwamp} swamp, ${totalDirect} direct`,
  );

  if (entries.length === 0) {
    logger.info("No commands found in the requested time range.");
    return;
  }

  // Print header
  writeOutput(
    bold(
      `${"Time".padEnd(12)} ${"Source".padEnd(8)} ${"Summary"}`,
    ),
  );
  writeOutput(dim("-".repeat(60)));

  for (const entry of entries) {
    const time = formatTime(entry.timestamp);
    const source = entry.source === "swamp"
      ? cyan("swamp".padEnd(8))
      : yellow("direct".padEnd(8));

    // Truncate long commands for display
    const maxSummaryLen = 60;
    const summary = entry.summary.length > maxSummaryLen
      ? entry.summary.substring(0, maxSummaryLen - 3) + "..."
      : entry.summary;

    writeOutput(`${dim(time.padEnd(12))} ${source} ${summary}`);

    // Show error details on a second line for failed commands
    if (entry.status === "error" && entry.error) {
      const exitCodeStr = entry.exitCode !== undefined
        ? `exit ${entry.exitCode}`
        : "failed";
      const maxErrorLen = 50;
      const errorMsg = entry.error.length > maxErrorLen
        ? entry.error.substring(0, maxErrorLen - 3) + "..."
        : entry.error;
      const indent = " ".repeat(21);
      writeOutput(`${indent}${red(`ERROR (${exitCodeStr}): ${errorMsg}`)}`);
    }
  }
}

class LogAuditTimelineRenderer implements Renderer<AuditTimelineEvent> {
  handlers(): EventHandlers<AuditTimelineEvent> {
    const logger = getSwampLogger(["audit"]);
    return {
      completed: (e) => {
        const data = e.data;
        switch (data.status) {
          case "timeline":
            renderTimelineTable(
              data.timeline.entries,
              data.timeline.hoursAnalyzed,
              data.timeline.totalSwamp,
              data.timeline.totalDirect,
            );
            break;
          case "no_data":
            logger.info(
              "No audit data found. Run 'swamp repo init --force' to enable the audit hook.",
            );
            break;
          case "tool_not_supported": {
            const message = `Audit hooks are not available for ${data.tool}. ${
              data.tool === "codex"
                ? "Codex does not support per-command hooks."
                : `${data.tool} does not support audit hooks.`
            } Audit data will not be collected for this tool.`;
            logger.info(message);
            break;
          }
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonAuditTimelineRenderer implements Renderer<AuditTimelineEvent> {
  handlers(): EventHandlers<AuditTimelineEvent> {
    return {
      completed: (e) => {
        const data = e.data;
        switch (data.status) {
          case "timeline": {
            const jsonData = {
              entries: data.timeline.entries.map(auditEntryToData),
              totalSwamp: data.timeline.totalSwamp,
              totalDirect: data.timeline.totalDirect,
              hoursAnalyzed: data.timeline.hoursAnalyzed,
            };
            console.log(JSON.stringify(jsonData, null, 2));
            break;
          }
          case "no_data":
            console.log(
              JSON.stringify(
                {
                  message:
                    "No audit data found. Run 'swamp repo init --force' to enable the audit hook.",
                },
                null,
                2,
              ),
            );
            break;
          case "tool_not_supported":
            console.log(
              JSON.stringify(
                {
                  supported: false,
                  tool: data.tool,
                  message: `Audit hooks are not available for ${data.tool}. ${
                    data.tool === "codex"
                      ? "Codex does not support per-command hooks."
                      : `${data.tool} does not support audit hooks.`
                  } Audit data will not be collected for this tool.`,
                },
                null,
                2,
              ),
            );
            break;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createAuditTimelineRenderer(
  mode: OutputMode,
): Renderer<AuditTimelineEvent> {
  switch (mode) {
    case "json":
      return new JsonAuditTimelineRenderer();
    case "log":
      return new LogAuditTimelineRenderer();
  }
}
