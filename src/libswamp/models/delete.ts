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
import type { DefinitionId } from "../../domain/definitions/definition.ts";
import type { Data } from "../../domain/data/data.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import {
  createCatalogStore,
  namespaceFromResolver,
} from "../../infrastructure/persistence/repository_factory.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import { createModelOutputId } from "../../domain/models/model_output.ts";
import { DefaultDataLifecycleService } from "../../domain/data/data_lifecycle_service.ts";
import { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound, validationFailed } from "../errors.ts";
import { getLogger } from "@logtape/logtape";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/** Preview data returned before confirmation. */
export interface ModelDeletePreview {
  id: string;
  name: string;
  type: string;
  definitionPath: string;
  referencingWorkflows: string[];
  dataArtifactCount: number;
  outputCount: number;
}

/** Data structure for the model delete completed event. */
export interface ModelDeleteData {
  id: string;
  name: string;
  type: string;
  inputPath: string;
  resourceDeleted: boolean;
  outputsDeleted: number;
  evaluatedInputDeleted: boolean;
  dataDeleted: boolean;
  expiredDataAutoCollected: number;
}

export type ModelDeleteEvent =
  | { kind: "deleting" }
  | { kind: "completed"; data: ModelDeleteData }
  | { kind: "error"; error: SwampError };

/** Input for the model delete operation. */
export interface ModelDeleteInput {
  modelIdOrName: string;
  force: boolean;
}

/** Dependencies for the model delete operation. */
export interface ModelDeleteDeps {
  lookupDefinition: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  findAllWorkflows: () => Promise<Workflow[]>;
  findDataArtifacts: (
    type: ModelType,
    id: DefinitionId,
  ) => Promise<Data[]>;
  findOutputs: (
    type: ModelType,
    id: DefinitionId,
  ) => Promise<{ id: string; methodName: string }[]>;
  getDefinitionPath: (type: ModelType, id: DefinitionId) => string;
  deleteOutput: (
    type: ModelType,
    methodName: string,
    id: string,
  ) => Promise<void>;
  deleteData: (
    type: ModelType,
    defId: DefinitionId,
    name: string,
  ) => Promise<void>;
  deleteDefinition: (type: ModelType, id: DefinitionId) => Promise<void>;
  isExpired?: (data: Data) => Promise<boolean>;
}

/** Wires real infrastructure into ModelDeleteDeps. */
export function createModelDeleteDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
  injectedDataRepo?: FileSystemUnifiedDataRepository,
  markDirty?: MarkDirtyHook,
): ModelDeleteDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  const workflowRepo = new YamlWorkflowRepository(repoDir);
  // Reuse an injected shared data repo (e.g. serve's process-scoped
  // RepositoryContext) so we don't open a new file-based catalog store — and
  // leak its 3 FDs — on every request.
  const unifiedDataRepo = injectedDataRepo ??
    new FileSystemUnifiedDataRepository(
      repoDir,
      dsPath(SWAMP_SUBDIRS.data),
      createCatalogStore(repoDir, datastoreResolver),
      markDirty,
      undefined,
      namespaceFromResolver(datastoreResolver),
    );
  const outputRepo = new YamlOutputRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.outputs),
  );
  const workflowRunRepo = new YamlWorkflowRunRepository(
    repoDir,
    undefined,
    dsPath(SWAMP_SUBDIRS.workflowRuns),
  );
  const lifecycleService = new DefaultDataLifecycleService(
    unifiedDataRepo,
    workflowRunRepo,
  );
  return {
    lookupDefinition: (idOrName) =>
      findDefinitionByIdOrName(definitionRepo, idOrName),
    findAllWorkflows: () => workflowRepo.findAll(),
    findDataArtifacts: (type, id) => unifiedDataRepo.findAllForModel(type, id),
    findOutputs: (type, id) => outputRepo.findByDefinition(type, id),
    getDefinitionPath: (type, id) => definitionRepo.getPath(type, id),
    deleteOutput: (type, methodName, id) =>
      outputRepo.delete(type, methodName, createModelOutputId(id)),
    deleteData: (type, defId, name) =>
      unifiedDataRepo.delete(type, defId, name),
    deleteDefinition: (type, id) => definitionRepo.delete(type, id),
    isExpired: (data) => lifecycleService.isExpired(data),
  };
}

/**
 * Finds all workflows that reference a model by ID or name.
 */
function findWorkflowsReferencingModel(
  workflows: Workflow[],
  modelId: string,
  modelName: string,
): string[] {
  const names: string[] = [];
  for (const workflow of workflows) {
    let found = false;
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        if (step.task.isModelMethod()) {
          const taskData = step.task.data;
          if (taskData.type === "model_method") {
            const ref = taskData.modelIdOrName;
            if (ref === modelId || ref === modelName) {
              found = true;
              break;
            }
          }
        }
      }
      if (found) break;
    }
    if (found) names.push(workflow.name);
  }
  return names;
}

/**
 * Partitions data artifacts into live and expired, using the isExpired
 * predicate when available. Expired artifacts don't block model deletion.
 */
