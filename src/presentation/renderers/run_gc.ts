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

import type { EventHandlers } from "../../libswamp/stream.ts";
import type {
  RunGcAutoDefinition,
  RunGcEvent,
  RunGcPreview,
} from "../../libswamp/data/run_gc.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const LISTED_AUTO_DEFINITIONS = 20;

function autoDefinitionList(removed: readonly RunGcAutoDefinition[]): string {
  const shown = removed.slice(0, LISTED_AUTO_DEFINITIONS)
    .map((d) => `${d.name} (${d.type})`).join(", ");
  const rest = removed.length - LISTED_AUTO_DEFINITIONS;
  return rest > 0 ? `${shown}, and ${rest} more` : shown;
}

class LogRunGcRenderer implements Renderer<RunGcEvent> {
  handlers(): EventHandlers<RunGcEvent> {
    const logger = getSwampLogger(["run", "gc"]);
    return {
      collecting: () => {},
      completed: (e) => {
        const total = e.data.workflowRunsDeleted + e.data.outputsDeleted +
          e.data.evaluatedSnapshotsDeleted;
        const totalBytes = formatBytes(e.data.totalBytesReclaimed);
        if (e.data.dryRun) {
          logger
            .info`Run GC dry run: would delete ${e.data.workflowRunsDeleted} workflow run(s) (${
            formatBytes(e.data.workflowRunBytesReclaimed)
          }), ${e.data.outputsDeleted} output(s) (${
            formatBytes(e.data.outputBytesReclaimed)
          }), ${e.data.evaluatedSnapshotsDeleted} run snapshot(s) (${
            formatBytes(e.data.evaluatedSnapshotBytesReclaimed)
          }), total: ${total} items (${totalBytes})`;
          if (e.data.autoDefinitionsDeleted > 0) {
            logger
              .info`Run GC dry run: would remove ${e.data.autoDefinitionsDeleted} idle auto-definition(s): ${
              autoDefinitionList(e.data.autoDefinitions)
            }`;
          }
          return;
        }
        logger
          .info`Run GC complete: deleted ${e.data.workflowRunsDeleted} workflow run(s) (${
          formatBytes(e.data.workflowRunBytesReclaimed)
        }), ${e.data.outputsDeleted} output(s) (${
          formatBytes(e.data.outputBytesReclaimed)
        }), ${e.data.evaluatedSnapshotsDeleted} run snapshot(s) (${
          formatBytes(e.data.evaluatedSnapshotBytesReclaimed)
        }), total: ${total} items (${totalBytes})`;
        if (e.data.autoDefinitionsDeleted > 0) {
          logger
            .info`Run GC removed ${e.data.autoDefinitionsDeleted} idle auto-definition(s): ${
            autoDefinitionList(e.data.autoDefinitions)
          }`;
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonRunGcRenderer implements Renderer<RunGcEvent> {
  handlers(): EventHandlers<RunGcEvent> {
    return {
      collecting: () => {},
      completed: (e) => {
        console.log(JSON.stringify(
          {
            workflowRunsDeleted: e.data.workflowRunsDeleted,
            workflowRunBytesReclaimed: e.data.workflowRunBytesReclaimed,
            outputsDeleted: e.data.outputsDeleted,
            outputBytesReclaimed: e.data.outputBytesReclaimed,
            evaluatedSnapshotsDeleted: e.data.evaluatedSnapshotsDeleted,
            evaluatedSnapshotBytesReclaimed:
              e.data.evaluatedSnapshotBytesReclaimed,
            totalBytesReclaimed: e.data.totalBytesReclaimed,
            autoDefinitionsDeleted: e.data.autoDefinitionsDeleted,
            autoDefinitions: e.data.autoDefinitions,
            dryRun: e.data.dryRun,
          },
          null,
          2,
        ));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createRunGcRenderer(
  mode: OutputMode,
): Renderer<RunGcEvent> {
  switch (mode) {
    case "json":
      return new JsonRunGcRenderer();
    case "log":
      return new LogRunGcRenderer();
  }
}

export function renderRunGcPreview(
  preview: RunGcPreview,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(
      {
        workflowRunsToDelete: preview.workflowRunsToDelete,
        workflowRunBytesReclaimable: preview.workflowRunBytesReclaimable,
        outputsToDelete: preview.outputsToDelete,
        outputBytesReclaimable: preview.outputBytesReclaimable,
        evaluatedSnapshotsToDelete: preview.evaluatedSnapshotsToDelete,
        evaluatedSnapshotBytesReclaimable:
          preview.evaluatedSnapshotBytesReclaimable,
        totalBytesReclaimable: preview.totalBytesReclaimable,
        autoDefinitionsToDelete: preview.autoDefinitionsToDelete,
      },
      null,
      2,
    ));
  } else {
    const logger = getSwampLogger(["run", "gc"]);
    const total = preview.workflowRunsToDelete + preview.outputsToDelete +
      preview.evaluatedSnapshotsToDelete;
    if (total > 0) {
      logger
        .info`Run GC preview: ${preview.workflowRunsToDelete} workflow run(s) (${
        formatBytes(preview.workflowRunBytesReclaimable)
      }), ${preview.outputsToDelete} output(s) (${
        formatBytes(preview.outputBytesReclaimable)
      }), ${preview.evaluatedSnapshotsToDelete} run snapshot(s) (${
        formatBytes(preview.evaluatedSnapshotBytesReclaimable)
      }), total: ${formatBytes(preview.totalBytesReclaimable)} reclaimable`;
    }
    if (preview.autoDefinitionsToDelete > 0) {
      logger
        .info`Run GC preview: ${preview.autoDefinitionsToDelete} idle auto-definition(s) to remove`;
    }
  }
}

export function renderRunGcCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ cancelled: true }, null, 2));
  } else {
    const logger = getSwampLogger(["run", "gc"]);
    logger.info("Run GC cancelled.");
  }
}
