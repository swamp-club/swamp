import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import {
  createWorkflowId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import {
  Workflow,
  type WorkflowData,
} from "../../domain/workflows/workflow.ts";
import type { EventBus } from "../../domain/events/event_bus.ts";
import {
  createWorkflowCreated,
  createWorkflowDeleted,
  createWorkflowUpdated,
} from "../../domain/events/types.ts";

/**
 * YAML-based implementation of WorkflowRepository.
 *
 * Stores workflows as YAML files in the directory structure:
 * {repoDir}/.swamp/workflows/workflow-{uuid}.yaml
 */
export class YamlWorkflowRepository implements WorkflowRepository {
  constructor(
    private readonly repoDir: string,
    private readonly eventBus?: EventBus,
  ) {}

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

  async findByName(name: string): Promise<Workflow | null> {
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

    // Check if this is a new workflow or an update
    const isNew = !(await this.exists(path));

    const data = workflow.toData();
    // Remove undefined values since YAML can't stringify them
    const cleanData = JSON.parse(JSON.stringify(data));
    const content = stringifyYaml(cleanData as Record<string, unknown>);
    await Deno.writeTextFile(path, content);

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
    const path = this.getPath(id);

    // Get the workflow name before deleting for the event
    let workflowName: string | undefined;
    if (this.eventBus) {
      const workflow = await this.findById(id);
      workflowName = workflow?.name;
    }

    try {
      await Deno.remove(path);

      // Emit event if we had a name
      if (this.eventBus && workflowName) {
        const event = createWorkflowDeleted(id, workflowName);
        await this.eventBus.publish(event);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  nextId(): WorkflowId {
    return createWorkflowId(crypto.randomUUID());
  }

  getPath(id: WorkflowId): string {
    return join(this.getWorkflowsDir(), `workflow-${id}.yaml`);
  }

  private getWorkflowsDir(): string {
    return join(this.repoDir, ".swamp", "workflows");
  }
}
