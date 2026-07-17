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

import type {
  EventHandlers,
  RunGcEvent,
  RunGcPreview,
} from "../../libswamp/mod.ts";
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

class LogRunGcRenderer implements Renderer<RunGcEvent> {
  handlers(): EventHandlers<RunGcEvent> {
    const logger = getSwampLogger(["run", "gc"]);
    return {
      collecting: () => {},
      completed: (e) => {
        const total = e.data.workflowRunsDeleted + e.data.outputsDeleted;
        const totalBytes = formatBytes(e.data.totalBytesReclaimed);
        if (e.data.dryRun) {
          logger
            .info`Run GC dry run: would delete ${e.data.workflowRunsDeleted} workflow run(s) (${
            formatBytes(e.data.workflowRunBytesReclaimed)
          }), ${e.data.outputsDeleted} output(s) (${
            formatBytes(e.data.outputBytesReclaimed)
          }), total: ${total} items (${totalBytes})`;
          return;
        }
        logger
          .info`Run GC complete: deleted ${e.data.workflowRunsDeleted} workflow run(s) (${
          formatBytes(e.data.workflowRunBytesReclaimed)
        }), ${e.data.outputsDeleted} output(s) (${
          formatBytes(e.data.outputBytesReclaimed)
        }), total: ${total} items (${totalBytes})`;
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
            totalBytesReclaimed: e.data.totalBytesReclaimed,
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
        totalBytesReclaimable: preview.totalBytesReclaimable,
      },
      null,
      2,
    ));
  } else {
    const logger = getSwampLogger(["run", "gc"]);
    const total = preview.workflowRunsToDelete + preview.outputsToDelete;
    if (total === 0) return;
    logger
      .info`Run GC preview: ${preview.workflowRunsToDelete} workflow run(s) (${
      formatBytes(preview.workflowRunBytesReclaimable)
    }), ${preview.outputsToDelete} output(s) (${
      formatBytes(preview.outputBytesReclaimable)
    }), total: ${formatBytes(preview.totalBytesReclaimable)} reclaimable`;
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
