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

import type { DatastoreSyncEvent, EventHandlers } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

const ACTIVITY_INTERVAL_MS = 5_000;

const syncModeLabels: Record<string, { initial: string; activity: string }> = {
  push: {
    initial: "Pushing all local data to remote...",
    activity: "Still pushing...",
  },
  pull: {
    initial: "Pulling all data from remote...",
    activity: "Still pulling...",
  },
  sync: { initial: "Syncing with remote...", activity: "Still syncing..." },
};

class LogDatastoreSyncRenderer implements Renderer<DatastoreSyncEvent> {
  private activityTimer: ReturnType<typeof setInterval> | undefined;
  private startedAt: number | undefined;

  private clearTimer(): void {
    if (this.activityTimer !== undefined) {
      clearInterval(this.activityTimer);
      this.activityTimer = undefined;
    }
  }

  handlers(): EventHandlers<DatastoreSyncEvent> {
    return {
      syncing: (e) => {
        const labels = syncModeLabels[e.mode];
        writeOutput(labels?.initial ?? `Syncing (${e.mode})...`);

        this.startedAt = Date.now();
        const activityMsg = labels?.activity ?? "Still syncing...";
        this.activityTimer = setInterval(() => {
          const elapsed = Math.round(
            (Date.now() - this.startedAt!) / 1_000,
          );
          writeOutput(`${activityMsg} (${elapsed}s)`);
        }, ACTIVITY_INTERVAL_MS);
      },
      completed: (e) => {
        this.clearTimer();
        const data = e.data;
        if (data.mode === "push") {
          writeOutput(
            data.filesPushed !== undefined
              ? `Pushed ${data.filesPushed} files`
              : "Push complete",
          );
        } else if (data.mode === "pull") {
          writeOutput(
            data.filesPulled !== undefined
              ? `Pulled ${data.filesPulled} files`
              : "Pull complete",
          );
        } else {
          const pulled = data.filesPulled ?? 0;
          const pushed = data.filesPushed ?? 0;
          writeOutput(
            `Sync complete: ${pulled} pulled, ${pushed} pushed`,
          );
          if (data.errors && data.errors.length > 0) {
            for (const err of data.errors) {
              writeOutput(`WARNING: ${err}`);
            }
          }
        }
      },
      error: (e) => {
        this.clearTimer();
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonDatastoreSyncRenderer implements Renderer<DatastoreSyncEvent> {
  handlers(): EventHandlers<DatastoreSyncEvent> {
    return {
      syncing: () => {
        // No JSON output for progress events
      },
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createDatastoreSyncRenderer(
  mode: OutputMode,
): Renderer<DatastoreSyncEvent> {
  switch (mode) {
    case "json":
      return new JsonDatastoreSyncRenderer();
    case "log":
      return new LogDatastoreSyncRenderer();
  }
}
