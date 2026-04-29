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
  /** Populated when --content was requested. JSON-typed entries are parsed
   * to their structured value; everything else is included as a string. */
  content?: unknown;
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
  jobName: string;
  stepName: string;
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
  /** When true, include `content` on each returned item. Avoids the
   * fan-out pattern of `data list` followed by N × `data get`. */
  includeContent?: boolean;
  /** Skip content for items larger than this many bytes (per item).
   * Defaults to 1 MiB. */
  maxContentBytes?: number;
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
  jobName: string;
  stepName: string;
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
  /** Reads the raw bytes for a data record. Optional — only used when
   * `--content` is requested. Mirrors the `getContent` shape on
   * `DataGetDeps`. */
  getContent?: (
    type: ModelType,
    definitionId: string,
    name: string,
    version: number,
  ) => Promise<Uint8Array | null>;
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
    getContent: (type, definitionId, name, version) =>
      dataRepo.getContent(type, definitionId, name, version),
  };
}

const DEFAULT_MAX_CONTENT_BYTES = 1024 * 1024;

/** Reads + decodes content for one entry. Returns undefined if the entry
 * exceeds `maxBytes`, has no content, or fails to read. JSON content is
 * parsed; everything else is returned as a UTF-8 string. */
async function fetchEntryContent(
  deps: DataListDeps,
  modelType: ModelType,
  modelId: string,
  name: string,
  version: number,
  contentType: string,
  size: number | undefined,
  maxBytes: number,
): Promise<unknown> {
  if (!deps.getContent) return undefined;
  if (size !== undefined && size > maxBytes) return undefined;

  let raw: Uint8Array | null;
  try {
    raw = await deps.getContent(modelType, modelId, name, version);
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  if (raw.byteLength > maxBytes) return undefined;

  const text = new TextDecoder().decode(raw);
  if (contentType.includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
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

  const maxBytes = input.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
  const items: WorkflowDataListItem[] = await Promise.all(
    filteredData.map(async (item) => {
      const content = input.includeContent
        ? await fetchEntryContent(
          deps,
          item.modelType,
          item.modelId,
          item.data.name,
          item.data.version,
          item.data.contentType,
          item.data.size,
          maxBytes,
        )
        : undefined;
      return {
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
        jobName: item.jobName,
        stepName: item.stepName,
        ...(content !== undefined ? { content } : {}),
      };
    }),
  );

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

  const maxBytes = input.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES;
  const items: DataListItem[] = await Promise.all(
    filteredData.map(async (data) => {
      const content = input.includeContent
        ? await fetchEntryContent(
          deps,
          modelType,
          definition.id,
          data.name,
          data.version,
          data.contentType,
          data.size,
          maxBytes,
        )
        : undefined;
      return {
        id: data.id,
        name: data.name,
        version: data.version,
        contentType: data.contentType,
        type: data.type,
        streaming: data.streaming,
        size: data.size,
        createdAt: data.createdAt.toISOString(),
        ...(content !== undefined ? { content } : {}),
      };
    }),
  );

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
