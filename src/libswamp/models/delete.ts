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
import {
  findDefinitionByIdGlobal,
  findDefinitionByIdOrName,
} from "../../domain/models/model_lookup.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { YamlEvaluatedDefinitionRepository } from "../../infrastructure/persistence/yaml_evaluated_definition_repository.ts";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { resolveDurableWrites } from "../../domain/datastore/datastore_config.ts";
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
import { selectLookup } from "../lookup_by_id.ts";
import type { LibSwampContext } from "../context.ts";
import { withUnitOfWork } from "../unit_of_work.ts";
import type { SwampError } from "../errors.ts";
import {
  behaviorNotFound,
  validationFailed,
  wordedSwampError,
} from "../errors.ts";
import { isIntegrationModelType } from "../../domain/models/control_plane_types.ts";
import { wordedText } from "../../domain/behavior_wording.ts";
import { getLogger } from "@logtape/logtape";

import {
  activeSpanAttributeSetter,
  withGeneratorSpan,
} from "../../infrastructure/tracing/mod.ts";
import {
  currentDiagnosticTally,
  type DiagnosticPhaseHandle,
  observeDiagnosticPhase,
  withGeneratorDiagnosticPhase,
} from "../../domain/diagnostics/diagnostic_phase.ts";
export interface ModelDeletePreview {
  id: string;
  name: string;
  type: string;
  definitionPath: string;
  referencingWorkflows: string[];
  dataArtifactCount: number;
  outputCount: number;
}

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

function lookupModel(
  deps: ModelDeleteDeps,
  input: ModelDeleteInput,
): Promise<{ definition: Definition; type: ModelType } | null> {
  return selectLookup(
    "model delete",
    input.byId,
    deps.lookupDefinition,
    deps.lookupDefinitionById,
    input.expectedName,
  )(input.modelIdOrName);
}

export interface ModelDeleteInput {
  modelIdOrName: string;
  force: boolean;
  /**
   * Treat `modelIdOrName` as a definition id the caller already resolved,
   * and look it up by id only, so the delete acts on the model the caller
   * authorized.
   */
  byId?: boolean;
  /**
   * With `byId`, the name the caller authorized: ids are not guaranteed
   * unique, so only a resource with this name and the id is accepted.
   */
  expectedName?: string;
  /**
   * The principal that sent the request, as `kind:id`. It is recorded on the
   * span as `auth.principal.id` and is never used to authorize the delete.
   */
  principalId?: string;
}

export interface ModelDeleteDeps {
  lookupDefinition: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  lookupDefinitionById?: (
    id: string,
    expectedName?: string,
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
  deleteDefinition: (
    type: ModelType,
    id: DefinitionId,
    name?: string,
  ) => Promise<void>;
  deleteEvaluatedDefinition: (
    type: ModelType,
    id: DefinitionId,
  ) => Promise<void>;
  isExpired?: (data: Data) => Promise<boolean>;
  /**
   * asks serve, before anything is removed, whether every removal will be
   * allowed; undefined when it will, or when nothing can ask
   */
  preflightDelete?: (plan: ModelDeletePlan) => Promise<SwampError | undefined>;
}

/** what a delete will remove beyond the definition itself */
export interface ModelDeletePlan {
  readonly type: ModelType;
  readonly definition: Definition;
  readonly outputs: readonly { id: string; methodName: string }[];
  readonly data: readonly { name: string; version: number }[];
}

export function createModelDeleteDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
  injectedDataRepo?: FileSystemUnifiedDataRepository,
  markDirty?: MarkDirtyHook,
  injectedDefinitionRepo?: YamlDefinitionRepository,
): ModelDeleteDeps {
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const definitionRepo = injectedDefinitionRepo ??
    new YamlDefinitionRepository(
      repoDir,
      undefined,
      undefined,
      undefined,
      markDirty,
    );
  const evaluatedDefinitionRepo = new YamlEvaluatedDefinitionRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.definitionsEvaluated),
    markDirty,
  );
  const workflowRepo = new YamlWorkflowRepository(repoDir);
  // reuse an injected shared data repo so each request does not open a new
  // file-based catalog store and leak its file descriptors
  const unifiedDataRepo = injectedDataRepo ??
    new FileSystemUnifiedDataRepository(
      repoDir,
      dsPath(SWAMP_SUBDIRS.data),
      createCatalogStore(repoDir, datastoreResolver),
      markDirty,
      undefined,
      namespaceFromResolver(datastoreResolver),
      undefined,
      undefined,
      undefined,
      undefined,
      resolveDurableWrites(datastoreResolver?.config()),
    );
  const outputRepo = new YamlOutputRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.outputs),
    markDirty,
  );
  const workflowRunRepo = new YamlWorkflowRunRepository(
    repoDir,
    undefined,
    dsPath(SWAMP_SUBDIRS.workflowRuns),
    markDirty,
  );
  const lifecycleService = new DefaultDataLifecycleService(
    unifiedDataRepo,
    workflowRunRepo,
  );
  return {
    lookupDefinition: (idOrName) =>
      findDefinitionByIdOrName(definitionRepo, idOrName),
    lookupDefinitionById: (id, expectedName) =>
      findDefinitionByIdGlobal(definitionRepo, id, expectedName),
    findAllWorkflows: () => workflowRepo.findAll(),
    findDataArtifacts: (type, id) => unifiedDataRepo.findAllForModel(type, id),
    findOutputs: (type, id) => outputRepo.findByDefinition(type, id),
    getDefinitionPath: (type, id) => definitionRepo.getPath(type, id),
    deleteOutput: (type, methodName, id) =>
      outputRepo.delete(type, methodName, createModelOutputId(id)),
    deleteData: (type, defId, name) =>
      unifiedDataRepo.delete(type, defId, name),
    deleteDefinition: (type, id, name) => definitionRepo.delete(type, id, name),
    deleteEvaluatedDefinition: (type, id) =>
      evaluatedDefinitionRepo.delete(type, id),
    isExpired: (data) => lifecycleService.isExpired(data),
  };
}

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

