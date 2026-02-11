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

import type { Data } from "./data.ts";
import type { ModelType } from "../models/model_type.ts";
import type { WorkflowRun } from "../workflows/workflow_run.ts";
import type { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { createDefinitionId } from "../definitions/definition.ts";

/**
 * Represents a data item resolved from a workflow run.
 */
export interface WorkflowDataItem {
  data: Data;
  modelType: ModelType;
  modelId: string;
  modelName: string;
  jobName: string;
  stepName: string;
  contentPath: string;
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
    private readonly dataRepo: FileSystemUnifiedDataRepository,
  ) {}

  /**
   * Finds all data produced by a workflow run.
   *
   * Walks the run's jobs → steps → dataArtifacts and resolves each
   * artifact to its Data entity. Gracefully skips GC'd or missing data.
   */
  async findAllForWorkflowRun(
    run: WorkflowRun,
  ): Promise<WorkflowDataItem[]> {
    const results: WorkflowDataItem[] = [];

    // Get all global data once and index by dataId for efficient lookups
    const allGlobal = await this.dataRepo.findAllGlobal();
    const dataByName = new Map<
      string,
      { data: Data; modelType: ModelType; modelId: string }
    >();
    for (const item of allGlobal) {
      // Key by data name + model ID for uniqueness
      const key = `${item.modelId}:${item.data.name}`;
      dataByName.set(key, item);
    }

    // Also index by dataId for direct lookups
    const dataById = new Map<
      string,
      { data: Data; modelType: ModelType; modelId: string }
    >();
    for (const item of allGlobal) {
      dataById.set(item.data.id, item);
    }

    for (const job of run.jobs) {
      for (const step of job.steps) {
        if (step.dataArtifacts.length === 0) continue;

        for (const artifact of step.dataArtifacts) {
          // Look up the data by its ID first, then fall back to name matching.
          // Data IDs change with each version, so older run artifacts may not
          // match the current data's ID. Name matching resolves this by finding
          // the data item across all models that shares the same name.
          let found = dataById.get(artifact.dataId);
          if (!found) {
            // Try matching by name across all models
            for (const [, item] of dataByName) {
              if (item.data.name === artifact.name) {
                found = item;
                break;
              }
            }
          }
          if (!found) continue; // GC'd or missing data

          // Resolve model name
          const modelName = await this.resolveModelName(
            found.modelType,
            found.modelId,
          );

          const contentPath = this.dataRepo.getContentPath(
            found.modelType,
            found.modelId,
            found.data.name,
            found.data.version,
          );

          results.push({
            data: found.data,
            modelType: found.modelType,
            modelId: found.modelId,
            modelName,
            jobName: job.jobName,
            stepName: step.stepName,
            contentPath,
          });
        }
      }
    }

    return results;
  }

  /**
   * Finds data by name within a workflow run.
   *
   * Searches across all steps in the run for a data artifact matching
   * the given name and optional version.
   */
  async findByNameInWorkflowRun(
    run: WorkflowRun,
    dataName: string,
    version?: number,
  ): Promise<WorkflowDataItem | null> {
    const allItems = await this.findAllForWorkflowRun(run);

    for (const item of allItems) {
      if (item.data.name === dataName) {
        if (version !== undefined && item.data.version !== version) {
          continue;
        }
        return item;
      }
    }

    return null;
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
