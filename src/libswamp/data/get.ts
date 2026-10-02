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

import type { Definition } from "../../domain/definitions/definition.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import {
  findDefinitionByIdGlobal,
  findDefinitionByIdOrName,
} from "../../domain/models/model_lookup.ts";
import { WorkflowDataService } from "../../domain/data/workflow_data_service.ts";
import {
  dataQueryCommand,
  type DataQueryTarget,
} from "../../domain/data/data_query_command.ts";
import { isTextContentType } from "../../domain/data/content_type.ts";
import {
  type ContentEncoding,
  encodeContent,
} from "../../domain/data/content_encoding.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import { findWorkflowById } from "../../domain/workflows/workflow_lookup.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import {
  SWAMP_SUBDIRS,
  toRelativePath,
} from "../../infrastructure/persistence/paths.ts";
import {
  createCatalogStore,
  namespaceFromResolver,
} from "../../infrastructure/persistence/repository_factory.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import { selectLookup } from "../lookup_by_id.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound, validationFailed } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structure for the data get output.
 */
export interface DataGetData {
  id: string;
  name: string;
  modelId: string;
  modelName: string;
  modelType: string;
  version: number;
  contentType: string;
  lifetime: string;
  garbageCollection: string | number;
  streaming: boolean;
  tags: Record<string, string>;
  ownerDefinition: {
    definitionHash?: string;
    ownerType: string;
    ownerRef: string;
    workflowId?: string;
    workflowRunId?: string;
    workflowName?: string;
    jobName?: string;
    stepName?: string;
    source?: string;
  };
  createdAt: string;
  size?: number;
  checksum?: string;
  contentPath: string;
  content?: string;
  /**
   * How `content` is encoded. Set whenever `content` is: `utf-8` when the
   * stored bytes are valid UTF-8, `base64` otherwise (e.g. an image).
   */
  contentEncoding?: ContentEncoding;
  /**
   * The `swamp data query` command that reads this same item. `data get` is
   * deprecated in its favor; for a workflow-scoped read the query names the
   * run, job and step that produced the item.
   */
  replacementQuery?: string;
  /** Notices about this read, such as the deprecation of `data get`. */
  warnings?: string[];
  /**
   * For a workflow-scoped read, the other producers in the run whose data
   * matched the name (swamp-club#2948), each with the query that reads it
   * where one exists. Only producers the caller may read are listed.
   */
  alternatives?: DataGetAlternative[];
}

/** Another producer of the same data name in a workflow run. */
export interface DataGetAlternative {
  modelName: string;
  modelType: string;
  modelId: string;
  jobName?: string;
  stepName?: string;
  version: number;
  /** The `swamp data query` command that reads it, where one exists. */
  replacementQuery?: string;
}

export interface DataGetInput {
  modelIdOrName?: string;
  /**
   * Treat `modelIdOrName` as a definition id the caller already resolved,
   * and look it up by id only, so the operation acts on the model the caller
   * authorized.
   */
  byId?: boolean;
  /**
   * With `byId`, the name the caller authorized: ids are not guaranteed
   * unique, so only a resource with this name and the id is accepted.
   */
  expectedName?: string;
  dataName?: string;
  workflowName?: string;
  runId?: string;
  version?: number;
  includeContent: boolean;
  repoDir: string;
  /**
   * For a workflow-scoped read, the item the caller authorized, as
   * {@link resolveWorkflowData} located it. The read then finds the workflow
   * by this id and name only, reads exactly this run and version, and reports
   * not-found if the item it lands on belongs to any other owner — so what is
   * returned is what was authorized.
   */
  expectedOwner?: WorkflowDataPin;
  /**
   * Whether the caller may read data owned by this model. A workflow-scoped
   * read names other producers of the same data name in its warnings only
   * when they pass, so a caller never learns of data it cannot read. Every
   * producer passes when omitted.
   */
  canReadOwner?: (owner: DataOwnerInfo) => Promise<boolean>;
}

