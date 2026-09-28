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
import type { ModelType } from "../models/model_type.ts";
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

/** The model (or workflow) that owns a data item. */
interface DataOwner {
  modelType: ModelType;
  modelId: string;
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
   * artifact to its Data entity. Gracefully skips GC'd or missing data.
   */
  async findAllForWorkflowRun(
    run: WorkflowRun,
  ): Promise<WorkflowDataItem[]> {
    const results: WorkflowDataItem[] = [];

    // Index owners once. Data ids are stable across versions, so the id
    // index finds an artifact's owner even after later runs wrote newer
    // versions; the version itself always comes from the artifact ref.
    const allGlobal = await this.dataRepo.findAllGlobal();
    const ownerById = new Map<string, DataOwner>();
    const owners = new Map<string, DataOwner>();
    for (const item of allGlobal) {
      const owner = { modelType: item.modelType, modelId: item.modelId };
      ownerById.set(item.data.id, owner);
      owners.set(`${item.modelType.normalized}:${item.modelId}`, owner);
    }
    const index = { ownerById, owners: [...owners.values()] };

    for (const job of run.jobs) {
      for (const step of job.steps) {
        if (step.dataArtifacts.length === 0) continue;

        for (const artifact of step.dataArtifacts) {
          const resolved = await this.resolveArtifact(artifact, index);
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
    // tracked on the run aggregate rather than under any single step.
    for (const artifact of run.workflowDataArtifacts) {
      const resolved = await this.resolveArtifact(artifact, index);
      if (resolved) {
        results.push(resolved);
      }
    }

    return results;
  }

  /**
   * Resolves an artifact ref to the exact version the run recorded.
   *
   * The owner comes from the id index. When the id is not indexed (the
   * item was renamed after the run, so the latest projection shows it under
   * a new id and name), each owner is asked for the recorded name and
   * version, preferring the one whose id matches. A name-only match is used
   * only when exactly one owner holds it; several are skipped rather than
   * guessed. A recorded version that was garbage-collected resolves to
   * null, never to a newer version.
   */
  private async resolveArtifact(
    artifact: { dataId: string; name: string; version: number },
    index: { ownerById: Map<string, DataOwner>; owners: DataOwner[] },
  ): Promise<Omit<WorkflowDataItem, "jobName" | "stepName"> | null> {
    let found: (DataOwner & { data: Data }) | null = null;

    const indexedOwner = index.ownerById.get(artifact.dataId);
    if (indexedOwner) {
      const data = await this.dataRepo.findByName(
        indexedOwner.modelType,
        indexedOwner.modelId,
        artifact.name,
        artifact.version,
      );
      if (data) found = { ...indexedOwner, data };
    } else {
      const candidates: Array<DataOwner & { data: Data }> = [];
      for (const owner of index.owners) {
        const data = await this.dataRepo.findByName(
          owner.modelType,
          owner.modelId,
          artifact.name,
          artifact.version,
        );
        if (data) candidates.push({ ...owner, data });
      }
      const byId = candidates.filter((c) => c.data.id === artifact.dataId);
      if (byId.length === 1) found = byId[0];
      else if (byId.length === 0 && candidates.length === 1) {
        found = candidates[0];
      }
    }
    if (!found) return null;

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

    return {
      data: found.data,
      modelType: found.modelType,
      modelId: found.modelId,
      modelName,
      contentPath,
    };
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

    // Primary: match by exact data instance name.
    for (const item of allItems) {
      if (item.data.name === dataName) {
        if (version !== undefined && item.data.version !== version) {
          continue;
        }
        return item;
      }
    }

    // Fallback: match by specName tag. Instance names often differ from
    // spec names (e.g. "classification-main" vs "classification"), and
    // users naturally query by spec name.
    for (const item of allItems) {
      const specName = item.data.tags["specName"];
      if (specName && specName === dataName) {
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
