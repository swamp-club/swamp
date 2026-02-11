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

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import type { WorkflowRunRepository } from "../../domain/workflows/repositories.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";
import {
  createWorkflowRunId,
  type WorkflowId,
  type WorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import {
  WorkflowRun,
  type WorkflowRunData,
} from "../../domain/workflows/workflow_run.ts";
import type { EventBus } from "../../domain/events/event_bus.ts";
import {
  createWorkflowRunCompleted,
  createWorkflowRunFailed,
  createWorkflowRunStarted,
} from "../../domain/events/types.ts";

/**
 * YAML-based implementation of WorkflowRunRepository.
 *
 * Stores workflow runs as YAML files in the directory structure:
 * {repoDir}/.swamp/workflow-runs/{workflowId}/workflow-run-{runId}.yaml
 */
export class YamlWorkflowRunRepository implements WorkflowRunRepository {
  constructor(
    private readonly repoDir: string,
    private readonly eventBus?: EventBus,
  ) {}

  async findById(
    workflowId: WorkflowId,
    runId: WorkflowRunId,
  ): Promise<WorkflowRun | null> {
    const dir = this.getRunsDir(workflowId);

    try {
      for await (const entry of Deno.readDir(dir)) {
        if (
          entry.isFile && entry.name.includes(runId) &&
          entry.name.endsWith(".yaml")
        ) {
          const path = join(dir, entry.name);
          const content = await Deno.readTextFile(path);
          const data = parseYaml(content) as WorkflowRunData;
          if (data.id === runId) {
            return WorkflowRun.fromData(data);
          }
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }

    return null;
  }

  async findAllByWorkflowId(workflowId: WorkflowId): Promise<WorkflowRun[]> {
    const dir = this.getRunsDir(workflowId);
    const runs: WorkflowRun[] = [];

    try {
      for await (const entry of Deno.readDir(dir)) {
        if (
          entry.isFile && entry.name.startsWith("workflow-run-") &&
          entry.name.endsWith(".yaml")
        ) {
          const path = join(dir, entry.name);
          const content = await Deno.readTextFile(path);
          const data = parseYaml(content) as WorkflowRunData;
          runs.push(WorkflowRun.fromData(data));
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    // Sort by startedAt descending (most recent first)
    return runs.sort((a, b) => {
      const aTime = a.startedAt?.getTime() ?? 0;
      const bTime = b.startedAt?.getTime() ?? 0;
      return bTime - aTime;
    });
  }

  async findLatestByWorkflowId(
    workflowId: WorkflowId,
  ): Promise<WorkflowRun | null> {
    const runs = await this.findAllByWorkflowId(workflowId);
    return runs[0] ?? null;
  }

  /**
   * Finds all workflow runs across all workflows.
   */
  async findAllGlobal(): Promise<
    { run: WorkflowRun; workflowId: WorkflowId }[]
  > {
    const results: { run: WorkflowRun; workflowId: WorkflowId }[] = [];
    const workflowRunsDir = swampPath(this.repoDir, SWAMP_SUBDIRS.workflowRuns);

    try {
      for await (const entry of Deno.readDir(workflowRunsDir)) {
        if (entry.isDirectory) {
          // Directory name is the workflow ID
          const workflowIdStr = entry.name;
          const workflowId = workflowIdStr as WorkflowId;
          const runs = await this.findAllByWorkflowId(workflowId);
          for (const run of runs) {
            results.push({ run, workflowId });
          }
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    // Sort by startedAt descending (most recent first)
    return results.sort((a, b) => {
      const aTime = a.run.startedAt?.getTime() ?? 0;
      const bTime = b.run.startedAt?.getTime() ?? 0;
      return bTime - aTime;
    });
  }

  async save(workflowId: WorkflowId, run: WorkflowRun): Promise<void> {
    const dir = this.getRunsDir(workflowId);
    await ensureDir(dir);

    const path = this.getPath(workflowId, run.id);

    // Get the previous status to detect state changes
    let previousStatus: string | undefined;
    if (this.eventBus) {
      const existingRun = await this.findById(workflowId, run.id);
      previousStatus = existingRun?.status;
    }

    const data = run.toData();
    // Remove undefined values since YAML can't stringify them
    const cleanData = JSON.parse(JSON.stringify(data));
    const content = stringifyYaml(cleanData as Record<string, unknown>);
    await Deno.writeTextFile(path, content);

    // Emit events based on status changes
    if (this.eventBus) {
      const currentStatus = run.status;

      if (previousStatus !== currentStatus) {
        // Emit WorkflowRunStarted for new runs (previousStatus undefined) or
        // transitions from pending to running
        if (
          currentStatus === "running" &&
          (previousStatus === "pending" || previousStatus === undefined)
        ) {
          const event = createWorkflowRunStarted(
            workflowId,
            run.workflowName,
            run.id,
          );
          await this.eventBus.publish(event);
        } else if (currentStatus === "succeeded") {
          const event = createWorkflowRunCompleted(
            workflowId,
            run.workflowName,
            run.id,
          );
          await this.eventBus.publish(event);
        } else if (currentStatus === "failed") {
          const event = createWorkflowRunFailed(
            workflowId,
            run.workflowName,
            run.id,
          );
          await this.eventBus.publish(event);
        }
      }
    }
  }

  nextId(): WorkflowRunId {
    return createWorkflowRunId(crypto.randomUUID());
  }

  getPath(workflowId: WorkflowId, runId: WorkflowRunId): string {
    return join(
      this.getRunsDir(workflowId),
      `workflow-run-${runId}.yaml`,
    );
  }

  private getRunsDir(workflowId: WorkflowId): string {
    return swampPath(this.repoDir, SWAMP_SUBDIRS.workflowRuns, workflowId);
  }

  async deleteAllByWorkflowId(workflowId: WorkflowId): Promise<number> {
    const dir = this.getRunsDir(workflowId);

    // Count the runs before deleting
    const runs = await this.findAllByWorkflowId(workflowId);
    const count = runs.length;

    if (count === 0) {
      return 0;
    }

    try {
      await Deno.remove(dir, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    return count;
  }
}
