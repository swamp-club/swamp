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
import { getLogger } from "@logtape/logtape";
import { ModelType } from "../models/model_type.ts";
import type { DataArtifactRef } from "../models/model_output.ts";
import type { WorkflowRun } from "../workflows/workflow_run.ts";
import type { UnifiedDataRepository } from "./repositories.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { createDefinitionId } from "../definitions/definition.ts";

export interface WorkflowDataItem {
  data: Data;
  modelType: ModelType;
  modelId: string;
  modelName: string;
  jobName?: string;
  stepName?: string;
  contentPath: string;
}

const logger = getLogger(["data", "workflow"]);

interface DataOwner {
  modelType: ModelType;
  modelId: string;
  name?: string;
}

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

export interface WorkflowDataMatch {
  item: WorkflowDataItem;
  otherProducers: WorkflowDataItem[];
}

function producerKey(item: WorkflowDataItem): string {
  return JSON.stringify([
    item.modelType.normalized,
    item.modelId,
    item.jobName ?? null,
    item.stepName ?? null,
  ]);
}

function matchAmong(
  items: WorkflowDataItem[],
  version: number | undefined,
): WorkflowDataMatch | null {
  const item = selectVersion(items, version);
  if (!item) return null;
  const byProducer = new Map<string, WorkflowDataItem[]>();
  for (const candidate of items) {
    const key = producerKey(candidate);
    const producerItems = byProducer.get(key);
    if (producerItems) producerItems.push(candidate);
    else byProducer.set(key, [candidate]);
  }
  const selectedKey = producerKey(item);
  const otherProducers: WorkflowDataItem[] = [];
  for (const [key, producerItems] of byProducer) {
    if (key === selectedKey) continue;
    const selected = selectVersion(producerItems, version);
    if (selected) otherProducers.push(selected);
  }
  return { item, otherProducers };
}

/**
 * on a v3 datastore history compaction can leave a later re-save of the same
 * version live; v2 never rewrites a version and passes none
 */
export type RunArtifactCheck = (
  artifact: DataArtifactRef,
  data: Data,
  owner: { readonly modelType: ModelType; readonly modelId: string },
  run: WorkflowRun,
) => Promise<boolean>;

export class WorkflowDataService {
  constructor(
    private readonly definitionRepo: YamlDefinitionRepository,
    private readonly dataRepo: UnifiedDataRepository,
    private readonly checkArtifact?: RunArtifactCheck,
  ) {}

  /**
   * GC'd or missing data is skipped; never substitutes a newer version or
   * another model's data
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
            run,
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

    // workflow-scope artifacts are tracked on the run aggregate and stored
    // under the workflow, named by it so search and list authorize the item as
    // the workflow
    const workflowOwner: DataOwner = {
      modelType: ModelType.create("workflow"),
      modelId: run.workflowId,
      name: run.workflowName,
    };
    for (const artifact of run.workflowDataArtifacts) {
      const resolved = await this.resolveArtifact(artifact, run, [
        workflowOwner,
      ]);
      if (resolved) {
        results.push(resolved);
      }
    }

    return results;
  }

  /**
   * data ids can be shared across versions, so the version, not the id, selects
   * what is read; data is accepted only if it belongs to this run, and an id
   * match is preferred over a run-id-only match
   */
  private async resolveArtifact(
    artifact: DataArtifactRef,
    run: WorkflowRun,
    owners: DataOwner[],
  ): Promise<Omit<WorkflowDataItem, "jobName" | "stepName"> | null> {
    const runId = run.id;
    let found: { data: Data; owner: DataOwner } | undefined;
    const runMatches: Array<{ data: Data; owner: DataOwner }> = [];
    for (const owner of owners) {
      let data: Data | null;
      try {
        data = await this.dataRepo.findByName(
          owner.modelType,
          owner.modelId,
          artifact.name,
          artifact.version,
        );
      } catch (error) {
        // An unreadable version under another model must not fail the whole
        // run lookup; it cannot be this artifact's data anyway.
        logger
          .debug`Skipping unreadable ${artifact.name} v${artifact.version} for model ${owner.modelId}: ${error}`;
        continue;
      }
      if (!data) continue;
      if (data.id === artifact.dataId) {
        found = { data, owner };
        break;
      }
      if (data.ownerDefinition.workflowRunId === runId) {
        runMatches.push({ data, owner });
      }
    }
    // A run-id-only match is trusted only when it is unambiguous: several
    // models can write the same name in one run, and picking one of them
    // would return another model's data.
    if (!found && runMatches.length === 1) {
      found = runMatches[0];
    }
    if (!found) return null;
    if (
      this.checkArtifact !== undefined &&
      !await this.checkArtifact(artifact, found.data, found.owner, run)
    ) {
      // A later re-save holds this version now: as for a GC'd version, the
      // run's content is no longer available, and nothing else stands in.
      return null;
    }

    const { data, owner } = found;
    const modelName = owner.name ??
      await this.resolveModelName(owner.modelType, owner.modelId);

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

  async findByNameInWorkflowRun(
    run: WorkflowRun,
    dataName: string,
    version?: number,
  ): Promise<WorkflowDataItem | null> {
    const match = await this.matchByNameInWorkflowRun(run, dataName, version);
    return match?.item ?? null;
  }

  /**
   * several versions from one producer are a version choice, not another
   * producer
   */
  async matchByNameInWorkflowRun(
    run: WorkflowRun,
    dataName: string,
    version?: number,
  ): Promise<WorkflowDataMatch | null> {
    const allItems = await this.findAllForWorkflowRun(run);

    const byName = allItems.filter((item) => item.data.name === dataName);
    const byNameMatch = matchAmong(byName, version);
    if (byNameMatch) return byNameMatch;

    // Fallback: match by specName tag. Instance names often differ from
    // spec names (e.g. "classification-main" vs "classification"), and
    // users naturally query by spec name.
    return matchAmong(
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