async function partitionExpired(
  dataArtifacts: Data[],
  isExpired?: (data: Data) => Promise<boolean>,
): Promise<{ live: Data[]; expired: Data[] }> {
  const tally = currentDiagnosticTally();
  if (!isExpired) {
    tally.add("live", dataArtifacts.length);
    return { live: dataArtifacts, expired: [] };
  }
  const logger = getLogger(["swamp", "model", "delete"]);
  const live: Data[] = [];
  const expired: Data[] = [];
  for (const data of dataArtifacts) {
    tally.add("checked");
    try {
      if (await isExpired(data)) {
        expired.push(data);
      } else {
        live.push(data);
      }
    } catch {
      logger
        .warn`Failed to check expiration for ${data.name}, treating as live`;
      tally.add("check_failed");
      live.push(data);
    }
  }
  tally.add("expired", expired.length);
  tally.add("live", live.length);
  return { live, expired };
}

export async function modelDeletePreview(
  ctx: LibSwampContext,
  deps: ModelDeleteDeps,
  input: ModelDeleteInput,
): Promise<ModelDeletePreview> {
  ctx.logger.debug`Looking up model: ${input.modelIdOrName}`;
  const result = await lookupModel(deps, input);
  if (!result) {
    throw behaviorNotFound(input.modelIdOrName);
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

export async function* modelDelete(
  ctx: LibSwampContext,
  deps: ModelDeleteDeps,
  input: ModelDeleteInput,
): AsyncIterable<ModelDeleteEvent> {
  yield* withUnitOfWork(ctx, () =>
    withGeneratorSpan(
      "swamp.model.delete",
      {
        "model.id_or_name": input.modelIdOrName,
        ...(input.principalId
          ? { "auth.principal.id": input.principalId }
          : {}),
      },
      // Phases export only inside a diagnostic area: worker prune runs this
      // as worker_delete; a plain model delete exports none.
      withGeneratorDiagnosticPhase("model_delete", {}, (phase) => {
        // Bound to swamp.model.delete before the phase becomes the active
        // span, so the model's identity stays on the span queries select.
        const setDeleteSpanAttributes = activeSpanAttributeSetter();
        return deleteStages(ctx, deps, input, phase, setDeleteSpanAttributes);
      }),
    ));
}

async function* deleteStages(
  ctx: LibSwampContext,
  deps: ModelDeleteDeps,
  input: ModelDeleteInput,
  phase: DiagnosticPhaseHandle,
  setDeleteSpanAttributes: ReturnType<typeof activeSpanAttributeSetter>,
): AsyncGenerator<ModelDeleteEvent> {
  // A refusal is reported as an event, not thrown: end the phase as the
  // failure it is, with a bounded reason.
  const refuse = (
    reason:
      | "not_found"
      | "workflow_referenced"
      | "live_data"
      | "integration_record",
    error: SwampError,
  ): ModelDeleteEvent => {
    phase.attributes({ "swamp.diagnostic.refusal": reason });
    phase.end("error");
    return { kind: "error", error };
  };

  yield { kind: "deleting" };

  const result = await observeDiagnosticPhase(
    "definition_resolve",
    {},
    async (resolve) => {
      const found = await lookupModel(deps, input);
      resolve.attributes({ "swamp.diagnostic.hit": found !== null });
      return found;
    },
  );
  if (!result) {
    yield refuse("not_found", behaviorNotFound(input.modelIdOrName));
    return;
  }
  const { definition, type: modelType } = result;
  if (isIntegrationModelType(modelType.normalized)) {
    yield refuse(
      "integration_record",
      validationFailed(
        `Behavior ${definition.name} holds an integration's record. It can't be deleted, because its id must stay reserved: tokens issued to it would come back to life. To stop it being used, revoke it with swamp access integration revoke`,
      ),
    );
    return;
  }
  setDeleteSpanAttributes({
    "model.name": definition.name,
    "model.type": modelType.normalized,
    "model.id": definition.id,
  });
  phase.attributes({
    "swamp.diagnostic.definition_type": modelType.normalized,
  });

  const referencingWorkflows = await observeDiagnosticPhase(
    "workflow_reference_check",
    {},
    async ({ tally }) => {
      const allWorkflows = await deps.findAllWorkflows();
      tally.add("workflows", allWorkflows.length);
      const referencing = tally.measureSync(
        "reference_match",
        () =>
          findWorkflowsReferencingModel(
            allWorkflows,
            definition.id,
            definition.name,
          ),
      );
      tally.add("referencing", referencing.length);
      return referencing;
    },
  );
  if (referencingWorkflows.length > 0) {
    yield refuse(
      "workflow_referenced",
      wordedSwampError(
        "validation_failed",
        wordedText((w) =>
          `${w.Noun} '${definition.name}' is referenced by workflow(s): ${
            referencingWorkflows.join(", ")
          }. ` +
          `Remove the ${w.noun} from these workflows before deleting.`
        ),
      ),
    );
    return;
  }

  const dataArtifacts = await observeDiagnosticPhase(
    "data_discovery",
    {},
    async ({ tally }) => {
      const found = await deps.findDataArtifacts(modelType, definition.id);
      tally.add("artifacts", found.length);
      return found;
    },
  );
  const { live, expired } = await observeDiagnosticPhase(
    "expiry_check",
    { "swamp.diagnostic.checker": deps.isExpired !== undefined },
    () => partitionExpired(dataArtifacts, deps.isExpired),
  );
  if (live.length > 0 && !input.force) {
    yield refuse(
      "live_data",
      wordedSwampError(
        "validation_failed",
        wordedText((w) =>
          `${w.Noun} '${definition.name}' has ${live.length} associated data artifact(s). ` +
          `Delete the data first, or use --force to delete all.`
        ),
      ),
    );
    return;
  }

  const definitionPath = deps.getDefinitionPath(modelType, definition.id);

  const outputs = await observeDiagnosticPhase(
    "output_discovery",
    {},
    async ({ tally }) => {
      const found = await deps.findOutputs(modelType, definition.id);
      tally.add("outputs", found.length);
      return found;
    },
  );
  const removedData = input.force ? [...expired, ...live] : expired;
  if (
    deps.preflightDelete !== undefined &&
    (outputs.length > 0 || removedData.length > 0)
  ) {
    // each partition commits on its own, the definition last: a refusal of
    // the definition after the data went would leave half a delete
    const refusal = await deps.preflightDelete({
      type: modelType,
      definition,
      outputs,
      data: removedData.map((data) => ({
        name: data.name,
        version: data.version,
      })),
    });
    if (refusal !== undefined) {
      phase.attributes({ "swamp.diagnostic.refusal": "preflight" });
      phase.end("error");
      yield { kind: "error", error: refusal };
      return;
    }
  }

  let outputsDeleted = 0;
  // One phase for the loop, never one per output.
  await observeDiagnosticPhase("output_removal", {}, async ({ tally }) => {
    for (const output of outputs) {
      ctx.logger.debug`Deleting output: ${output.id}`;
      tally.add("attempted");
      await deps.deleteOutput(modelType, output.methodName, output.id);
      outputsDeleted++;
      tally.add("deleted");
    }
  });

  let expiredDataAutoCollected = 0;
  let dataDeleted = false;
  await observeDiagnosticPhase("data_removal", {}, async ({ tally }) => {
    // The data repository adds the versions it removes; zero when the worker
    // has no data.
    tally.add("versions_removed", 0);
    for (const data of expired) {
      ctx.logger.debug`Auto-collecting expired data: ${data.name}`;
      await deps.deleteData(modelType, definition.id, data.name);
      expiredDataAutoCollected++;
      tally.add("expired_deleted");
    }

    for (const data of live) {
      ctx.logger.debug`Deleting data artifact: ${data.name}`;
      await deps.deleteData(modelType, definition.id, data.name);
      dataDeleted = true;
      tally.add("live_deleted");
    }
  });

  ctx.logger.debug`Deleting evaluated definition: ${definition.id}`;
  await observeDiagnosticPhase(
    "evaluated_removal",
    {},
    () => deps.deleteEvaluatedDefinition(modelType, definition.id),
  );
  const evaluatedInputDeleted = true;

  ctx.logger.debug`Deleting definition: ${definition.id}`;
  await observeDiagnosticPhase(
    "definition_removal",
    {},
    () => deps.deleteDefinition(modelType, definition.id, definition.name),
  );

  yield {
    kind: "completed",
    data: {
      id: definition.id,
      name: definition.name,
      type: modelType.normalized,
      inputPath: definitionPath,
      resourceDeleted: false,
      outputsDeleted,
      evaluatedInputDeleted,
      dataDeleted,
      expiredDataAutoCollected,
    },
  };
}
