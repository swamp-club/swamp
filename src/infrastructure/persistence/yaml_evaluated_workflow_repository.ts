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
import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { atomicWriteTextFile } from "./atomic_write.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";
import { assertSafePath } from "./safe_path.ts";
import {
  isFilenameSafeName,
  Workflow,
  type WorkflowData,
} from "../../domain/workflows/workflow.ts";

/**
 * Repository for storing evaluated workflows.
 *
 * Writes to {repoDir}/.swamp/workflows-evaluated/workflow-{name}.yaml
 * (or workflow-{uuid}.yaml for legacy/non-filename-safe names).
 * This directory contains workflows with all expressions resolved.
 */
export class YamlEvaluatedWorkflowRepository {
  private readonly baseDir: string;
  private readonly idToActualPath = new Map<WorkflowId, string>();

  constructor(private readonly repoDir: string, baseDir?: string) {
    this.baseDir = baseDir ??
      swampPath(repoDir, SWAMP_SUBDIRS.workflowsEvaluated);
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

    // Try cached path
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

    // Slow path: scan all files
    const workflows = await this.findAll();
    return workflows.find((w) => w.id === id) ?? null;
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
          const content = await Deno.readTextFile(path);
          const data = parseYaml(content) as WorkflowData;
          const workflow = Workflow.fromData(data);
          this.idToActualPath.set(workflow.id as WorkflowId, path);
          workflows.push(workflow);
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

  /**
   * Finds an evaluated workflow by its name.
   *
   * @param name - The workflow name
   * @returns The evaluated workflow if found, or null
   */
  async findByName(name: string): Promise<Workflow | null> {
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

    const workflows = await this.findAll();
    return workflows.find((w) => w.name === name) ?? null;
  }

  async save(workflow: Workflow): Promise<void> {
    const dir = this.getWorkflowsDir();
    await assertSafePath(dir, this.baseDir);
    await ensureDir(dir);

    const targetPath = this.resolveWritePath(workflow);
    const data = workflow.toData();
    // Remove undefined values since YAML can't stringify them
    const cleanData = JSON.parse(JSON.stringify(data));
    const content = stringifyYaml(cleanData as Record<string, unknown>);
    await atomicWriteTextFile(targetPath, content);

    // Clean up old file if it's at a different path
    const previousPath = this.idToActualPath.get(workflow.id);
    if (previousPath && previousPath !== targetPath) {
      try {
        await Deno.remove(previousPath);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    // Also check legacy UUID path
    const legacyPath = this.getLegacyPath(workflow.id);
    if (targetPath !== legacyPath && previousPath !== legacyPath) {
      try {
        await Deno.remove(legacyPath);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    this.idToActualPath.set(workflow.id, targetPath);
  }

  async delete(id: WorkflowId): Promise<void> {
    const pathsToTry = new Set([this.getLegacyPath(id)]);
    const cachedPath = this.idToActualPath.get(id);
    if (cachedPath) pathsToTry.add(cachedPath);

    for (const path of pathsToTry) {
      try {
        await Deno.remove(path);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    this.idToActualPath.delete(id);
  }

  /**
   * Clears all evaluated workflows.
   */
  async clear(): Promise<void> {
    const dir = this.getWorkflowsDir();
    try {
      await Deno.remove(dir, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
    this.idToActualPath.clear();
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
}