async function partitionExpired(
  dataArtifacts: Data[],
  isExpired?: (data: Data) => Promise<boolean>,
): Promise<{ live: Data[]; expired: Data[] }> {
  if (!isExpired) return { live: dataArtifacts, expired: [] };
  const logger = getLogger(["swamp", "model", "delete"]);
  const live: Data[] = [];
  const expired: Data[] = [];
  for (const data of dataArtifacts) {
    try {
      if (await isExpired(data)) {
        expired.push(data);
      } else {
        live.push(data);
      }
    } catch {
      logger
        .warn`Failed to check expiration for ${data.name}, treating as live`;
      live.push(data);
    }
  }
  return { live, expired };
}

/** Gathers preview info for the model delete operation. */
export async function modelDeletePreview(
  ctx: LibSwampContext,
  deps: ModelDeleteDeps,
  input: ModelDeleteInput,
): Promise<ModelDeletePreview> {
  ctx.logger.debug`Looking up model: ${input.modelIdOrName}`;
  const result = await deps.lookupDefinition(input.modelIdOrName);
  if (!result) {
    throw notFound("Model", input.modelIdOrName);
  }
  const { definition, type: modelType } = result;

  const allWorkflows = await deps.findAllWorkflows();
  const referencingWorkflows = findWorkflowsReferencingModel(
    allWorkflows,
    definition.id,
    definition.name,
  );

  const dataArtifacts = await deps.findDataArtifacts(
    modelType,
    definition.id,
  );
  const { live } = await partitionExpired(dataArtifacts, deps.isExpired);
  const outputs = await deps.findOutputs(modelType, definition.id);

  return {
    id: definition.id,
    name: definition.name,
    type: modelType.normalized,
    definitionPath: deps.getDefinitionPath(modelType, definition.id),
    referencingWorkflows,
    dataArtifactCount: live.length,
    outputCount: outputs.length,
  };
}

/** Deletes a model and all related artifacts. */
export async function* modelDelete(
  ctx: LibSwampContext,
  deps: ModelDeleteDeps,
  input: ModelDeleteInput,
): AsyncIterable<ModelDeleteEvent> {
  yield* withGeneratorSpan(
    "swamp.model.delete",
    { "model.id_or_name": input.modelIdOrName },
    (async function* () {
      yield { kind: "deleting" };

      const result = await deps.lookupDefinition(input.modelIdOrName);
      if (!result) {
        yield { kind: "error", error: notFound("Model", input.modelIdOrName) };
        return;
      }
      const { definition, type: modelType } = result;

      // Check workflow references
      const allWorkflows = await deps.findAllWorkflows();
      const referencingWorkflows = findWorkflowsReferencingModel(
        allWorkflows,
        definition.id,
        definition.name,
      );
      if (referencingWorkflows.length > 0) {
        yield {
          kind: "error",
          error: validationFailed(
            `Model '${definition.name}' is referenced by workflow(s): ${
              referencingWorkflows.join(", ")
            }. ` +
              `Remove the model from these workflows before deleting.`,
          ),
        };
        return;
      }

      // Check data artifacts — expired data is auto-collected, not a blocker
      const dataArtifacts = await deps.findDataArtifacts(
        modelType,
        definition.id,
      );
      const { live, expired } = await partitionExpired(
        dataArtifacts,
        deps.isExpired,
      );
      if (live.length > 0 && !input.force) {
        yield {
          kind: "error",
          error: validationFailed(
            `Model '${definition.name}' has ${live.length} associated data artifact(s). ` +
              `Delete the data first, or use --force to delete all.`,
          ),
        };
        return;
      }

      const definitionPath = deps.getDefinitionPath(modelType, definition.id);

      // Delete outputs
      const outputs = await deps.findOutputs(modelType, definition.id);
      let outputsDeleted = 0;
      for (const output of outputs) {
        ctx.logger.debug`Deleting output: ${output.id}`;
        await deps.deleteOutput(modelType, output.methodName, output.id);
        outputsDeleted++;
      }

      // Auto-collect expired data artifacts
      let expiredDataAutoCollected = 0;
      for (const data of expired) {
        ctx.logger.debug`Auto-collecting expired data: ${data.name}`;
        await deps.deleteData(modelType, definition.id, data.name);
        expiredDataAutoCollected++;
      }

      // Delete remaining data artifacts (force mode)
      let dataDeleted = false;
      for (const data of live) {
        ctx.logger.debug`Deleting data artifact: ${data.name}`;
        await deps.deleteData(modelType, definition.id, data.name);
        dataDeleted = true;
      }

      // Delete definition
      ctx.logger.debug`Deleting definition: ${definition.id}`;
      await deps.deleteDefinition(modelType, definition.id);

      yield {
        kind: "completed",
        data: {
          id: definition.id,
          name: definition.name,
          type: modelType.normalized,
          inputPath: definitionPath,
          resourceDeleted: false,
          outputsDeleted,
          evaluatedInputDeleted: false,
          dataDeleted,
          expiredDataAutoCollected,
        },
      };
    })(),
  );
}
