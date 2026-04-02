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

/**
 * WorkflowWatcher monitors the workflows directory for changes and notifies
 * a callback when workflow schedules are added, modified, or removed.
 * Uses Deno.watchFs with debouncing to coalesce rapid filesystem events.
 */

import { join } from "@std/path";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["workflow-watcher"]);

const DEBOUNCE_MS = 500;

/**
 * Callback invoked when a workflow's schedule changes.
 * A null schedule means the schedule was removed or the workflow was deleted.
 */
export type ScheduleChangeCallback = (
  workflowId: WorkflowId,
  schedule: string | null,
  workflowName: string,
) => void;

export class WorkflowWatcher {
  private watcher: Deno.FsWatcher | null = null;
  private watchLoopPromise: Promise<void> = Promise.resolve();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly workflowsDir: string,
    private readonly workflowRepo: WorkflowRepository,
    private readonly onChange: ScheduleChangeCallback,
  ) {}

  /**
   * Starts watching the workflows directory for changes.
   */
  async start(): Promise<void> {
    try {
      await Deno.stat(this.workflowsDir);
    } catch {
      logger.info(
        "Workflows directory does not exist, skipping watch: {dir}",
        { dir: this.workflowsDir },
      );
      return;
    }

    this.watcher = Deno.watchFs(this.workflowsDir);
    this.watchLoopPromise = this.watchLoop().catch((error) => {
      logger.error("Watch loop failed: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Stops watching and clears all pending debounce timers.
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    await this.watchLoopPromise;
  }

  private async watchLoop(): Promise<void> {
    if (!this.watcher) return;

    try {
      for await (const event of this.watcher) {
        for (const path of event.paths) {
          if (!path.endsWith(".yaml") && !path.endsWith(".yml")) continue;
          this.debounce(path, event.kind);
        }
      }
    } catch (error) {
      // Watcher was closed — expected during shutdown
      if (error instanceof Deno.errors.BadResource) return;
      throw error;
    }
  }

  private debounce(
    path: string,
    kind: Deno.FsEvent["kind"],
  ): void {
    const existing = this.debounceTimers.get(path);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      path,
      setTimeout(() => {
        this.debounceTimers.delete(path);
        this.handleChange(path, kind).catch((error) => {
          logger.warn("Failed to handle workflow change at {path}: {error}", {
            path,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, DEBOUNCE_MS),
    );
  }

  private async handleChange(
    path: string,
    kind: Deno.FsEvent["kind"],
  ): Promise<void> {
    const filename = path.split("/").pop() ?? "";

    if (kind === "remove") {
      // Extract workflow ID from filename pattern: workflow-{uuid}.yaml
      const match = filename.match(/^workflow-([0-9a-f-]+)\.ya?ml$/);
      if (match) {
        this.onChange(match[1] as WorkflowId, null, filename);
      }
      return;
    }

    // For create/modify, re-read the workflow from the repository
    try {
      const match = filename.match(/^workflow-([0-9a-f-]+)\.ya?ml$/);
      if (!match) return;

      const workflowId = match[1] as WorkflowId;
      const workflow = await this.workflowRepo.findById(workflowId);
      if (!workflow) {
        this.onChange(workflowId, null, filename);
        return;
      }

      this.onChange(workflowId, workflow.schedule ?? null, workflow.name);
    } catch (error) {
      logger.warn(
        "Failed to read changed workflow at {path}: {error}",
        {
          path,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  /**
   * Performs an initial scan of all workflows and reports their schedules.
   * Used on startup to register existing schedules.
   */
  async scanExisting(): Promise<void> {
    const workflows = await this.workflowRepo.findAll();
    for (const workflow of workflows) {
      if (workflow.schedule) {
        this.onChange(workflow.id, workflow.schedule, workflow.name);
      }
    }
  }
}

/**
 * Returns the workflows directory path for a given repo directory.
 */
export function workflowsDir(repoDir: string): string {
  return join(repoDir, "workflows");
}