/** The model that owns a data item, as an authorization check sees it. */
export interface DataOwnerInfo {
  modelType: string;
  modelId: string;
  modelName: string;
}

/** The workflow-scoped item a caller authorized. */
export interface WorkflowDataPin {
  workflowId: string;
  workflowName: string;
  runId: string;
  modelType: string;
  modelId: string;
  version: number;
}

/** Minimal data item shape from model-scoped lookup. */
export interface DataItem {
  id: string;
  name: string;
  version: number;
  contentType: string;
  lifetime: string;
  garbageCollection: string | number;
  streaming: boolean;
  tags: Record<string, string>;
  ownerDefinition: {
    definitionHash?: string;
    ownerType: string;
    ownerRef: string;
    workflowId?: string;
    workflowRunId?: string;
    workflowName?: string;
    jobName?: string;
    stepName?: string;
    source?: string;
  };
  createdAt: Date;
  size?: number;
  checksum?: string;
}

/** Minimal workflow data item shape from workflow-scoped lookup. */
export interface WorkflowDataItemInfo {
  data: DataItem;
  modelType: ModelType;
  modelId: string;
  modelName: string;
  /** The job and step that produced the item; absent for workflow scope. */
  jobName?: string;
  stepName?: string;
  contentPath: string;
}

/**
 * The item a workflow-run lookup selected by name, and one item for each
 * other producer (job, step and model) whose data matched the name.
 */
export interface WorkflowDataMatchInfo {
  item: WorkflowDataItemInfo;
  otherProducers: WorkflowDataItemInfo[];
}

/** Minimal workflow shape. */
export interface WorkflowInfo {
  id: string;
  name: string;
}

/** Minimal workflow run shape. */
export interface WorkflowRunInfo {
  id: string;
  /** The workflow the run belongs to; scopes its data lookup to that run. */
  workflowId?: string;
  status?: string;
}

