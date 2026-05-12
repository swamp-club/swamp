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

import type { Definition } from "../../domain/definitions/definition.ts";
import { WorkflowDataService } from "../../domain/data/workflow_data_service.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import { createCatalogStore } from "../../infrastructure/persistence/repository_factory.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound, type SwampError, validationFailed } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/** Data item in the list. */
export interface DataListItem {
  id: string;
  name: string;
  version: number;
  contentType: string;
  type: string;
  streaming: boolean;
  size?: number;
  createdAt: string;
}

/** Data grouped by tag type. */
export interface DataGroupedByType {
  type: string;
  items: DataListItem[];
}

/** Model-scoped data list. */
export interface DataListData {
  modelId: string;
  modelName: string;
  modelType: string;
  groups: DataGroupedByType[];
  total: number;
}

/** Data item with workflow context. */
export interface WorkflowDataListItem extends DataListItem {
  modelId: string;
  modelName: string;
  modelType: string;
  /** Absent for workflow-scope artifacts not produced by a single step. */
  jobName?: string;
  /** Absent for workflow-scope artifacts not produced by a single step. */
  stepName?: string;
}

/** Workflow-scoped data list. */
export interface WorkflowDataListData {
  workflowId: string;
  workflowName: string;
  runId: string;
  runStatus: string;
  groups: Array<{ type: string; items: WorkflowDataListItem[] }>;
  total: number;
}

export type DataListEvent =
  | { kind: "resolving" }
  | {
    kind: "completed";
    data: DataListData | WorkflowDataListData;
  }
  | { kind: "error"; error: SwampError };

export interface DataListInput {
  modelIdOrName?: string;
  workflowName?: string;
  runId?: string;
  typeFilter?: string;
}

/** Raw data entry from repository. */
interface RawDataEntry {
  id: string;
  name: string;
  version: number;
  contentType: string;
  type: string;
  streaming: boolean;
  size?: number;
  createdAt: Date;
}

/** Workflow data entry with model context. */
interface WorkflowDataEntry {
  data: RawDataEntry;
  modelId: string;
  modelName: string;
  modelType: ModelType;
  /** Absent for workflow-scope artifacts not produced by a single step. */
  jobName?: string;
  /** Absent for workflow-scope artifacts not produced by a single step. */
  stepName?: string;
}

/** Minimal workflow info for data list operations. */
export interface WorkflowInfo {
  id: string;
  name: string;
}

/** Minimal workflow run info for data list operations. */
export interface WorkflowRunInfo {
  id: string;
  status: string;
}

/** Dependencies for the data list operation. */
export interface DataListDeps {
  lookupDefinition: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  findAllForModel: (
    type: ModelType,
    definitionId: string,
  ) => Promise<RawDataEntry[]>;
  findWorkflow: (
    nameOrId: string,
  ) => Promise<WorkflowInfo | null>;
  findWorkflowRun: (
    workflowId: string,
    runId: string,
  ) => Promise<WorkflowRunInfo | null>;
  findLatestRun: (
    workflowId: string,
  ) => Promise<WorkflowRunInfo | null>;
  findAllForWorkflowRun: (
    workflowId: string,
    runId: string,
  ) => Promise<WorkflowDataEntry[]>;
}

/** Wires real infrastructure into DataListDeps. */
export function createDataListDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
): DataListDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  const dataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.data),
    createCatalogStore(repoDir, datastoreResolver),
  );
  const workflowRepo = new YamlWorkflowRepository(repoDir);
  const runRepo = new YamlWorkflowRunRepository(
    repoDir,
    undefined,
    dsPath(SWAMP_SUBDIRS.workflowRuns),
  );
  const workflowDataService = new WorkflowDataService(
    definitionRepo,
    dataRepo,
  );
  return {
    lookupDefinition: (idOrName) =>
      findDefinitionByIdOrName(definitionRepo, idOrName),
    findAllForModel: (type, definitionId) =>
      dataRepo.findAllForModel(type, definitionId),
    findWorkflow: async (nameOrId) => {
      const wf = await workflowRepo.findByName(nameOrId) ??
        await workflowRepo.findById(createWorkflowId(nameOrId));
      return wf ? { id: wf.id, name: wf.name } : null;
    },
    findWorkflowRun: async (workflowId, runId) => {
      const run = await runRepo.findById(
        createWorkflowId(workflowId),
        runId as ReturnType<typeof runRepo.nextId>,
      );
      return run ? { id: run.id, status: run.status } : null;
    },
    findLatestRun: async (workflowId) => {
      const run = await runRepo.findLatestByWorkflowId(
        createWorkflowId(workflowId),
      );
      return run ? { id: run.id, status: run.status } : null;
    },
    findAllForWorkflowRun: async (workflowId, runId) => {
      const fullRun = await runRepo.findById(
        createWorkflowId(workflowId),
        runId as ReturnType<typeof runRepo.nextId>,
      );
      if (!fullRun) return [];
      return workflowDataService.findAllForWorkflowRun(fullRun);
    },
  };
}

/** Standard type ordering for grouping. */
const STANDARD_TYPES = ["log", "file", "resource", "data"];

