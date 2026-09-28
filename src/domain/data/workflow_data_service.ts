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

interface OwnerIndex {
  ownerById: Map<string, DataOwner>;
  ownersByName: Map<string, DataOwner[]>;
}

/** An artifact ref with the step that recorded it, if any. */
interface LocatedArtifact {
  artifact: { dataId: string; name: string; version: number };
  jobName?: string;
  stepName?: string;
}

/** The run's artifact refs: per-step first, then workflow-scope. */
function runArtifactRefs(run: WorkflowRun): LocatedArtifact[] {
  const refs: LocatedArtifact[] = [];
  for (const job of run.jobs) {
    for (const step of job.steps) {
      for (const artifact of step.dataArtifacts) {
        refs.push({ artifact, jobName: job.jobName, stepName: step.stepName });
      }
    }
  }
  // Workflow-scope artifacts (e.g. workflow-scope report output) are
  // tracked on the run aggregate rather than under any single step.
  for (const artifact of run.workflowDataArtifacts) {
    refs.push({ artifact });
  }
  return refs;
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
   * artifact to the version the run recorded. Gracefully skips GC'd or
   * missing data.
   */
  async findAllForWorkflowRun(
    run: WorkflowRun,
  ): Promise<WorkflowDataItem[]> {
    const index = await this.buildOwnerIndex();
    const results: WorkflowDataItem[] = [];
    for (const located of runArtifactRefs(run)) {
      const resolved = await this.resolveLocated(located, index);
      if (resolved) results.push(resolved);
    }
    return results;
  }

  /**
   * Finds data by name within a workflow run.
   *
   * Matches the run's artifact refs by instance name, then filters by
   * `version` and `dataId` when given, before resolving anything. Without a
   * version, the run's last write of that name (its highest version) wins.
   * `dataId` tells apart items of the same name and version owned by
   * different models, since version numbers count per model.
   */
  async findByNameInWorkflowRun(
    run: WorkflowRun,
    dataName: string,
    version?: number,
    dataId?: string,
  ): Promise<WorkflowDataItem | null> {
    const refs = runArtifactRefs(run).filter((r) =>
      r.artifact.name === dataName &&
      (version === undefined || r.artifact.version === version) &&
      (dataId === undefined || r.artifact.dataId === dataId)
    );

    const index = await this.buildOwnerIndex();
    if (refs.length > 0) {
      // Highest version first (the run's last write); ties keep run order.
      const ordered = version === undefined
        ? [...refs].sort((a, b) => b.artifact.version - a.artifact.version)
        : refs;
      for (const located of ordered) {
        const resolved = await this.resolveLocated(located, index);
        if (resolved) return resolved;
      }
      return null;
    }

    // Fallback: match by specName tag. Instance names often differ from
    // spec names (e.g. "classification-main" vs "classification"), and
    // users naturally query by spec name. The tag lives on the stored data,
    // so this path resolves the run's artifacts first.
    for (const located of runArtifactRefs(run)) {
      if (dataId !== undefined && located.artifact.dataId !== dataId) {
        continue;
      }
      const item = await this.resolveLocated(located, index);
      const specName = item?.data.tags["specName"];
      if (
        item && specName === dataName &&
        (version === undefined || item.data.version === version)
      ) {
        return item;
      }
    }
    return null;
  }

  /**
   * Indexes owners from the latest projection. Data ids are stable across
   * versions, so the id index finds an artifact's owner even after later
   * runs wrote newer versions; the version always comes from the ref.
   */
  private async buildOwnerIndex(): Promise<OwnerIndex> {
    const allGlobal = await this.dataRepo.findAllGlobal();
    const ownerById = new Map<string, DataOwner>();
    const ownersByName = new Map<string, DataOwner[]>();
    for (const item of allGlobal) {
      const owner = { modelType: item.modelType, modelId: item.modelId };
      ownerById.set(item.data.id, owner);
      const named = ownersByName.get(item.data.name) ?? [];
      named.push(owner);
      ownersByName.set(item.data.name, named);
    }
    return { ownerById, ownersByName };
  }

  private async resolveLocated(
    located: LocatedArtifact,
    index: OwnerIndex,
  ): Promise<WorkflowDataItem | null> {
    const resolved = await this.resolveArtifact(located.artifact, index);
    if (!resolved) return null;
    return located.jobName === undefined ? resolved : {
      ...resolved,
      jobName: located.jobName,
      stepName: located.stepName,
    };
  }

  /**
   * Resolves an artifact ref to the exact version the run recorded.
   *
   * The owner comes from the id index. When the id is not indexed, the
   * owners whose latest data carries the recorded name are asked for the
   * recorded version, and only a version with the recorded id is accepted:
   * ids survive new versions, so a same-named item with another id is a
   * different item, never the run's. An item renamed after the run no
   * longer appears under its old name and resolves to null. A recorded
   * version that was garbage-collected resolves to null, never to a newer
   * version.
   */
  private async resolveArtifact(
    artifact: { dataId: string; name: string; version: number },
    index: OwnerIndex,
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
      for (const owner of index.ownersByName.get(artifact.name) ?? []) {
        const data = await this.dataRepo.findByName(
          owner.modelType,
          owner.modelId,
          artifact.name,
          artifact.version,
        );
        if (data?.id === artifact.dataId) {
          found = { ...owner, data };
          break;
        }
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