export type DataGetEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: DataGetData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the data get operation. */
export interface DataGetDeps {
  /** Looks up by name, then by exact id. */
  lookupDefinition: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  /** Looks up by exact id only; required for a `byId` request. */
  lookupDefinitionById?: (
    id: string,
    expectedName?: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  findWorkflow: (idOrName: string) => Promise<WorkflowInfo | null>;
  /**
   * Looks a workflow up by exact id only — with `expectedName`, only a
   * workflow with both. Required for a workflow-scoped read by id.
   */
  findWorkflowById?: (
    id: string,
    expectedName?: string,
  ) => Promise<WorkflowInfo | null>;
  findWorkflowRun: (
    workflowId: string,
    runId?: string,
  ) => Promise<WorkflowRunInfo | null>;
  findDataByName: (
    modelType: ModelType,
    modelId: string,
    name: string,
    version?: number,
  ) => Promise<DataItem | null>;
  findDataInWorkflowRun: (
    run: WorkflowRunInfo,
    dataName: string,
    version?: number,
  ) => Promise<WorkflowDataMatchInfo | null>;
  getContent: (
    modelType: ModelType,
    modelId: string,
    name: string,
    version: number,
  ) => Promise<Uint8Array | null>;
  getContentPath: (
    modelType: ModelType,
    modelId: string,
    name: string,
    version: number,
  ) => string;
  toRelativePath: (repoDir: string, absolutePath: string) => string;
}

/** Wires real infrastructure into DataGetDeps. */
export function createDataGetDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
  injectedDataRepo?: FileSystemUnifiedDataRepository,
  injectedWorkflowRepo?: WorkflowRepository,
  injectedDefinitionRepo?: YamlDefinitionRepository,
): DataGetDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const autoDefDir = dsPath(SWAMP_SUBDIRS.autoDefinitions);
  const definitionRepo = injectedDefinitionRepo ??
    new YamlDefinitionRepository(
      repoDir,
      undefined,
      undefined,
      autoDefDir ?? undefined,
    );
  const dataRepo = injectedDataRepo ?? new FileSystemUnifiedDataRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.data),
    createCatalogStore(repoDir, datastoreResolver),
    undefined,
    undefined,
    namespaceFromResolver(datastoreResolver),
  );
  const workflowRepo: WorkflowRepository = injectedWorkflowRepo ??
    new YamlWorkflowRepository(repoDir);
  const runRepo = new YamlWorkflowRunRepository(
    repoDir,
    undefined,
    dsPath(SWAMP_SUBDIRS.workflowRuns),
  );
  const workflowDataService = new WorkflowDataService(definitionRepo, dataRepo);
  return {
    lookupDefinition: (idOrName) =>
      findDefinitionByIdOrName(definitionRepo, idOrName),
    lookupDefinitionById: (id, expectedName) =>
      findDefinitionByIdGlobal(definitionRepo, id, expectedName),
    findWorkflow: async (idOrName) =>
      await workflowRepo.findByName(idOrName) ??
        await workflowRepo.findById(createWorkflowId(idOrName)),
    findWorkflowById: (id, expectedName) =>
      findWorkflowById(workflowRepo, id, expectedName),
    findWorkflowRun: async (workflowId, runId) => {
      const wfId = createWorkflowId(workflowId);
      if (runId) {
        return await runRepo.findById(
          wfId,
          runId as ReturnType<typeof runRepo.nextId>,
        );
      }
      return await runRepo.findLatestByWorkflowId(wfId);
    },
    findDataByName: (modelType, modelId, name, version) =>
      dataRepo.findByName(modelType, modelId, name, version),
    findDataInWorkflowRun: async (run, dataNameArg, version) => {
      if (run.workflowId) {
        const fullRun = await runRepo.findById(
          createWorkflowId(run.workflowId),
          run.id as ReturnType<typeof runRepo.nextId>,
        );
        return fullRun
          ? await workflowDataService.matchByNameInWorkflowRun(
            fullRun,
            dataNameArg,
            version,
          )
          : null;
      }
      const allWorkflows = await workflowRepo.findAll();
      for (const wf of allWorkflows) {
        const fullRun = await runRepo.findById(
          wf.id,
          run.id as ReturnType<typeof runRepo.nextId>,
        );
        if (fullRun) {
          return await workflowDataService.matchByNameInWorkflowRun(
            fullRun,
            dataNameArg,
            version,
          );
        }
      }
      return null;
    },
    getContent: (modelType, modelId, name, version) =>
      dataRepo.getContent(modelType, modelId, name, version),
    getContentPath: (modelType, modelId, name, version) =>
      dataRepo.getContentPath(modelType, modelId, name, version),
    toRelativePath,
  };
}

/** Retrieves data by model or workflow scope. */
export async function* dataGet(
  _ctx: LibSwampContext,
  deps: DataGetDeps,
  input: DataGetInput,
): AsyncIterable<DataGetEvent> {
  yield* withGeneratorSpan(
    "swamp.data.get",
    { "data.name": input.dataName },
    (async function* () {
      yield { kind: "resolving" };

      const { workflowName, modelIdOrName, dataName, version, repoDir } = input;

      // Validate arguments
      if (workflowName && modelIdOrName && dataName) {
        yield {
          kind: "error",
          error: validationFailed(
            "Too many arguments. Usage: swamp data get --workflow <name> <data_name>",
          ),
        };
        return;
      }
      if (!modelIdOrName && !workflowName) {
        yield {
          kind: "error",
          error: validationFailed(
            "Either a model name or --workflow is required.",
          ),
        };
        return;
      }

      if (workflowName) {
        yield* workflowScopedGet(deps, input, workflowName, repoDir, version);
      } else {
        yield* modelScopedGet(
          deps,
          modelIdOrName!,
          dataName,
          version,
          repoDir,
          input.includeContent,
          input.byId ?? false,
          input.expectedName,
        );
      }
    })(),
  );
}

