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
import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { AuditTimeline } from "../../domain/audit/audit_service.ts";
import { auditEntryToData } from "../../domain/audit/audit_entry.ts";

const logger = getSwampLogger(["audit"]);

/**
 * Renders the audit timeline.
 */
export function renderAuditTimeline(
  timeline: AuditTimeline,
  mode: OutputMode,
): void {
  if (mode === "json") {
    const data = {
      entries: timeline.entries.map(auditEntryToData),
      totalSwamp: timeline.totalSwamp,
      totalDirect: timeline.totalDirect,
      hoursAnalyzed: timeline.hoursAnalyzed,
    };
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // Log mode: formatted table
  logger.info(
    `Audit timeline (last ${timeline.hoursAnalyzed}h): ${timeline.totalSwamp} swamp, ${timeline.totalDirect} direct`,
  );

  if (timeline.entries.length === 0) {
    logger.info("No commands found in the requested time range.");
    return;
  }

  // Print header
  console.log(
    bold(
      `${"Time".padEnd(12)} ${"Source".padEnd(8)} ${"Summary"}`,
    ),
  );
  console.log(dim("-".repeat(60)));

  for (const entry of timeline.entries) {
    const time = formatTime(entry.timestamp);
    const source = entry.source === "swamp"
      ? cyan("swamp".padEnd(8))
      : yellow("direct".padEnd(8));

    // Truncate long commands for display
    const maxSummaryLen = 60;
    const summary = entry.summary.length > maxSummaryLen
      ? entry.summary.substring(0, maxSummaryLen - 3) + "..."
      : entry.summary;

    console.log(`${dim(time.padEnd(12))} ${source} ${summary}`);

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
      console.log(`${indent}${red(`ERROR (${exitCodeStr}): ${errorMsg}`)}`);
    }
  }
}

/**
 * Renders a message when no audit data is found.
 */
export function renderNoAuditData(mode: OutputMode): void {
  if (mode === "json") {
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
  } else {
    logger.info(
      "No audit data found. Run 'swamp repo init --force' to enable the audit hook.",
    );
  }
}

/**
 * Renders a warning when the configured tool does not support audit hooks.
 */
export function renderAuditToolNotSupported(
  tool: string,
  mode: OutputMode,
): void {
  const message = `Audit hooks are not available for ${tool}. ${
    tool === "codex"
      ? "Codex does not support per-command hooks."
      : `${tool} does not support audit hooks.`
  } Audit data will not be collected for this tool.`;

  if (mode === "json") {
    console.log(
      JSON.stringify(
        { supported: false, tool, message },
        null,
        2,
      ),
    );
  } else {
    logger.info(message);
  }
}

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
