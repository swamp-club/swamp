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

import { basename } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import type { ScheduleCatchUp } from "../../domain/workflows/schedule_catch_up.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["workflow-watcher"]);

const DEBOUNCE_MS = 500;

export type ScheduleChangeCallback = (
  workflowId: WorkflowId,
  schedule: string | null,
  workflowName: string,
  catchUp?: ScheduleCatchUp,
) => void;

export class WorkflowWatcher {
  private watcher: Deno.FsWatcher | null = null;
  private watchLoopPromise: Promise<void> = Promise.resolve();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly filenameToId = new Map<string, WorkflowId>();

  constructor(
    private readonly workflowsDir: string,
    private readonly workflowRepo: WorkflowRepository,
    private readonly onChange: ScheduleChangeCallback,
  ) {}

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
    const filename = basename(path);
    if (
      !filename.startsWith("workflow-") ||
      (!filename.endsWith(".yaml") && !filename.endsWith(".yml"))
    ) {
      return;
    }

    if (kind === "remove") {
      const cachedId = this.filenameToId.get(filename);
      if (cachedId) {
        this.filenameToId.delete(filename);
        this.onChange(cachedId, null, filename);
      }
      return;
    }

    try {
      const content = await Deno.readTextFile(path);
      const data = parseYaml(content) as { id?: string; name?: string };
      if (!data?.id) return;

      const workflowId = data.id as WorkflowId;
      this.filenameToId.set(filename, workflowId);

      const workflow = await this.workflowRepo.findById(workflowId);
      if (!workflow) {
        this.onChange(workflowId, null, data.name ?? filename);
        return;
      }

      this.onChange(
        workflowId,
        workflow.schedule ?? null,
        workflow.name,
        workflow.catchUp,
      );
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

  async scanExisting(): Promise<void> {
    const workflows = await this.workflowRepo.findAll();
    for (const workflow of workflows) {
      const path = this.workflowRepo.getPath(workflow.id);
      this.filenameToId.set(basename(path), workflow.id);

      if (workflow.schedule) {
        this.onChange(
          workflow.id,
          workflow.schedule,
          workflow.name,
          workflow.catchUp,
        );
      }
    }
  }
}