/** A workflow-scoped item, located but not yet read. */
export interface WorkflowDataLocation {
  workflow: WorkflowInfo;
  run: WorkflowRunInfo;
  item: WorkflowDataItemInfo;
  /** Other producers in the run whose data matched the name. */
  otherProducers: WorkflowDataItemInfo[];
}

/** What {@link resolveWorkflowData} locates by. */
export interface WorkflowDataQuery {
  /** The workflow's id, looked up by id only (with `workflowName`, both). */
  workflowId: string;
  workflowName?: string;
  runId?: string;
  dataName: string;
  version?: number;
}

/**
 * Locates the item a workflow-scoped read would return — its workflow, run
 * and owner — without reading its content, so a caller can authorize the
 * owner first and then read exactly this item with
 * {@link DataGetInput.expectedOwner}.
 */
export async function resolveWorkflowData(
  deps: DataGetDeps,
  query: WorkflowDataQuery,
): Promise<
  | { kind: "found"; location: WorkflowDataLocation }
  | { kind: "error"; error: SwampError }
> {
  if (!deps.findWorkflowById) {
    throw new Error("resolveWorkflowData requires findWorkflowById");
  }
  const workflow = await deps.findWorkflowById(
    query.workflowId,
    query.workflowName,
  );
  if (!workflow) {
    return {
      kind: "error",
      error: notFound("Workflow", query.workflowName ?? query.workflowId),
    };
  }
  return await locateInWorkflow(deps, workflow, query);
}

async function locateInWorkflow(
  deps: DataGetDeps,
  workflow: WorkflowInfo,
  query: { runId?: string; dataName: string; version?: number },
): Promise<
  | { kind: "found"; location: WorkflowDataLocation }
  | { kind: "error"; error: SwampError }
> {
  const found = await deps.findWorkflowRun(workflow.id, query.runId);
  if (!found) {
    const msg = query.runId
      ? `Run "${query.runId}" not found for workflow: ${workflow.name}`
      : `No runs found for workflow: ${workflow.name}`;
    return { kind: "error", error: notFound("Workflow run", msg) };
  }
  const run: WorkflowRunInfo = { ...found, workflowId: workflow.id };

  const { dataName, version } = query;
  const match = await deps.findDataInWorkflowRun(run, dataName, version);
  if (!match) {
    const versionInfo = version ? ` (version ${version})` : "";
    const activeStatuses = new Set(["running", "pending", "suspended"]);
    if (run.status && activeStatuses.has(run.status)) {
      return {
        kind: "error",
        error: {
          code: "data_pending",
          message:
            `Data "${dataName}" not found in workflow "${workflow.name}"${versionInfo}. ` +
            `The latest run (${run.id}) is ${run.status}. ` +
            `If the producing step has completed, try the full instance name (e.g. '${dataName}-main'). ` +
            `Check progress with 'swamp workflow history ${workflow.name}'.`,
        },
      };
    }
    return {
      kind: "error",
      error: notFound(
        "Data",
        `"${dataName}" in workflow "${workflow.name}"${versionInfo}`,
      ),
    };
  }
  return {
    kind: "found",
    location: {
      workflow,
      run,
      item: match.item,
      otherProducers: match.otherProducers,
    },
  };
}