/** Groups data items by type tag, sorting standard types first. */
function groupByType<T extends { type: string }>(
  items: T[],
): Array<{ type: string; items: T[] }> {
  const grouped = new Map<string, T[]>();

  for (const item of items) {
    if (!grouped.has(item.type)) {
      grouped.set(item.type, []);
    }
    grouped.get(item.type)!.push(item);
  }

  const groups: Array<{ type: string; items: T[] }> = [];

  for (const type of STANDARD_TYPES) {
    const typeItems = grouped.get(type);
    if (typeItems) {
      groups.push({
        type,
        items: typeItems.sort((a, b) =>
          (a as unknown as { name: string }).name.localeCompare(
            (b as unknown as { name: string }).name,
          )
        ),
      });
      grouped.delete(type);
    }
  }

  const customTypes = Array.from(grouped.keys()).sort();
  for (const type of customTypes) {
    const typeItems = grouped.get(type)!;
    groups.push({
      type,
      items: typeItems.sort((a, b) =>
        (a as unknown as { name: string }).name.localeCompare(
          (b as unknown as { name: string }).name,
        )
      ),
    });
  }

  return groups;
}

/** Workflow-scoped data list. */
async function* workflowScopedList(
  deps: DataListDeps,
  input: DataListInput,
): AsyncIterable<DataListEvent> {
  const workflowName = input.workflowName!;

  const workflow = await deps.findWorkflow(workflowName);
  if (!workflow) {
    yield { kind: "error", error: notFound("Workflow", workflowName) };
    return;
  }

  let run: WorkflowRunInfo | null;
  if (input.runId) {
    run = await deps.findWorkflowRun(workflow.id, input.runId);
    if (!run) {
      yield {
        kind: "error",
        error: notFound(
          "Run",
          `"${input.runId}" for workflow: ${workflow.name}`,
        ),
      };
      return;
    }
  } else {
    run = await deps.findLatestRun(workflow.id);
    if (!run) {
      yield {
        kind: "error",
        error: notFound("Run", `for workflow: ${workflow.name}`),
      };
      return;
    }
  }

  const workflowData = await deps.findAllForWorkflowRun(workflow.id, run.id);

  const filteredData = input.typeFilter
    ? workflowData.filter((d) => d.data.type === input.typeFilter)
    : workflowData;

  const items: WorkflowDataListItem[] = filteredData.map((item) => {
    const listItem: WorkflowDataListItem = {
      id: item.data.id,
      name: item.data.name,
      version: item.data.version,
      contentType: item.data.contentType,
      type: item.data.type,
      streaming: item.data.streaming,
      size: item.data.size,
      createdAt: item.data.createdAt.toISOString(),
      modelId: item.modelId,
      modelName: item.modelName,
      modelType: item.modelType.normalized,
    };
    if (item.jobName !== undefined) listItem.jobName = item.jobName;
    if (item.stepName !== undefined) listItem.stepName = item.stepName;
    return listItem;
  });

  const groups = groupByType(items);

  yield {
    kind: "completed",
    data: {
      workflowId: workflow.id,
      workflowName: workflow.name,
      runId: run.id,
      runStatus: run.status,
      groups,
      total: filteredData.length,
    },
  };
}

/** Model-scoped data list. */
async function* modelScopedList(
  deps: DataListDeps,
  input: DataListInput,
): AsyncIterable<DataListEvent> {
  const modelIdOrName = input.modelIdOrName!;

  const result = await deps.lookupDefinition(modelIdOrName);
  if (!result) {
    yield { kind: "error", error: notFound("Model", modelIdOrName) };
    return;
  }
  const { definition, type: modelType } = result;

  const allData = await deps.findAllForModel(modelType, definition.id);

  const filteredData = input.typeFilter
    ? allData.filter((d) => d.type === input.typeFilter)
    : allData;

  const items: DataListItem[] = filteredData.map((data) => ({
    id: data.id,
    name: data.name,
    version: data.version,
    contentType: data.contentType,
    type: data.type,
    streaming: data.streaming,
    size: data.size,
    createdAt: data.createdAt.toISOString(),
  }));

  const groups = groupByType(items);

  yield {
    kind: "completed",
    data: {
      modelId: definition.id,
      modelName: definition.name,
      modelType: modelType.normalized,
      groups,
      total: filteredData.length,
    },
  };
}

/** Yields all data for a model or workflow, grouped by type. */
export async function* dataList(
  _ctx: LibSwampContext,
  deps: DataListDeps,
  input: DataListInput,
): AsyncIterable<DataListEvent> {
  yield* withGeneratorSpan(
    "swamp.data.list",
    {},
    (async function* () {
      yield { kind: "resolving" };

      if (input.modelIdOrName && input.workflowName) {
        yield {
          kind: "error",
          error: validationFailed(
            "Cannot specify both a model and --workflow. Use one or the other.",
          ),
        };
        return;
      }

      if (!input.modelIdOrName && !input.workflowName) {
        yield {
          kind: "error",
          error: validationFailed(
            "Either a model name or --workflow is required.",
          ),
        };
        return;
      }

      if (input.workflowName) {
        yield* workflowScopedList(deps, input);
      } else {
        yield* modelScopedList(deps, input);
      }
    })(),
  );
}
