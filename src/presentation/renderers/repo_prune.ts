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

import { bold, cyan, dim, green, yellow } from "@std/fmt/colors";
import type { EventHandlers } from "../../libswamp/stream.ts";
import type {
  RepoPruneEvent,
  RepoPruneItem,
  RepoPrunePreview,
  RepoPruneSkip,
} from "../../libswamp/repo/prune.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { resolvePrimaryTool } from "../../domain/repo/primary_tool.ts";

function formatTools(tools: readonly string[]): string {
  return tools.length === 0 ? "none" : tools.join(", ");
}

/**
 * an empty enrolled list may be a legacy marker whose implicit tool is still in
 * use, so pruning that tool's settings would stop audit recording
 */
export function reenrollHint(
  enrolledTools: readonly string[],
  leftoverTools: readonly string[],
  afterPrune = false,
): string | null {
  const implicit = resolvePrimaryTool(null);
  if (enrolledTools.length > 0 || !leftoverTools.includes(implicit)) {
    return null;
  }
  const command = `\`swamp repo upgrade --tool ${implicit}\``;
  return afterPrune
    ? `If you still use ${implicit}, run ${command} to restore them.`
    : `If you still use ${implicit}, enroll it with ${command} instead of pruning.`;
}

function formatPruneLines(
  heading: string,
  enrolledTools: readonly string[],
  items: readonly RepoPruneItem[],
  skipped: readonly RepoPruneSkip[],
  willDelete: boolean,
): string[] {
  const lines: string[] = [];
  if (items.length === 0) {
    lines.push(
      `No swamp settings to prune for tools that are not enrolled ${
        dim(`(enrolled: ${formatTools(enrolledTools)})`)
      }`,
    );
  } else {
    lines.push(
      `${bold(cyan(heading))} ${
        dim(`(enrolled: ${formatTools(enrolledTools)})`)
      }`,
    );
    for (const item of items) {
      const verb = item.action === "delete"
        ? (willDelete ? "delete" : "deleted")
        : (willDelete ? "edit" : "edited");
      // a check mark would read as done, so a preview gets a plain bullet
      const mark = willDelete ? dim("•") : green("✓");
      lines.push(
        `  ${mark} ${bold(item.path)} ${dim(`${verb} (${item.tool})`)}`,
      );
      for (const removed of item.removed) {
        lines.push(`      ${dim("-")} ${removed}`);
      }
    }
    const hint = reenrollHint(
      enrolledTools,
      items.map((i) => i.tool),
      !willDelete,
    );
    if (hint !== null) lines.push(`  ${yellow("⚠")} ${hint}`);
  }
  if (skipped.length > 0) {
    lines.push("");
    lines.push(cyan("Skipped:"));
    for (const skip of skipped) {
      lines.push(
        `  ${yellow("⚠")} ${bold(skip.path)} ${dim(`(${skip.tool})`)} ${
          dim("-")
        } ${skip.reason}`,
      );
    }
  }
  return lines;
}

class LogRepoPruneRenderer implements Renderer<RepoPruneEvent> {
  handlers(): EventHandlers<RepoPruneEvent> {
    return {
      pruning: () => {},
      completed: (e) => {
        const data = e.data;
        writeOutput(
          formatPruneLines(
            data.dryRun
              ? "Would prune swamp settings for tools not enrolled:"
              : "Pruned swamp settings for tools not enrolled:",
            data.enrolledTools,
            data.pruned,
            data.skipped,
            data.dryRun,
          ).join("\n"),
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonRepoPruneRenderer implements Renderer<RepoPruneEvent> {
  handlers(): EventHandlers<RepoPruneEvent> {
    return {
      pruning: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createRepoPruneRenderer(
  mode: OutputMode,
): Renderer<RepoPruneEvent> {
  switch (mode) {
    case "json":
      return new JsonRepoPruneRenderer();
    case "log":
      return new LogRepoPruneRenderer();
  }
}

/** log mode only: the plan shown before the confirmation prompt */
export function renderRepoPrunePreview(preview: RepoPrunePreview): void {
  writeOutput(
    formatPruneLines(
      "Will prune swamp settings for tools not enrolled:",
      preview.enrolledTools,
      preview.items,
      preview.skipped,
      true,
    ).join("\n"),
  );
}

export function renderRepoPruneCancelled(): void {
  writeOutput("Prune cancelled.");
}
