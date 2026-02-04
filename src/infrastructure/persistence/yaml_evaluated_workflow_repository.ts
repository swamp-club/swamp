import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
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
    return join(this.repoDir, ".swamp", "workflows-evaluated");
  }
}
