import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import type { WorkflowRunRepository } from "../../domain/workflows/repositories.ts";
import {
  createWorkflowRunId,
  type WorkflowId,
  type WorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import {
  WorkflowRun,
  type WorkflowRunData,
} from "../../domain/workflows/workflow_run.ts";

/**
 * YAML-based implementation of WorkflowRunRepository.
 *
 * Stores workflow runs as YAML files in the directory structure:
 * {repoDir}/workflows/workflow-{workflowId}/workflow-run-{runId}-{timestamp}.yaml
 */
export class YamlWorkflowRunRepository implements WorkflowRunRepository {
  constructor(private readonly repoDir: string) {}

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
    const workflowsDir = join(this.repoDir, "workflows");

    try {
      for await (const entry of Deno.readDir(workflowsDir)) {
        if (entry.isDirectory && entry.name.startsWith("workflow-")) {
          // Extract workflow ID from directory name (format: workflow-{uuid})
          const workflowIdStr = entry.name.slice("workflow-".length);
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
    const data = run.toData();
    // Remove undefined values since YAML can't stringify them
    const cleanData = JSON.parse(JSON.stringify(data));
    const content = stringifyYaml(cleanData as Record<string, unknown>);
    await Deno.writeTextFile(path, content);
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
    return join(this.repoDir, "workflows", `workflow-${workflowId}`);
  }
}