async function* workflowScopedGet(
  deps: DataGetDeps,
  input: DataGetInput,
  workflowName: string,
  repoDir: string,
  version?: number,
): AsyncIterable<DataGetEvent> {
  const { modelIdOrName, dataName } = input;

  if (!dataName && !modelIdOrName) {
    yield {
      kind: "error",
      error: validationFailed(
        "A data name is required when using --workflow. Usage: swamp data get --workflow <name> <data_name>",
      ),
    };
    return;
  }

  const actualDataName = modelIdOrName ?? dataName;
  if (!actualDataName) {
    yield {
      kind: "error",
      error: validationFailed(
        "A data name is required when using --workflow.",
      ),
    };
    return;
  }

  const pin = input.expectedOwner;
  let located;
  if (pin) {
    located = await resolveWorkflowData(deps, {
      workflowId: pin.workflowId,
      workflowName: pin.workflowName,
      runId: pin.runId,
      dataName: actualDataName,
      version: pin.version,
    });
    if (
      located.kind === "found" &&
      !matchesPin(located.location, pin)
    ) {
      located = {
        kind: "error" as const,
        error: notFound(
          "Data",
          `"${actualDataName}" in workflow run ${pin.runId}`,
        ),
      };
    } else if (located.kind === "found") {
      // The pin fixes the version that was authorized, which would hide
      // producers at other versions; find them under the caller's own
      // version constraint, as an unpinned read does.
      located.location.otherProducers = await producersBesides(
        deps,
        located.location,
        actualDataName,
        input.version,
      );
    }
  } else {
    const workflow = await deps.findWorkflow(workflowName);
    located = workflow
      ? await locateInWorkflow(deps, workflow, {
        runId: input.runId,
        dataName: actualDataName,
        version,
      })
      : { kind: "error" as const, error: notFound("Workflow", workflowName) };
  }
  if (located.kind === "error") {
    yield { kind: "error", error: located.error };
    return;
  }
  const { item } = located.location;

  const output: DataGetData = {
    id: item.data.id,
    name: item.data.name,
    modelId: item.modelId,
    modelName: item.modelName,
    modelType: item.modelType.normalized,
    version: item.data.version,
    contentType: item.data.contentType,
    lifetime: item.data.lifetime,
    garbageCollection: item.data.garbageCollection,
    streaming: item.data.streaming,
    tags: item.data.tags,
    ownerDefinition: item.data.ownerDefinition,
    createdAt: item.data.createdAt.toISOString(),
    size: item.data.size,
    checksum: item.data.checksum,
    contentPath: deps.toRelativePath(repoDir, item.contentPath),
  };

  if (input.includeContent) {
    const rawContent = await deps.getContent(
      item.modelType,
      item.modelId,
      item.data.name,
      item.data.version,
    );
    if (rawContent) {
      const { content, contentEncoding } = encodeContent(rawContent);
      output.content = content;
      output.contentEncoding = contentEncoding;
    }
  }

  const replacement = replacementFor(
    item.data,
    workflowQueryTarget(item),
    input.includeContent,
    output.contentEncoding,
  );
  output.replacementQuery = replacement.query;
  output.warnings = [deprecationWarning(replacement, false)];
  const shared = await sharedNameNotice(
    located.location,
    input.canReadOwner,
    input.includeContent,
  );
  if (shared) {
    output.alternatives = shared.alternatives;
    output.warnings.push(shared.warning);
  }

  yield { kind: "completed", data: output };
}

