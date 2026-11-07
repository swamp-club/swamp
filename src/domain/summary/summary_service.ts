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

import type { OutputSummary } from "../models/output_summary.ts";
import type { ModelType } from "../models/model_type.ts";
import type { OutputRepository } from "../models/repositories.ts";
import type { DefinitionRepository } from "../definitions/repositories.ts";
import type {
  WorkflowRepository,
  WorkflowRunRepository,
} from "../workflows/repositories.ts";
import {
  laneStepOf,
  perWorkerBehaviorName,
} from "../workflows/fan_out_lanes.ts";
import type {
  ActivitySummary,
  DataModelGroup,
  DataRepositoryReader,
  DataSummary,
  MethodGroup,
  MethodRunDetail,
  ModelExecutionGroup,
  StepRunSummary,
  WorkflowRunDetail,
  WorkflowRunGroup,
} from "./summary_types.ts";

export class SummaryService {
  constructor(
    private readonly outputRepo: OutputRepository,
    private readonly workflowRunRepo: WorkflowRunRepository,
    private readonly dataRepo: DataRepositoryReader,
    private readonly definitionRepo?: DefinitionRepository,
    private readonly workflowRepo?: WorkflowRepository,
  ) {}

  /**
   * counts always reflect all matching runs in the window; limit only bounds
   * the detail array, and truncation sets the group's truncated flag
   */
  async summarise(
    cutoffDate: Date,
    options: { limit?: number } = {},
  ): Promise<ActivitySummary> {
    const [
      filteredOutputs,
      filteredRuns,
      filteredData,
      allDefinitions,
      allWorkflows,
    ] = await Promise.all([
      this.outputRepo.findAllGlobalSince(cutoffDate, undefined, undefined, {
        errorMessages: true,
      }),
      this.workflowRunRepo.findAllGlobalSince(cutoffDate),
      this.dataRepo.findAllGlobalSince(cutoffDate),
      this.definitionRepo?.findAllGlobal() ?? Promise.resolve([]),
      this.workflowRepo?.findAll() ?? Promise.resolve([]),
    ]);

    const defNames = new Map<string, string>();
    for (const { definition } of allDefinitions) {
      defNames.set(definition.id, definition.name);
    }

    const workflowStepModels = new Map<string, Map<string, string>>();
    for (const workflow of allWorkflows) {
      const stepMap = new Map<string, string>();
      for (const job of workflow.jobs) {
        for (const step of job.steps) {
          if (step.task.isModelMethod()) {
            const taskData = step.task.data;
            if (taskData.type === "model_method") {
              stepMap.set(
                step.name,
                taskData.modelIdOrName ?? taskData.modelName ?? "",
              );
            }
          }
        }
      }
      workflowStepModels.set(workflow.id, stepMap);
    }

    const methodExecutions = this.groupMethodExecutions(
      filteredOutputs,
      defNames,
      options.limit,
    );

    const workflows = this.groupWorkflowRuns(
      filteredRuns,
      workflowStepModels,
      options.limit,
    );

    const dataSummary = this.summariseData(filteredData);

    return {
      since: cutoffDate.toISOString(),
      methodExecutions,
      workflows,
      data: dataSummary,
    };
  }

  private groupMethodExecutions(
    outputs: { output: OutputSummary; type: ModelType; method: string }[],
    defNames: Map<string, string>,
    limit?: number,
  ): ModelExecutionGroup[] {
    const models = new Map<
      string,
      { type: string; modelName: string; methods: Map<string, MethodGroup> }
    >();

    for (const { output, type, method } of outputs) {
      const defId = output.definitionId;
      let model = models.get(defId);
      if (!model) {
        model = {
          type: type.normalized,
          modelName: defNames.get(defId) ?? defId,
          methods: new Map(),
        };
        models.set(defId, model);
      }

      let methodGroup = model.methods.get(method);
      if (!methodGroup) {
        methodGroup = {
          method,
          succeeded: 0,
          failed: 0,
          total: 0,
          runs: [],
        };
        model.methods.set(method, methodGroup);
      }

      methodGroup.total++;
      if (output.status === "succeeded") {
        methodGroup.succeeded++;
      } else if (output.status === "failed") {
        methodGroup.failed++;
      }

      const detail: MethodRunDetail = {
        id: output.id,
        definitionId: output.definitionId,
        startedAt: output.startedAt.toISOString(),
        durationMs: output.durationMs,
        status: output.status,
        error: output.errorMessage,
        triggeredBy: output.provenance.triggeredBy,
      };
      methodGroup.runs.push(detail);
    }

    const result: ModelExecutionGroup[] = [];
    for (const model of models.values()) {
      const methods = [...model.methods.values()].sort((a, b) =>
        b.total - a.total
      );

      for (const m of methods) {
        m.runs.sort((a, b) =>
          new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
        );
        if (limit !== undefined && m.runs.length > limit) {
          m.runs = m.runs.slice(0, limit);
          m.truncated = true;
        }
      }

      const total = methods.reduce((s, m) => s + m.total, 0);
      const succeeded = methods.reduce((s, m) => s + m.succeeded, 0);
      const failed = methods.reduce((s, m) => s + m.failed, 0);

      result.push({
        modelName: model.modelName,
        type: model.type,
        succeeded,
        failed,
        total,
        methods,
      });
    }

    result.sort((a, b) => b.total - a.total);

    return result;
  }

