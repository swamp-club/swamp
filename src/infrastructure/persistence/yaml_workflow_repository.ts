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

import { ensureDir } from "@std/fs";
import { basename, join } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import { assertSafePath } from "./safe_path.ts";
import {
  createWorkflowId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import {
  isFilenameSafeName,
  Workflow,
  type WorkflowData,
} from "../../domain/workflows/workflow.ts";
import type { EventBus } from "../../domain/events/event_bus.ts";
import {
  createWorkflowCreated,
  createWorkflowDeleted,
  createWorkflowUpdated,
} from "../../domain/events/types.ts";

const logger = getLogger(["workflow-repo"]);

/**
 * YAML-based implementation of WorkflowRepository.
 *
 * Stores workflows as YAML files in the directory structure:
 * {repoDir}/workflows/workflow-{name}.yaml   (new default for filename-safe names)
 * {repoDir}/workflows/workflow-{uuid}.yaml   (legacy, still discoverable)
 */
export class YamlWorkflowRepository implements WorkflowRepository {
  private readonly baseDir: string;
  // Tracks the actual on-disk path for each workflow ID, so getPath()
  // returns the real location rather than guessing.
  private readonly idToActualPath = new Map<WorkflowId, string>();

  constructor(
    private readonly repoDir: string,
    private readonly eventBus?: EventBus,
    baseDir?: string,
  ) {
    this.baseDir = baseDir ?? join(repoDir, "workflows");
  }

  async findById(id: WorkflowId): Promise<Workflow | null> {
    // Fast path: try UUID-based filename (legacy)
    const legacyPath = this.getLegacyPath(id);
    try {
      const content = await Deno.readTextFile(legacyPath);
      const data = parseYaml(content) as WorkflowData;
      const workflow = Workflow.fromData(data);
      this.idToActualPath.set(id, legacyPath);
      return workflow;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    // Try name-based filename from cache
    const cachedPath = this.idToActualPath.get(id);
    if (cachedPath && cachedPath !== legacyPath) {
      try {
        const content = await Deno.readTextFile(cachedPath);
        const data = parseYaml(content) as WorkflowData;
        return Workflow.fromData(data);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    // Slow path: scan all workflow files
    const workflows = await this.findAll();
    return workflows.find((w) => w.id === id) ?? null;
  }

  async findByName(name: string): Promise<Workflow | null> {
    // Fast path: try name-based filename directly
    if (isFilenameSafeName(name)) {
      const namePath = this.getNamePath(name);
      try {
        const content = await Deno.readTextFile(namePath);
        const data = parseYaml(content) as WorkflowData;
        const workflow = Workflow.fromData(data);
        this.idToActualPath.set(workflow.id as WorkflowId, namePath);
        return workflow;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    // Slow path: scan all workflow files
    const workflows = await this.findAll();
    return workflows.find((w) => w.name === name) ?? null;
  }

  async findAll(): Promise<Workflow[]> {
    const dir = this.getWorkflowsDir();
    const workflows: Workflow[] = [];

    try {
      for await (const entry of Deno.readDir(dir)) {
        if (
          entry.isFile && entry.name.startsWith("workflow-") &&
          entry.name.endsWith(".yaml")
        ) {
          const path = join(dir, entry.name);
          try {
            const content = await Deno.readTextFile(path);
            const data = parseYaml(content) as WorkflowData;
            const workflow = Workflow.fromData(data);
            this.idToActualPath.set(workflow.id as WorkflowId, path);
            workflows.push(workflow);
          } catch (parseError) {
            const errorMsg = parseError instanceof Error
              ? parseError.message
              : String(parseError);
            const workflowName = this.tryExtractName(path);

            if (errorMsg.includes('type "shell" is no longer supported')) {
              logger
                .warn`Skipping workflow ${workflowName}: uses deprecated 'shell' task. Delete or update to 'type: model_method' with 'command/shell'. File: ${path}`;
            } else {
              logger
                .warn`Skipping broken workflow ${workflowName}: ${errorMsg}. Run 'swamp doctor workflows --json' to see all errors. File: ${path}`;
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return workflows;
  }

  async save(workflow: Workflow): Promise<void> {
    const dir = this.getWorkflowsDir();
    await assertSafePath(dir, this.baseDir);
    await ensureDir(dir);

    const targetPath = this.resolveWritePath(workflow);
    const previousPath = this.idToActualPath.get(workflow.id);

    // Check if this is a new workflow or an update
    const isNew = !(await this.exists(targetPath)) &&
      !(previousPath && await this.exists(previousPath));

    const data = workflow.toData();
    // Remove undefined values since YAML can't stringify them
    const cleanData = JSON.parse(JSON.stringify(data));
    const content = stringifyYaml(cleanData as Record<string, unknown>);
    await atomicWriteTextFile(targetPath, content);

    // Clean up old file if we wrote to a different path
    if (previousPath && previousPath !== targetPath) {
      try {
        await Deno.remove(previousPath);
        logger.debug`Migrated workflow file from ${basename(previousPath)} to ${
          basename(targetPath)
        }`;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          logger.warn`Failed to remove old workflow file ${previousPath}: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }
    }

    // Also check the legacy UUID path if it wasn't the previousPath
    const legacyPath = this.getLegacyPath(workflow.id);
    if (
      targetPath !== legacyPath && previousPath !== legacyPath &&
      await this.exists(legacyPath)
    ) {
      try {
        await Deno.remove(legacyPath);
        logger.debug`Migrated workflow file from ${basename(legacyPath)} to ${
          basename(targetPath)
        }`;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          logger.warn`Failed to remove legacy workflow file ${legacyPath}: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }
    }

    this.idToActualPath.set(workflow.id, targetPath);

    // Emit event
    if (this.eventBus) {
      const event = isNew
        ? createWorkflowCreated(workflow.id, workflow.name)
        : createWorkflowUpdated(workflow.id, workflow.name);
      await this.eventBus.publish(event);
    }
  }

  /**
   * Checks if a file exists.
   */
  private async exists(path: string): Promise<boolean> {
    try {
      await Deno.stat(path);
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return false;
      }
      throw error;
    }
  }

  async delete(id: WorkflowId): Promise<void> {
    // Get the workflow before deleting for the event and to find the right file
    const workflow = await this.findById(id);
    const workflowName = workflow?.name;

    // Try removing both possible file paths
    const pathsToTry = new Set([
      this.getLegacyPath(id),
      ...(workflowName && isFilenameSafeName(workflowName)
        ? [this.getNamePath(workflowName)]
        : []),
    ]);
    const cachedPath = this.idToActualPath.get(id);
    if (cachedPath) pathsToTry.add(cachedPath);

    let deleted = false;
    for (const path of pathsToTry) {
      try {
        await Deno.remove(path);
        deleted = true;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    if (deleted) {
      this.idToActualPath.delete(id);

      if (this.eventBus && workflowName) {
        const event = createWorkflowDeleted(id, workflowName);
        await this.eventBus.publish(event);
      }
    }
  }

  nextId(): WorkflowId {
    return createWorkflowId(crypto.randomUUID());
  }

  getPath(id: WorkflowId): string {
    return this.idToActualPath.get(id) ?? this.getLegacyPath(id);
  }

  private resolveWritePath(workflow: Workflow): string {
    if (isFilenameSafeName(workflow.name)) {
      return this.getNamePath(workflow.name);
    }
    return this.getLegacyPath(workflow.id);
  }

  private getNamePath(name: string): string {
    return join(this.getWorkflowsDir(), `workflow-${name}.yaml`);
  }

  private getLegacyPath(id: WorkflowId): string {
    return join(this.getWorkflowsDir(), `workflow-${id}.yaml`);
  }

  private getWorkflowsDir(): string {
    return this.baseDir;
  }

  /**
   * Attempts to extract workflow name from a YAML file path.
   * Falls back to the filename if parsing fails.
   */
  private tryExtractName(path: string): string {
    try {
      const content = Deno.readTextFileSync(path);
      const data = parseYaml(content) as { name?: string };
      if (data?.name) {
        return data.name;
      }
    } catch {
      // Ignore - fall through to filename
    }
    // Extract filename without extension as fallback
    const filename = basename(path);
    return filename.replace(/\.yaml$/, "");
  }
}
