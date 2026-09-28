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

import type { Data } from "./data.ts";
import { ModelType } from "../models/model_type.ts";
import type { DataArtifactRef } from "../models/model_output.ts";
import type { WorkflowRun } from "../workflows/workflow_run.ts";
import type { UnifiedDataRepository } from "./repositories.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { createDefinitionId } from "../definitions/definition.ts";

/**
 * Represents a data item resolved from a workflow run.
 *
 * `jobName` and `stepName` are absent for workflow-scope artifacts (e.g.
 * data produced by workflow-scope reports), which belong to the run as a
 * whole rather than to any single step.
 */
export interface WorkflowDataItem {
  data: Data;
  modelType: ModelType;
  modelId: string;
  modelName: string;
  jobName?: string;
  stepName?: string;
  contentPath: string;
}

/** A model that owns data, identified by model type and model id. */
interface DataOwner {
  modelType: ModelType;
  modelId: string;
}

/**
 * Picks the item with the requested version, or the highest version when no
 * version is requested.
 */
function selectVersion(
  items: WorkflowDataItem[],
  version: number | undefined,
): WorkflowDataItem | null {
  if (version !== undefined) {
    return items.find((item) => item.data.version === version) ?? null;
  }
  let best: WorkflowDataItem | null = null;
  for (const item of items) {
    if (!best || item.data.version > best.data.version) best = item;
  }
  return best;
}

/**
 * Service for resolving data produced by workflow runs.
 *
 * Walks the workflow run's job/step/artifact structure and resolves
 * each data artifact back to its stored Data entity.
 */
export class WorkflowDataService {
  constructor(
    private readonly definitionRepo: YamlDefinitionRepository,
    private readonly dataRepo: UnifiedDataRepository,
  ) {}

  /**
   * Finds all data produced by a workflow run.
   *
   * Walks the run's jobs → steps → dataArtifacts and resolves each
   * artifact to the exact version the run recorded. Gracefully skips GC'd
   * or missing data — never substitutes a newer version or another model's
   * data.
   */
  async findAllForWorkflowRun(
    run: WorkflowRun,
  ): Promise<WorkflowDataItem[]> {
    const results: WorkflowDataItem[] = [];

    // The global index holds only the latest version of each data name, so
    // it is used solely to find which models own data with a given name.
    const allGlobal = await this.dataRepo.findAllGlobal();
    const ownersByName = new Map<string, DataOwner[]>();
    for (const item of allGlobal) {
      const owners = ownersByName.get(item.data.name) ?? [];
      owners.push({ modelType: item.modelType, modelId: item.modelId });
      ownersByName.set(item.data.name, owners);
    }

    for (const job of run.jobs) {
      for (const step of job.steps) {
        if (step.dataArtifacts.length === 0) continue;

        for (const artifact of step.dataArtifacts) {
          const resolved = await this.resolveArtifact(
            artifact,
            run.id,
            ownersByName.get(artifact.name) ?? [],
          );
          if (!resolved) continue;
          results.push({
            ...resolved,
            jobName: job.jobName,
            stepName: step.stepName,
          });
        }
      }
    }

    // Workflow-scope artifacts (e.g. workflow-scope report output) are
    // tracked on the run aggregate rather than under any single step, and
    // are stored under the workflow itself.
    const workflowOwner: DataOwner = {
      modelType: ModelType.create("workflow"),
      modelId: run.workflowId,
    };
    for (const artifact of run.workflowDataArtifacts) {
      const resolved = await this.resolveArtifact(artifact, run.id, [
        workflowOwner,
      ]);
      if (resolved) {
        results.push(resolved);
      }
    }

    return results;
  }

  /**
   * Resolves a run artifact to the version the run recorded.
   *
   * Each candidate owner is read at `artifact.version`, and the stored data
   * is accepted only when it belongs to this run: its id matches the
   * artifact's `dataId`, or its owner provenance names this run. Data ids
   * can be shared across versions, so the version — not the id — selects
   * what is read. An id match is preferred over a run-id-only match.
   */
  private async resolveArtifact(
    artifact: DataArtifactRef,
    runId: string,
    owners: DataOwner[],
  ): Promise<Omit<WorkflowDataItem, "jobName" | "stepName"> | null> {
    let found: { data: Data; owner: DataOwner } | undefined;
    for (const owner of owners) {
      const data = await this.dataRepo.findByName(
        owner.modelType,
        owner.modelId,
        artifact.name,
        artifact.version,
      );
      if (!data) continue;
      if (data.id === artifact.dataId) {
        found = { data, owner };
        break;
      }
      if (!found && data.ownerDefinition.workflowRunId === runId) {
        found = { data, owner };
      }
    }
    if (!found) return null;

    const { data, owner } = found;
    const modelName = await this.resolveModelName(
      owner.modelType,
      owner.modelId,
    );

    const contentPath = this.dataRepo.getContentPath(
      owner.modelType,
      owner.modelId,
      data.name,
      data.version,
    );

    return {
      data,
      modelType: owner.modelType,
      modelId: owner.modelId,
      modelName,
      contentPath,
    };
  }

  /**
   * Finds data by name within a workflow run.
   *
   * Searches the run's artifacts for a match on the given name and optional
   * version. Without a version, the highest version the run recorded wins.
   */
  async findByNameInWorkflowRun(
    run: WorkflowRun,
    dataName: string,
    version?: number,
  ): Promise<WorkflowDataItem | null> {
    const allItems = await this.findAllForWorkflowRun(run);

    // Primary: match by exact data instance name.
    const byName = selectVersion(
      allItems.filter((item) => item.data.name === dataName),
      version,
    );
    if (byName) return byName;

    // Fallback: match by specName tag. Instance names often differ from
    // spec names (e.g. "classification-main" vs "classification"), and
    // users naturally query by spec name.
    return selectVersion(
      allItems.filter((item) => item.data.tags["specName"] === dataName),
      version,
    );
  }

  private async resolveModelName(
    modelType: ModelType,
    modelId: string,
  ): Promise<string> {
    const definition = await this.definitionRepo.findById(
      modelType,
      createDefinitionId(modelId),
    );
    if (definition) {
      return definition.name;
    }
    return modelId;
  }
}