  private groupWorkflowRuns(
    runs: Awaited<ReturnType<WorkflowRunRepository["findAllGlobal"]>>,
    workflowStepModels: Map<string, Map<string, string>>,
    limit?: number,
  ): WorkflowRunGroup[] {
    const groups = new Map<string, WorkflowRunGroup>();

    for (const { run, workflowId } of runs) {
      const key = run.workflowName;
      let group = groups.get(key);
      if (!group) {
        group = {
          workflowName: key,
          succeeded: 0,
          failed: 0,
          total: 0,
          runs: [],
        };
        groups.set(key, group);
      }

      group.total++;
      if (run.status === "succeeded") {
        group.succeeded++;
      } else if (run.status === "failed") {
        group.failed++;
      }

      const firstFailedStep = run.status === "failed"
        ? run.failureInfo().failedStep
        : undefined;

      const stepModels = workflowStepModels.get(workflowId) ??
        new Map<string, string>();
      const steps: StepRunSummary[] = [];
      for (const job of run.jobs) {
        for (const step of job.steps) {
          const durationMs = step.startedAt && step.completedAt
            ? step.completedAt.getTime() - step.startedAt.getTime()
            : undefined;
          steps.push({
            jobName: job.jobName,
            stepName: step.stepName,
            modelName: stepModels.get(step.stepName) ??
              laneModelName(stepModels, step.stepName, job.fanOutPlan?.lanes),
            // A wait for a signal is shown as `waiting` however it is stored.
            status: step.isSignalWait ? "waiting" : step.status,
            durationMs,
            error: step.error,
          });
        }
      }

      const detail: WorkflowRunDetail = {
        id: run.id,
        startedAt: run.startedAt?.toISOString(),
        completedAt: run.completedAt?.toISOString(),
        status: run.status,
        firstFailedStep,
        steps,
      };
      group.runs.push(detail);
    }

    const sorted = [...groups.values()].sort((a, b) => b.total - a.total);

    for (const group of sorted) {
      group.runs.sort((a, b) => {
        const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0;
        const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0;
        return bTime - aTime;
      });
      if (limit !== undefined && group.runs.length > limit) {
        group.runs = group.runs.slice(0, limit);
        group.truncated = true;
      }
    }

    return sorted;
  }

  private summariseData(
    data: Awaited<ReturnType<DataRepositoryReader["findAllGlobal"]>>,
  ): DataSummary {
    const modelSet = new Set<string>();
    let totalVersions = 0;

    const typeGroups = new Map<string, { items: number; versions: number }>();

    for (const { data: item, modelType, modelId } of data) {
      modelSet.add(`${modelType.normalized}/${modelId}`);
      // Each Data from findAllGlobal is the latest version;
      // its version number tells us how many versions exist.
      totalVersions += item.version;

      const typeKey = modelType.normalized;
      const group = typeGroups.get(typeKey) ?? { items: 0, versions: 0 };
      group.items++;
      group.versions += item.version;
      typeGroups.set(typeKey, group);
    }

    const byModelType: DataModelGroup[] = [...typeGroups.entries()]
      .map(([modelType, counts]) => ({
        modelType,
        items: counts.items,
        versions: counts.versions,
      }))
      .sort((a, b) => b.items - a.items);

    return {
      totalItems: data.length,
      totalVersions,
      uniqueModels: modelSet.size,
      byModelType,
    };
  }
}

function laneModelName(
  stepModels: ReadonlyMap<string, string>,
  stepName: string,
  lanes: readonly { readonly worker: string }[] | undefined,
): string | undefined {
  const lane = laneStepOf(stepName, lanes);
  if (lane === undefined) return undefined;
  const authored = stepModels.get(lane.authored);
  return authored === undefined
    ? undefined
    : perWorkerBehaviorName(authored, lane.worker);
}
