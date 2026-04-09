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
import type { ModelType } from "../../domain/models/model_type.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { WorkflowDataService } from "../../domain/data/workflow_data_service.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import {
  SWAMP_SUBDIRS,
  toRelativePath,
} from "../../infrastructure/persistence/paths.ts";
import { createCatalogStore } from "../../infrastructure/persistence/repository_factory.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
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
}

export interface DataGetInput {
  modelIdOrName?: string;
  dataName?: string;
  workflowName?: string;
  runId?: string;
  version?: number;
  includeContent: boolean;
  repoDir: string;
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
  contentPath: string;
}

/** Minimal workflow shape. */
export interface WorkflowInfo {
  id: string;
  name: string;
}

/** Minimal workflow run shape. */
export interface WorkflowRunInfo {
  id: string;
}

export type DataGetEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: DataGetData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the data get operation. */
export interface DataGetDeps {
  lookupDefinition: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  findWorkflow: (idOrName: string) => Promise<WorkflowInfo | null>;
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
  ) => Promise<WorkflowDataItemInfo | null>;
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
): DataGetDeps {
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
  const workflowDataService = new WorkflowDataService(definitionRepo, dataRepo);
  return {
    lookupDefinition: (idOrName) =>
      findDefinitionByIdOrName(definitionRepo, idOrName),
    findWorkflow: async (idOrName) =>
      await workflowRepo.findByName(idOrName) ??
        await workflowRepo.findById(createWorkflowId(idOrName)),
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
      const allWorkflows = await workflowRepo.findAll();
      for (const wf of allWorkflows) {
        const fullRun = await runRepo.findById(
          wf.id,
          run.id as ReturnType<typeof runRepo.nextId>,
        );
        if (fullRun) {
          return await workflowDataService.findByNameInWorkflowRun(
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
        );
      }
    })(),
  );
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

  const workflow = await deps.findWorkflow(workflowName);
  if (!workflow) {
    yield { kind: "error", error: notFound("Workflow", workflowName) };
    return;
  }

  const run = await deps.findWorkflowRun(workflow.id, input.runId);
  if (!run) {
    const msg = input.runId
      ? `Run "${input.runId}" not found for workflow: ${workflow.name}`
      : `No runs found for workflow: ${workflow.name}`;
    yield { kind: "error", error: notFound("Workflow run", msg) };
    return;
  }

  const item = await deps.findDataInWorkflowRun(run, actualDataName, version);
  if (!item) {
    const versionInfo = version ? ` (version ${version})` : "";
    yield {
      kind: "error",
      error: notFound(
        "Data",
        `"${actualDataName}" in workflow "${workflow.name}"${versionInfo}`,
      ),
    };
    return;
  }

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
      output.content = new TextDecoder().decode(rawContent);
    }
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

  const result = await deps.lookupDefinition(modelIdOrName);
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
      output.content = new TextDecoder().decode(rawContent);
    }
  }

  yield { kind: "completed", data: output };
}