async function* modelScopedGet(
  deps: DataGetDeps,
  modelIdOrName: string,
  dataName: string | undefined,
  version: number | undefined,
  repoDir: string,
  includeContent: boolean,
  byId: boolean,
  expectedName?: string,
): AsyncIterable<DataGetEvent> {
  if (!dataName) {
    yield {
      kind: "error",
      error: validationFailed(
        "A data name is required. Usage: swamp data get <model> <data_name>",
      ),
    };
    return;
  }

  const lookupDefinition = selectLookup(
    "data get",
    byId,
    deps.lookupDefinition,
    deps.lookupDefinitionById,
    expectedName,
  );
  const result = await lookupDefinition(modelIdOrName);
  if (!result) {
    yield { kind: "error", error: notFound("Model", modelIdOrName) };
    return;
  }

  const { definition, type: modelType } = result;
  const data = await deps.findDataByName(
    modelType,
    definition.id,
    dataName,
    version,
  );

  if (!data) {
    const versionInfo = version ? ` (version ${version})` : "";
    yield {
      kind: "error",
      error: notFound(
        "Data",
        `"${dataName}" for model "${modelIdOrName}"${versionInfo}`,
      ),
    };
    return;
  }

  const resolvedName = data.name;
  const absoluteContentPath = deps.getContentPath(
    modelType,
    definition.id,
    resolvedName,
    data.version,
  );

  const output: DataGetData = {
    id: data.id,
    name: data.name,
    modelId: definition.id,
    modelName: definition.name,
    modelType: modelType.normalized,
    version: data.version,
    contentType: data.contentType,
    lifetime: data.lifetime,
    garbageCollection: data.garbageCollection,
    streaming: data.streaming,
    tags: data.tags,
    ownerDefinition: data.ownerDefinition,
    createdAt: data.createdAt.toISOString(),
    size: data.size,
    checksum: data.checksum,
    contentPath: deps.toRelativePath(repoDir, absoluteContentPath),
  };

  if (includeContent) {
    const rawContent = await deps.getContent(
      modelType,
      definition.id,
      resolvedName,
      data.version,
    );
    if (rawContent) {
      const { content, contentEncoding } = encodeContent(rawContent);
      output.content = content;
      output.contentEncoding = contentEncoding;
    }
  }

  const replacement = replacementFor(
    data,
    {
      modelType: modelType.normalized,
      modelId: definition.id,
      dataName: data.name,
      version: data.version,
    },
    includeContent,
    output.contentEncoding,
  );
  output.replacementQuery = replacement.query;
  output.warnings = [deprecationWarning(replacement, version === undefined)];

  yield { kind: "completed", data: output };
}

/**
 * The `swamp data query` command that reads the same item as a `data get`
 * read, or why none can read it yet.
 */
type Replacement =
  | { query: string; unavailable?: undefined }
  | { query?: undefined; unavailable: string };

/**
 * Builds the replacement for `data`. A query returns content only for a
 * textual content type, decoded as UTF-8, so a read whose content came back
 * base64-encoded — binary, or text that is not UTF-8 — has none yet.
 */
function replacementFor(
  data: DataItem,
  target: DataQueryTarget,
  includeContent: boolean,
  contentEncoding?: ContentEncoding,
): Replacement {
  if (
    includeContent &&
    (!isTextContentType(data.contentType) || contentEncoding === "base64")
  ) {
    return {
      unavailable: "data query returns content only as UTF-8 text, and this " +
        "item's content is not (swamp-club#2959)",
    };
  }
  return { query: dataQueryCommand(target, { includeContent }) };
}

/**
 * The deprecation notice a `data get` read carries, naming the query that
 * reads the same item. A read of the latest version is pinned to that
 * version, so the notice says how to follow later versions instead.
 */
function deprecationWarning(
  replacement: Replacement,
  readLatest: boolean,
): string {
  if (replacement.unavailable !== undefined) {
    return "swamp data get is deprecated, but no data query reads this item " +
      `yet: ${replacement.unavailable}. Keep using data get for it.`;
  }
  const notice = "swamp data get is deprecated and will be removed in a " +
    `future release. Read this item with: ${replacement.query}`;
  return readLatest
    ? `${notice} (to follow the latest version instead, drop the version ` +
      "clause; if several workflow steps wrote this item, also narrow by " +
      "stepName)"
    : notice;
}

/**
 * The query coordinates of a workflow-run item, from what the item itself
 * records — the catalog indexes those fields, not the run's. Step output
 * records its run, job and step. Report output records none, so it is named
 * by its owner's type and id, its data name and version instead.
 */
function workflowQueryTarget(item: WorkflowDataItemInfo): DataQueryTarget {
  const owner = item.data.ownerDefinition;
  const target: DataQueryTarget = {
    dataName: item.data.name,
    version: item.data.version,
  };
  if (owner.workflowRunId) {
    target.workflowRunId = owner.workflowRunId;
    if (owner.jobName) target.jobName = owner.jobName;
    if (owner.stepName) target.stepName = owner.stepName;
  } else {
    target.modelType = item.modelType.normalized;
    target.modelId = item.modelId;
  }
  return target;
}

