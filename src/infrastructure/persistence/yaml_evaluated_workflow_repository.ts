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
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";
import {
  Workflow,
  type WorkflowData,
} from "../../domain/workflows/workflow.ts";

/**
 * Repository for storing evaluated workflows.
 *
 * Writes to {repoDir}/.swamp/workflows-evaluated/workflow-{uuid}.yaml
 * This directory contains workflows with all expressions resolved.
 */
export class YamlEvaluatedWorkflowRepository {
  constructor(private readonly repoDir: string) {}

  async findById(id: WorkflowId): Promise<Workflow | null> {
    const path = this.getPath(id);
    try {
      const content = await Deno.readTextFile(path);
      const data = parseYaml(content) as WorkflowData;
      return Workflow.fromData(data);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
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
          workflows.push(Workflow.fromData(data));
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
    const workflows = await this.findAll();
    return workflows.find((w) => w.name === name) ?? null;
  }

  async save(workflow: Workflow): Promise<void> {
    const dir = this.getWorkflowsDir();
    await ensureDir(dir);

    const path = this.getPath(workflow.id);
    const data = workflow.toData();
    // Remove undefined values since YAML can't stringify them
    const cleanData = JSON.parse(JSON.stringify(data));
    const content = stringifyYaml(cleanData as Record<string, unknown>);
    await Deno.writeTextFile(path, content);
  }

  async delete(id: WorkflowId): Promise<void> {
    const path = this.getPath(id);
    try {
      await Deno.remove(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
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
  }

  getPath(id: WorkflowId): string {
    return join(this.getWorkflowsDir(), `workflow-${id}.yaml`);
  }

  private getWorkflowsDir(): string {
    return swampPath(this.repoDir, SWAMP_SUBDIRS.workflowsEvaluated);
  }
}