/** Identifies the job, step and owning model that produced an item. */
function producerKey(item: WorkflowDataItemInfo): string {
  return JSON.stringify([
    item.modelType.normalized,
    item.modelId,
    item.jobName ?? null,
    item.stepName ?? null,
  ]);
}

/**
 * The producers in `location`'s run, other than the selected item's, whose
 * data matches `dataName` under `version`.
 */
async function producersBesides(
  deps: DataGetDeps,
  location: WorkflowDataLocation,
  dataName: string,
  version: number | undefined,
): Promise<WorkflowDataItemInfo[]> {
  const match = await deps.findDataInWorkflowRun(
    location.run,
    dataName,
    version,
  );
  if (!match) return [];
  const selected = producerKey(location.item);
  return [match.item, ...match.otherProducers].filter((candidate) =>
    producerKey(candidate) !== selected
  );
}

/** Names the producer of a workflow-run item for a warning. */
function producerLabel(item: WorkflowDataItemInfo): string {
  if (item.jobName === undefined && item.stepName === undefined) {
    return item.modelName;
  }
  return `job ${item.jobName ?? "-"}, step ${
    item.stepName ?? "-"
  } (${item.modelName})`;
}

/**
 * Whether the caller may read `item`'s owner. A failed check leaves the
 * producer out: the warning is advisory and must not fail the read.
 */
async function isReadable(
  item: WorkflowDataItemInfo,
  canReadOwner: DataGetInput["canReadOwner"],
): Promise<boolean> {
  if (!canReadOwner) return true;
  try {
    return await canReadOwner({
      modelType: item.modelType.normalized,
      modelId: item.modelId,
      modelName: item.modelName,
    });
  } catch {
    return false;
  }
}

/**
 * Notes that other producers in the run wrote data with the same name, so
 * the item returned is one of several (swamp-club#2948), with the query that
 * reads each of them. Only producers the caller may read are named or
 * counted.
 */
async function sharedNameNotice(
  location: WorkflowDataLocation,
  canReadOwner: DataGetInput["canReadOwner"],
  includeContent: boolean,
): Promise<
  { warning: string; alternatives: DataGetAlternative[] } | undefined
> {
  const readable: WorkflowDataItemInfo[] = [];
  for (const other of location.otherProducers) {
    if (await isReadable(other, canReadOwner)) readable.push(other);
  }
  if (readable.length === 0) return undefined;
  const alternatives = readable.map((other): DataGetAlternative => ({
    modelName: other.modelName,
    modelType: other.modelType.normalized,
    modelId: other.modelId,
    jobName: other.jobName,
    stepName: other.stepName,
    version: other.data.version,
    replacementQuery: replacementFor(
      other.data,
      workflowQueryTarget(other),
      includeContent,
    ).query,
  }));
  const others = readable.map((other, i) => {
    const query = alternatives[i].replacementQuery;
    return query
      ? `${producerLabel(other)}, read with: ${query}`
      : producerLabel(other);
  });
  const { item, run } = location;
  return {
    warning: `${readable.length + 1} items in run ${run.id} are named ` +
      `"${item.data.name}"; data get returned the one from ` +
      `${producerLabel(item)}. The others: ${others.join(" | ")}`,
    alternatives,
  };
}

/** Whether a located item is exactly the one a caller authorized. */
function matchesPin(
  location: WorkflowDataLocation,
  pin: WorkflowDataPin,
): boolean {
  return location.workflow.id === pin.workflowId &&
    location.run.id === pin.runId &&
    location.item.modelType.normalized === pin.modelType &&
    location.item.modelId === pin.modelId &&
    location.item.data.version === pin.version;
}
