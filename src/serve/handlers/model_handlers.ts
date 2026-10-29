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

/**
 * Model-domain request handlers (model.* verbs).
 */

import { isControlPlaneModelType } from "../../domain/models/control_plane_types.ts";
import { controlPlaneRecordResource } from "../../domain/access/control_plane_records.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import {
  createModelCreateDeps,
  modelCreate,
} from "../../libswamp/models/create.ts";
import {
  createModelDeleteDeps,
  modelDelete,
  modelDeletePreview,
} from "../../libswamp/models/delete.ts";
import {
  createModelEditDeps,
  modelEdit,
  type ModelEditTarget,
} from "../../libswamp/models/edit.ts";
import {
  createModelEvaluateDeps,
  modelEvaluate,
} from "../../libswamp/models/evaluate.ts";
import { createModelGetDeps, modelGet } from "../../libswamp/models/get.ts";
import {
  createModelMethodDescribeDeps,
  modelMethodDescribe,
} from "../../libswamp/models/method_describe.ts";
import {
  createModelMethodHistoryLogsDeps,
  modelMethodHistoryLogs,
} from "../../libswamp/models/method_history_logs.ts";
import {
  createModelOutputDataDeps,
  modelOutputData,
} from "../../libswamp/models/output_data.ts";
import {
  createModelOutputGetDeps,
  modelOutputGet,
} from "../../libswamp/models/output_get.ts";
import {
  createModelOutputLogsDeps,
  modelOutputLogs,
} from "../../libswamp/models/output_logs.ts";
import {
  createModelValidateDeps,
  modelValidate,
} from "../../libswamp/models/validate.ts";
import {
  createTypeDescribeDeps,
  typeDescribe,
} from "../../libswamp/types/describe.ts";
import { isSwampError } from "../../libswamp/errors.ts";
import { modelMethodRun } from "../../libswamp/models/run.ts";
import {
  observeDiagnosticPhase,
  withDiagnosticArea,
} from "../../domain/diagnostics/diagnostic_phase.ts";
import {
  modelOutputSearch,
  type ModelOutputSearchData,
  type ModelOutputSearchDeps,
  type ModelOutputSearchItem,
  type ModelOutputSearchModel,
} from "../../libswamp/models/output_search.ts";
import {
  type NamedWorkflow,
  nestedRunReadDecider,
} from "./nested_run_redaction.ts";
import {
  modelSearch,
  type ModelSearchDeps,
} from "../../libswamp/models/search.ts";
import {
  resolveOutputIdReference,
  resolveOutputReference,
} from "../../libswamp/models/output_reference.ts";
import {
  typeSearch,
  type TypeSearchDeps,
} from "../../libswamp/types/search.ts";
import { createModelMethodRunDeps } from "../deps.ts";
import { withRunSyncGate, withSharedSyncGate } from "../sync_gate.ts";
import { createCommandTelemetry } from "../telemetry.ts";
import { serializeEvent } from "../serializer.ts";
import type {
  ModelCreatePayload,
  ModelDeletePayload,
  ModelEditPayload,
  ModelEvaluatePayload,
  ModelGetPayload,
  ModelMethodDescribePayload,
  ModelMethodHistoryGetPayload,
  ModelMethodHistoryLogsPayload,
  ModelMethodHistorySearchPayload,
  ModelMethodRunPayload,
  ModelOutputDataPayload,
  ModelOutputGetPayload,
  ModelOutputLogsPayload,
  ModelOutputSearchPayload,
  ModelSearchPayload,
  ModelTypeDescribePayload,
  ModelTypeSearchPayload,
  ModelValidatePayload,
} from "../protocol.ts";
import {
  type DefinitionLookupResult,
  findDefinitionByIdGlobal,
  findDefinitionByIdOrName,
  findDefinitionsByIdGlobal,
} from "../../domain/models/model_lookup.ts";
import type { AccessResource } from "../../domain/access/access_decision_service.ts";
import type { Action } from "../../domain/access/action.ts";
import {
  createDefinitionId,
  type Definition,
} from "../../domain/definitions/definition.ts";
import {
  acquireModelLocks,
  acquirePublishLocksOrDefer,
  type ModelLockResult,
  pullModelsUnlocked,
  runUnderModelLocks,
} from "../../cli/repo_context.ts";
import {
  type MethodRunLockMode,
  methodRunLockMode,
} from "../../libswamp/models/method_run_lock_mode.ts";
import {
  extractTraceContext,
  runWithParentTrace,
} from "../../infrastructure/tracing/mod.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  type Principal,
  principalToString,
} from "../../domain/access/principal.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { RegistryCapacityError } from "../active_run_registry.ts";
import { RunEventBuffer } from "../run_event_buffer.ts";
import { deleteActiveRun, writeActiveRun } from "../active_run_tracker.ts";
import {
  authorizeAnyOrReject,
  authorizeOrReject,
  authorizeRetag,
  clientErrorDetails,
  confirmRunReplicated,
  type ConnectionContext,
  exceptionTypeForClient,
  filterByResources,
  handlerLibSwampContext,
  isAdminOnlyModelType,
  isAuthorized,
  LibSwampStreamError,
  lockTimeoutErrorForClient,
  pushChangedToRemote,
  recordAuditedResource,
  rejectEditWithoutContent,
  resourceDecider,
  runFailureForClient,
  sanitizeErrorForClient,
  send,
  sendError,
  socketAuthority,
  subscribeUntilDetach,
  wasRequestErrored,
} from "./shared.ts";
import { requestRunVaultScope } from "../run_vault_access_policy.ts";
import { runGeneratorWithVaultAccess } from "../../domain/vaults/run_vault_access.ts";
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";
import {
  authorizeReferenceAccess,
  authorizeResolved,
  type CanonicalResources,
  canonicalResources,
  modelAccessResource,
  recordedRunModel,
  resolveModelTarget,
  resolveOutputAccess,
  type ResourceResolution,
  restrictedModelAuthorization,
  targetArgument,
  unresolvedAccessResource,
} from "./resource_resolution.ts";
import { runInRootUnitOfWork } from "../../infrastructure/persistence/repo_unit_of_work.ts";
import { containedLogFileReader } from "./log_file_containment.ts";
import {
  DataVersionConflictError,
  isUnpublishedDataError,
  type WrittenVersion,
} from "../../domain/datastore/datastore_sync_service.ts";
import {
  analyzeContentExpressions,
  definitionRetargetSourcesChanged,
  expressionsAddedByEdit,
} from "../../domain/expressions/expression_references.ts";
import {
  authorizeExpressionReferences,
  authorizeRunInputExpressions,
} from "./expression_reference_authorization.ts";

const logger = getSwampLogger(["serve", "connection"]);

const DEFAULT_BUFFER_CAPACITY = 10_000;

/** The model a read or list run publishes what it wrote to. */
type PublishedModel = { modelType: string; modelId: string };

/**
 * How a method run holds its model's lock (swamp-club#3934). A direct type
 * execution can rewrite an existing definition's global arguments whatever
 * the method, so it always locks for the run.
 */
function runLockMode(
  ctx: ConnectionContext,
  target: MethodRunTarget,
  modelType: string,
  methodName: string,
): Promise<MethodRunLockMode> {
  if (target.run !== undefined) return Promise.resolve("run");
  return methodRunLockMode({
    modelType,
    methodName,
    config: ctx.datastoreConfig,
    syncService: ctx.syncService,
    repoContext: ctx.repoContext,
  });
}

/** Pulls a read or list run's model, unlocked, under the run sync gate. */
async function pullBeforeUnlockedRun(
  ctx: ConnectionContext,
  model: PublishedModel,
): Promise<void> {
  const synced = await pullModelsUnlocked(
    ctx.datastoreConfig,
    [model],
    ctx.repoDir,
    ctx.syncService,
    { wrapSync: (fn, kind) => withRunSyncGate(ctx.syncGate, fn, kind) },
  );
  if (synced) ctx.repoContext.catalogStore.invalidate();
}

/**
 * Takes a read or list run's model lock, which pulls the model, publishes
 * what the run wrote, refusing versions another clone wrote meanwhile, and
 * releases the lock (swamp-club#3934). The client already has its result,
 * so a failure is logged.
 */
async function publishUnlockedRun(
  ctx: ConnectionContext,
  model: PublishedModel,
  written: readonly WrittenVersion[],
): Promise<void> {
  if (written.length === 0) return;
  let publishLocks: ModelLockResult | undefined;
  try {
    // When another run holds the lock, the next run that takes it on this
    // host publishes what this one wrote (swamp-club#3934).
    publishLocks = await acquirePublishLocksOrDefer(
      ctx.datastoreConfig,
      model,
      written,
      ctx.repoDir,
      ctx.syncService,
      ctx.repoContext.catalogStore,
      {
        wrapSync: (fn, kind) => withRunSyncGate(ctx.syncGate, fn, kind),
        repoContext: ctx.repoContext,
      },
    );
  } catch (error) {
    logger.warn(
      "Failed to lock {modelType}/{modelId} to publish its data: {error}",
      {
        ...model,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return;
  }
  if (publishLocks === undefined) {
    logger.info(
      "{modelType}/{modelId} is locked by another run; its next run on this host publishes this run's data",
      { ...model },
    );
    return;
  }
  let pushFailure: { error: unknown } | undefined;
  try {
    await publishLocks.pushWritten(written);
  } catch (error) {
    let cause: unknown = error;
    if (error instanceof DataVersionConflictError) {
      // The run's work is done, as the CLI warns for a read or list run
      // (swamp-club#3934); a failure publishing the rest is logged below.
      cause = error.publishFailure;
      logger.warn(
        "Another swamp process wrote {versions} of behavior {model} while this run was running: the datastore keeps that copy, and this host now holds it in place of this run's",
        {
          versions: error.versions.map((v) =>
            `${v.dataName} version ${v.version}`
          ).join(", "),
          model: `${model.modelType}/${model.modelId}`,
        },
      );
    }
    if (cause === undefined) {
      // Only the conflict: the rest of the run's data was published.
    } else if (isUnpublishedDataError(cause)) {
      pushFailure = { error: cause };
    } else {
      logger.error(
        "Failed to publish the data of {modelType}/{modelId}: {error}",
        {
          ...model,
          error: cause instanceof Error ? cause.message : String(cause),
        },
      );
    }
  }
  await releaseModelLocks(publishLocks, pushFailure);
}

/** What a method run is authorized as, and what it then acts on. */
interface MethodRunTarget {
  /** The existing definition, when the reference resolves to one. */
  definition: DefinitionLookupResult | null;
  /** The resource `run` is authorized on. */
  resource: AccessResource;
  /** The argument and lookup mode handed to modelMethodRun. */
  modelIdOrName: string;
  byId: boolean;
  /** The name the model was authorized on, when acting by id. */
  expectedName?: string;
  /** The id of the model run by id, recorded for cancel and attach. */
  resourceId?: string;
  /**
   * A direct type execution acts on the definition `definitionName` names,
   * which a request may set apart from `modelIdOrName` (swamp-club#2672):
   * that definition (null when the run will create it) and the resource it
   * is authorized on. Absent on the standard path.
   */
  run?: { definition: DefinitionLookupResult | null; resource: AccessResource };
}

/**
 * The definition a method run executes and locks: for a direct type
 * execution the one `definitionName` names, otherwise the one resolved.
 */
function executedDefinition(
  target: MethodRunTarget,
): DefinitionLookupResult | null {
  return target.run ? target.run.definition : target.definition;
}

/**
 * Resolves a method run's model. The standard path authorizes the model's
 * canonical name and full fields, then runs it by id (swamp-club#2674). A
 * direct type execution (a type and a definition name) may create its
 * definition, so it runs by name: it authorizes the requested name, the
 * type, and the definition `definitionName` names, which is the one it acts
 * on (swamp-club#2672). Throws when a lookup fails.
 */
async function resolveMethodRunTarget(
  ctx: ConnectionContext,
  payload: ModelMethodRunPayload,
): Promise<MethodRunTarget> {
  const definition = await findDefinitionByIdOrName(
    ctx.repoContext.definitionRepo,
    payload.modelIdOrName,
  );
  const methodName = payload.methodName;
  if (payload.typeArg && payload.definitionName) {
    // A definition not created yet has no tags; its type is the one named.
    // An existing one's fields are its own, even for a control-plane type
    // whose access resource names the type instead (swamp-club#2756).
    const fields: Record<string, unknown> = definition
      ? {
        name: definition.definition.name,
        modelType: definition.type.normalized,
        tags: definition.definition.tags ?? {},
      }
      : {
        name: payload.modelIdOrName,
        modelType: normalizedTypeOrRaw(payload.typeArg),
        tags: {},
      };
    // The definition the run acts on is the one definitionName names. It is
    // authorized by its canonical name and fields when it exists, and by
    // the name to be created otherwise (swamp-club#2672). The run looks it
    // up with the same findDefinitionByIdOrName (serve deps), and fails if
    // it then finds anything else, so the two cannot disagree silently.
    const runDefinition = await findDefinitionByIdOrName(
      ctx.repoContext.definitionRepo,
      payload.definitionName,
    );
    const created = payload.definitionName;
    const runResource: AccessResource = runDefinition
      ? modelAccessResource(runDefinition)
      : {
        kind: "model",
        name: created,
        fields: {
          name: created,
          modelType: normalizedTypeOrRaw(payload.typeArg),
          tags: {},
        },
      };
    return {
      definition,
      resource: {
        kind: "model",
        name: payload.modelIdOrName,
        fields: { ...fields, methodName },
      },
      modelIdOrName: payload.modelIdOrName,
      byId: false,
      resourceId: runDefinition?.definition.id,
      run: {
        definition: runDefinition,
        resource: {
          ...runResource,
          fields: { ...runResource.fields, methodName },
        },
      },
    };
  }
  const resolution: ResourceResolution = definition
    ? {
      status: "found",
      resource: modelAccessResource(definition),
      id: definition.definition.id,
      name: definition.definition.name,
    }
    : {
      status: "missing",
      resource: unresolvedAccessResource("model", payload.modelIdOrName),
    };
  const { idOrName, byId, expectedName } = targetArgument(
    resolution,
    payload.modelIdOrName,
  );
  return {
    definition,
    resource: {
      ...resolution.resource,
      fields: { ...resolution.resource.fields, methodName },
    },
    modelIdOrName: idOrName,
    byId,
    expectedName,
    resourceId: definition?.definition.id,
  };
}

/**
 * Releases a method run's model locks after its root pushed them, warning
 * once if the push or the release failed. A release error replaces the push
 * error, as the combined push-then-release in a `finally` did.
 */
async function releaseModelLocks(
  modelLocks: ModelLockResult,
  pushFailure: { error: unknown } | undefined,
): Promise<void> {
  let failure = pushFailure;
  if (isUnpublishedDataError(pushFailure?.error)) {
    // The client got its result before the push; the loss is logged only.
    logger.error("{message}", { message: pushFailure.error.message });
    failure = undefined;
  }
  try {
    await modelLocks.release();
  } catch (error) {
    failure = { error };
  }
  if (failure !== undefined) {
    logger.warn("Failed to release locks: {error}", {
      error: failure.error instanceof Error
        ? failure.error.message
        : String(failure.error),
    });
  }
}

/**
 * Authorizes a method run: admin for a restricted model type, otherwise run
 * on the target model and, for a direct type execution, on the type.
 */
function authorizeMethodRun(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  payload: ModelMethodRunPayload,
  target: MethodRunTarget,
  ctx: ConnectionContext,
): boolean {
  const restricted = ctx.authConfig.restrictedModelTypes;
  if (
    isAdminOnlyModelType(
      payload.typeArg,
      target.definition?.type.normalized,
      restricted,
    ) ||
    isAdminOnlyModelType(
      undefined,
      target.run?.definition?.type.normalized,
      restricted,
    )
  ) {
    // Judged on the requested model's fields and, for a direct type
    // execution, on those of the definition it acts on, so a condition on
    // the record's name applies (swamp-club#2672).
    return authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: target.resource.fields,
    }, ctx).allowed &&
      (!target.run ||
        authorizeOrReject(socket, requestId, principal, "admin", {
          kind: "access",
          name: "*",
          fields: target.run.resource.fields,
        }, ctx).allowed);
  }
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "run",
      target.resource,
      ctx,
    )
      .allowed
  ) return false;
  if (payload.typeArg) {
    const executionTarget = ModelType.create(payload.typeArg).normalized;
    // A type carries no tags; every resource field is present so a
    // conditional deny decides on it rather than failing closed.
    if (
      !authorizeOrReject(socket, requestId, principal, "run", {
        kind: "model",
        name: executionTarget,
        fields: {
          name: executionTarget,
          modelType: executionTarget,
          tags: {},
          methodName: payload.methodName,
        },
      }, ctx).allowed
    ) return false;
  }
  // Last, so the requested model and the type are reported first.
  if (target.run) {
    if (
      !authorizeOrReject(
        socket,
        requestId,
        principal,
        "run",
        target.run.resource,
        ctx,
      ).allowed
    ) return false;
    recordAuditedResource(
      socket,
      requestId,
      "model",
      target.run.resource.name,
      ctx,
    );
  }
  return true;
}

/**
 * Whether a direct run may proceed on `found`, a definition other than the
 * one it was authorized on: renamed in between, or created by a concurrent
 * run under the same name. It is judged as the run's own target would be,
 * by its canonical name and fields, and as admin for a restricted or
 * control-plane type (swamp-club#2672).
 */
function resolvedRunAllowed(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  methodName: string,
  found: DefinitionLookupResult,
  ctx: ConnectionContext,
): boolean {
  const resource = modelAccessResource(found);
  const fields = { ...resource.fields, methodName };
  return isAdminOnlyModelType(
      undefined,
      found.type.normalized,
      ctx.authConfig.restrictedModelTypes,
    )
    ? isAuthorized(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields,
    }, ctx)
    : isAuthorized(socket, requestId, principal, "run", {
      ...resource,
      fields,
    }, ctx);
}

/**
 * Authorizes the expressions in a run's inputs against the caller, who
 * wrote them (swamp-club#2755, swamp-club#2786): data they read must be
 * readable by the caller, and `env` needs write on the model, as authoring
 * it in the definition would. Inputs with no expressions pass untouched.
 * Replies and returns false on a refusal. With `literalInputs` nothing in the
 * inputs is evaluated, so there is nothing to authorize (swamp-club#3205).
 */
async function authorizeRunInputs(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  payload: ModelMethodRunPayload,
  target: MethodRunTarget,
  ctx: ConnectionContext,
): Promise<boolean> {
  if (payload.literalInputs === true) return true;
  const expressions = analyzeContentExpressions(payload.inputs ?? {});
  if (expressions.length === 0) return true;
  const runOn = target.run?.resource ?? target.resource;
  const refusal = await authorizeRunInputExpressions(
    socketAuthority(socket, requestId, principal, ctx),
    ctx,
    expressions,
    runOn,
  );
  if (!refusal) return true;
  sendError(socket, requestId, "unauthorized", refusal.message);
  return false;
}

export async function handleModelMethodRun(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelMethodRunPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const registry = ctx.activeRunRegistry;
  if (!registry) {
    // Assigned in the root below, which control flow analysis cannot see.
    let modelLocks = undefined as ModelLockResult | undefined;
    // Set when a read or list run takes its model's lock only to publish
    // what it wrote (swamp-club#3934).
    let publishModel = undefined as PublishedModel | undefined;
    // Whether the run is answered before its root's flush: a lock's push,
    // or a read or list run's publish, waits for no client.
    const answersBeforeFlush = () =>
      modelLocks !== undefined || publishModel !== undefined;
    let mutating = true;
    let lockPushFailure: { error: unknown } | undefined;
    // What the run wrote, for the lock's push to publish (swamp-club#3146).
    const written: WrittenVersion[] = [];
    // The run's error, once it was answered inside the root.
    let answered = false;
    let answeredError: unknown;
    let deregistered = false;
    const initiatedBy = principal ? principalToString(principal) : "ghost";
    // The run's vault operations are decided for this principal
    // (swamp-club#2676). Refusals are audited with the request id: this
    // path has no run id of its own (the detached path below mints one),
    // and the method run's id is first reported on its completed event,
    // after any refusal. The request id is the one the caller, its event
    // stream and the cancel registry know the run by.
    const vaultAccess = requestRunVaultScope(ctx, socket, principal, requestId);
    const telemetry = createCommandTelemetry(
      {
        modelName: payload.modelIdOrName,
        methodName: payload.methodName,
      },
      initiatedBy,
    );
    const deregister = () => {
      if (deregistered) return;
      deregistered = true;
      if (ctx.cancelRegistry) {
        ctx.cancelRegistry.deregister("method-run", requestId);
      }
    };
    const answer = async (error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") {
        sendError(socket, requestId, "cancelled", "Operation was cancelled");
      } else if (error instanceof LockTimeoutError) {
        const lt = lockTimeoutErrorForClient(error);
        sendError(socket, requestId, lt.code, lt.message, lt.details);
      } else {
        const { code, message } = runFailureForClient(
          error,
          "method_execution_failed",
        );
        const exType = exceptionTypeForClient(error);
        sendError(
          socket,
          requestId,
          code,
          message,
          exType !== undefined ? { exceptionType: exType } : undefined,
        );
      }
      await telemetry?.finish(
        error instanceof Error ? error : new Error(String(error)),
      );
    };
    try {
      const target = await resolveMethodRunTarget(ctx, payload);
      if (
        !authorizeMethodRun(socket, requestId, principal, payload, target, ctx)
      ) return;
      if (
        !await authorizeRunInputs(
          socket,
          requestId,
          principal,
          payload,
          target,
          ctx,
        )
      ) return;
      const preResult = executedDefinition(target);

      // The root's flush is the model lock's push when the run took one, or
      // a read or list run's publish (swamp-club#3934), on every outcome;
      // otherwise the run's push once it completed. The reply, telemetry and
      // cancel deregistration keep their place: before a lock's push or a
      // publish, and around the no-lock push as before (swamp-club#3055).
      await runInRootUnitOfWork(
        ctx.repoContext,
        {
          flush: async ({ completed }) => {
            if (modelLocks) {
              try {
                await modelLocks.pushWritten(written);
              } catch (error) {
                lockPushFailure = { error };
              }
              return;
            }
            if (publishModel) {
              await publishUnlockedRun(ctx, publishModel, written);
              return;
            }
            if (completed && mutating) {
              await withSharedSyncGate(
                ctx.syncGate,
                () =>
                  pushChangedToRemote(ctx, {
                    onError: (error) =>
                      logger.warn(
                        "Failed to push changes to remote datastore: {error}",
                        { error },
                      ),
                  }),
              );
            }
          },
        },
        async () => {
          try {
            if (preResult) {
              const model = {
                modelType: preResult.type.normalized,
                modelId: preResult.definition.id,
              };
              const lockMode = await runLockMode(
                ctx,
                target,
                model.modelType,
                payload.methodName,
              );
              mutating = lockMode === "run";
              if (lockMode === "publish") {
                await pullBeforeUnlockedRun(ctx, model);
                publishModel = model;
              }
              if (mutating) {
                const lockResult = await acquireModelLocks(
                  ctx.datastoreConfig,
                  [model],
                  ctx.repoDir,
                  ctx.syncService,
                  ctx.repoContext.catalogStore,
                  undefined,
                  {
                    wrapSync: (fn, kind) =>
                      withRunSyncGate(ctx.syncGate, fn, kind),
                    repoContext: ctx.repoContext,
                  },
                );
                if (lockResult.synced) {
                  ctx.repoContext.catalogStore.invalidate();
                }
                modelLocks = lockResult;
              }
            }

            const isDirectExecution = payload.typeArg !== undefined;
            const deps = await createModelMethodRunDeps(
              ctx.repoDir,
              ctx.repoContext,
              {
                directExecution: isDirectExecution,
                runTracker: ctx.runTracker,
                defaultVault: ctx.defaultVault,
              },
            );
            const libCtx = handlerLibSwampContext(ctx, {
              signal: controller.signal,
            });
            const runDeps: typeof deps = {
              ...deps,
              onWrittenVersions: (versions) => {
                for (const version of versions) written.push(version);
              },
            };

            if (ctx.cancelRegistry) {
              ctx.cancelRegistry.register("method-run", requestId, controller);
            }

            const runMethod = async () => {
              for await (
                const event of runGeneratorWithVaultAccess(
                  vaultAccess?.access,
                  () =>
                    modelMethodRun(libCtx, runDeps, {
                      modelIdOrName: target.modelIdOrName,
                      byId: target.byId,
                      expectedName: target.expectedName,
                      methodName: payload.methodName,
                      inputs: payload.inputs ?? {},
                      literalInputs: payload.literalInputs === true,
                      lastEvaluated: payload.lastEvaluated ?? false,
                      runtimeTags: payload.runtimeTags,
                      typeArg: payload.typeArg,
                      definitionName: payload.definitionName,
                      expectedDefinitionId: target.run
                        ? target.run.definition?.definition.id ?? null
                        : undefined,
                      authorizeResolvedDefinition: (found) =>
                        resolvedRunAllowed(
                          socket,
                          requestId,
                          principal,
                          payload.methodName,
                          found,
                          ctx,
                        ),
                      skipAllReports: payload.skipAllReports ||
                        isDirectExecution,
                      skipReportNames: payload.skipReportNames,
                      skipReportLabels: payload.skipReportLabels,
                      reportNames: payload.reportNames,
                      reportLabels: payload.reportLabels,
                      skipAllChecks: payload.skipAllChecks,
                      skipCheckNames: payload.skipCheckNames,
                      skipCheckLabels: payload.skipCheckLabels,
                      traceparent: payload.traceparent,
                      tracestate: payload.tracestate,
                      initiatedBy,
                      instanceId: ctx.instanceId,
                    }),
                )
              ) {
                if (socket.readyState !== WebSocket.OPEN) break;
                const serialized = serializeEvent(
                  event as { kind: string; [key: string]: unknown },
                );
                send(socket, {
                  type: "event",
                  id: requestId,
                  event: serialized,
                });
              }
              send(socket, { type: "done", id: requestId });
            };

            if (payload.traceparent) {
              const headers: Record<string, string> = {
                traceparent: payload.traceparent,
              };
              if (payload.tracestate) headers.tracestate = payload.tracestate;
              const traceCtx = extractTraceContext(headers);
              await runUnderModelLocks(
                modelLocks,
                () => runWithParentTrace(traceCtx, runMethod),
              );
            } else {
              await runUnderModelLocks(modelLocks, runMethod);
            }
            if (answersBeforeFlush()) await telemetry?.finish(null);
          } catch (error) {
            if (answersBeforeFlush()) {
              answered = true;
              answeredError = error;
              try {
                await answer(error);
              } finally {
                deregister();
              }
            }
            throw error;
          }
          if (answersBeforeFlush()) deregister();
        },
      );
      if (!answersBeforeFlush()) await telemetry?.finish(null);
    } catch (error) {
      if (!answered) {
        await answer(error);
      } else if (error !== answeredError) {
        throw error;
      }
    } finally {
      deregister();
      if (modelLocks) {
        await releaseModelLocks(modelLocks, lockPushFailure);
      }
    }
    return;
  }

  // Pre-lookup and authorization for the detached path
  let target: MethodRunTarget;
  try {
    target = await resolveMethodRunTarget(ctx, payload);
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "method_execution_failed", message);
    return;
  }
  if (
    !authorizeMethodRun(socket, requestId, principal, payload, target, ctx)
  ) return;
  if (
    !await authorizeRunInputs(
      socket,
      requestId,
      principal,
      payload,
      target,
      ctx,
    )
  ) return;
  const preResult = executedDefinition(target);
  const recorded = recordedRunModel(
    preResult,
    target.run?.resource.name ?? target.resource.name,
    payload.typeArg,
  );

  const initiatedBy = principal ? principalToString(principal) : "ghost";
  const buffer = new RunEventBuffer(DEFAULT_BUFFER_CAPACITY, {
    holdOutcome: ctx.holdRepliesUntilCommitted === true,
  });
  const runController = new AbortController();
  const runId: string = crypto.randomUUID();
  const startedAt = new Date();
  // Captured now, while the socket's memberships are at hand: the run's
  // vault operations are decided for this principal (swamp-club#2676).
  const vaultAccess = requestRunVaultScope(ctx, socket, principal, runId);

  buffer.push({ kind: "run.accepted", runId });

  let resolveCompletion!: () => void;
  const completion = new Promise<void>((r) => {
    resolveCompletion = r;
  });

  try {
    registry.register({
      runId,
      kind: "method-run",
      resourceName: recorded.name,
      resourceId: target.resourceId,
      methodName: payload.methodName,
      resourceType: recorded.type,
      buffer,
      controller: runController,
      startedAt,
      completion,
      principalId: principal ? principalToString(principal) : null,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn("Detached method run rejected: {error}", { error: detail });
    resolveCompletion();
    if (err instanceof RegistryCapacityError) {
      const clientMsg = err.code === "already_registered"
        ? "A run with this ID is already in progress"
        : err.code === "draining"
        ? "Serve is shutting down; try again once it is back"
        : "Too many concurrent runs; wait for active runs to complete";
      sendError(socket, requestId, err.code, clientMsg);
    } else {
      sendError(socket, requestId, "internal_error", "Run registration failed");
    }
    return;
  }

  const detachedTelemetry = createCommandTelemetry(
    {
      modelName: payload.modelIdOrName,
      methodName: payload.methodName,
    },
    initiatedBy,
  );

  const detachedLockMode = preResult
    ? await runLockMode(
      ctx,
      target,
      preResult.type.normalized,
      payload.methodName,
    )
    : "run";
  const detachedMutating = detachedLockMode === "run";

  (async () => {
    // Assigned in the root below, which control flow analysis cannot see.
    let modelLocks = undefined as ModelLockResult | undefined;
    // Set when a read or list run takes its model's lock only to publish
    // what it wrote (swamp-club#3934).
    let publishModel = undefined as PublishedModel | undefined;
    // Whether the terminal precedes the root's flush: a lock's push, or a
    // read or list run's publish, waits for no client.
    const answersBeforeFlush = () =>
      modelLocks !== undefined || publishModel !== undefined;
    let lockPushFailure: { error: unknown } | undefined;
    // What the run wrote, for the lock's push to publish (swamp-club#3146).
    const written: WrittenVersion[] = [];
    // The run's error, once it was answered inside the root.
    let answered = false;
    let answeredError: unknown;
    const finishWithError = async (error: unknown) => {
      await detachedTelemetry?.finish(
        error instanceof Error ? error : new Error(String(error)),
      );
      if (error instanceof DOMException && error.name === "AbortError") {
        buffer.finish({
          kind: "error",
          code: "cancelled",
          message: "Operation was cancelled",
        });
      } else if (error instanceof LockTimeoutError) {
        const lt = lockTimeoutErrorForClient(error);
        buffer.finish({
          kind: "error",
          code: lt.code,
          message: lt.message,
          details: lt.details,
        });
      } else {
        const exType = exceptionTypeForClient(error);
        buffer.finish({
          kind: "error",
          ...runFailureForClient(error, "method_execution_failed"),
          ...(exType !== undefined && {
            details: { exceptionType: exType },
          }),
        });
      }
    };
    try {
      // The root's flush is the model lock's push when the run took one, or
      // a read or list run's publish (swamp-club#3934), on every outcome,
      // after the stream's terminal; otherwise the run's push once it
      // completed, before the terminal (swamp-club#3055).
      await runInRootUnitOfWork(
        ctx.repoContext,
        {
          flush: async ({ completed }) => {
            if (modelLocks) {
              try {
                await modelLocks.pushWritten(written);
              } catch (error) {
                lockPushFailure = { error };
              }
              return;
            }
            if (publishModel) {
              await publishUnlockedRun(ctx, publishModel, written);
              return;
            }
            if (completed && detachedMutating) {
              await withSharedSyncGate(
                ctx.syncGate,
                () =>
                  pushChangedToRemote(ctx, {
                    onError: (error) =>
                      logger.warn(
                        "Failed to push changes to remote datastore: {error}",
                        { error },
                      ),
                  }),
              );
            }
          },
        },
        async () => {
          try {
            if (preResult && detachedLockMode === "publish") {
              const model = {
                modelType: preResult.type.normalized,
                modelId: preResult.definition.id,
              };
              await pullBeforeUnlockedRun(ctx, model);
              publishModel = model;
            }
            if (preResult && detachedMutating) {
              const lockResult = await acquireModelLocks(
                ctx.datastoreConfig,
                [{
                  modelType: preResult.type.normalized,
                  modelId: preResult.definition.id,
                }],
                ctx.repoDir,
                ctx.syncService,
                ctx.repoContext.catalogStore,
                undefined,
                {
                  wrapSync: (fn, kind) =>
                    withRunSyncGate(ctx.syncGate, fn, kind),
                  repoContext: ctx.repoContext,
                },
              );
              if (lockResult.synced) ctx.repoContext.catalogStore.invalidate();
              modelLocks = lockResult;
            }

            const isDirectExecution = payload.typeArg !== undefined;
            const deps = await createModelMethodRunDeps(
              ctx.repoDir,
              ctx.repoContext,
              {
                directExecution: isDirectExecution,
                runTracker: ctx.runTracker,
                defaultVault: ctx.defaultVault,
              },
            );
            const libCtx = handlerLibSwampContext(ctx, {
              signal: runController.signal,
            });
            const runDeps: typeof deps = {
              ...deps,
              onWrittenVersions: (versions) => {
                for (const version of versions) written.push(version);
              },
            };

            const doRun = async () => {
              for await (
                const event of runGeneratorWithVaultAccess(
                  vaultAccess?.access,
                  () =>
                    modelMethodRun(libCtx, runDeps, {
                      modelIdOrName: target.modelIdOrName,
                      byId: target.byId,
                      expectedName: target.expectedName,
                      methodName: payload.methodName,
                      inputs: payload.inputs ?? {},
                      literalInputs: payload.literalInputs === true,
                      lastEvaluated: payload.lastEvaluated ?? false,
                      runtimeTags: payload.runtimeTags,
                      typeArg: payload.typeArg,
                      definitionName: payload.definitionName,
                      expectedDefinitionId: target.run
                        ? target.run.definition?.definition.id ?? null
                        : undefined,
                      authorizeResolvedDefinition: (found) =>
                        resolvedRunAllowed(
                          socket,
                          requestId,
                          principal,
                          payload.methodName,
                          found,
                          ctx,
                        ),
                      skipAllReports: payload.skipAllReports ||
                        isDirectExecution,
                      skipReportNames: payload.skipReportNames,
                      skipReportLabels: payload.skipReportLabels,
                      reportNames: payload.reportNames,
                      reportLabels: payload.reportLabels,
                      skipAllChecks: payload.skipAllChecks,
                      skipCheckNames: payload.skipCheckNames,
                      skipCheckLabels: payload.skipCheckLabels,
                      traceparent: payload.traceparent,
                      tracestate: payload.tracestate,
                      initiatedBy,
                      instanceId: ctx.instanceId,
                    }),
                )
              ) {
                const serialized = serializeEvent(
                  event as { kind: string; [key: string]: unknown },
                );
                buffer.push(serialized);
              }
            };

            if (payload.traceparent) {
              const headers: Record<string, string> = {
                traceparent: payload.traceparent,
              };
              if (payload.tracestate) headers.tracestate = payload.tracestate;
              const traceCtx = extractTraceContext(headers);
              await runUnderModelLocks(
                modelLocks,
                () => runWithParentTrace(traceCtx, doRun),
              );
            } else {
              await runUnderModelLocks(modelLocks, doRun);
            }
            // With replication on, the terminal waits for the root's commit
            // and its confirmation below (swamp-club#3489).
            // On v3 the root commits after this: it waits too
            // (swamp-club#3759).
            if (
              answersBeforeFlush() && ctx.confirmReplicated === undefined &&
              ctx.holdRepliesUntilCommitted !== true
            ) {
              buffer.finish({ kind: "done" });
              await detachedTelemetry?.finish(null);
            }
          } catch (error) {
            if (answersBeforeFlush()) {
              answered = true;
              answeredError = error;
              await finishWithError(error);
            }
            throw error;
          }
        },
      );
      if (
        !answersBeforeFlush() || ctx.confirmReplicated !== undefined ||
        ctx.holdRepliesUntilCommitted === true
      ) {
        // Reported finished only once its commits are replicated
        // (swamp-club#3489); answered here, so a failure is not answered
        // again below.
        const unconfirmed = await confirmRunReplicated(
          ctx,
          "method_execution_failed",
        );
        if (unconfirmed === undefined) {
          buffer.finish({ kind: "done" });
          await detachedTelemetry?.finish(null);
        } else {
          buffer.finish({ kind: "error", ...unconfirmed });
          await detachedTelemetry?.finish(new Error(unconfirmed.message));
        }
      }
    } catch (error) {
      if (!answered) {
        await finishWithError(error);
      } else if (error !== answeredError) {
        throw error;
      }
    } finally {
      if (modelLocks) {
        await releaseModelLocks(modelLocks, lockPushFailure);
      }
      registry.deregister(runId);
      try {
        if (ctx.controlPlaneStore && ctx.instanceId) {
          deleteActiveRun(ctx.controlPlaneStore, ctx.instanceId, runId);
        }
      } catch (cleanupErr) {
        logger.warn("Failed to delete active run record: {error}", {
          error: cleanupErr instanceof Error
            ? cleanupErr.message
            : String(cleanupErr),
        });
      }
      resolveCompletion();
    }
  })().catch((err) => {
    logger.warn("Unhandled error in detached method run: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  if (ctx.controlPlaneStore && ctx.instanceId) {
    writeActiveRun(ctx.controlPlaneStore, ctx.instanceId, runId, {
      resourceName: recorded.name,
      resourceId: target.resourceId,
      methodName: payload.methodName,
      resourceType: recorded.type,
      runKind: "method-run",
      startedAt: startedAt.toISOString(),
    });
  }

  await subscribeUntilDetach(buffer, socket, requestId, controller);
}

export async function handleModelSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ModelSearchPayload,
): Promise<void> {
  if (
    !authorizeAnyOrReject(
      socket,
      requestId,
      principal,
      "read",
      "model",
      ctx,
    )
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps: ModelSearchDeps = {
      findAllGlobal: () => ctx.repoContext.definitionRepo.findAllGlobal(),
      isInternalType: (type: string) => modelRegistry.isInternal(type),
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelSearch(libCtx, deps, {
        query: payload?.query,
        includeInternal: payload?.includeInternal,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    const data = (result ?? {}) as {
      results?: Array<{ id: string; name: string; type: string }>;
    };
    if (data.results) {
      const canonical = canonicalResources(ctx);
      data.results = await filterByResources(
        data.results,
        (item) => canonical.model(item.id, item.name, item.type),
        socket,
        principal,
        "read",
        ctx,
      );
    }

    send(socket, {
      type: "model.search",
      id: requestId,
      payload: { data },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_search_failed", message);
  }
}

export async function handleModelMethodDescribe(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelMethodDescribePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const target = await resolveModelTarget(
    ctx.repoContext.definitionRepo,
    payload.modelIdOrName,
  );
  if (
    !authorizeResolved(
      socket,
      requestId,
      principal,
      "read",
      target,
      payload.modelIdOrName,
      "model",
      ctx,
      "model_method_describe_failed",
    )
  ) return;
  const model = targetArgument(target, payload.modelIdOrName);

  try {
    await modelRegistry.ensureLoaded();
    const libCtx = handlerLibSwampContext(ctx);
    const deps = createModelMethodDescribeDeps(
      ctx.repoDir,
      ctx.repoContext.definitionRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelMethodDescribe(
        libCtx,
        deps,
        model.idOrName,
        payload.methodName,
        { byId: model.byId, expectedName: model.expectedName },
      ),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Method not found");
      return;
    }

    send(socket, {
      type: "model.method.describe",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_method_describe_failed", message);
  }
}

export async function handleModelGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const target = await resolveModelTarget(
    ctx.repoContext.definitionRepo,
    payload.modelIdOrName,
  );
  if (
    !authorizeResolved(
      socket,
      requestId,
      principal,
      "read",
      target,
      payload.modelIdOrName,
      "model",
      ctx,
      "model_get_failed",
    )
  ) return;
  const model = targetArgument(target, payload.modelIdOrName);

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = await createModelGetDeps(ctx.repoContext.definitionRepo);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelGet(libCtx, deps, model.idOrName, {
        byId: model.byId,
        expectedName: model.expectedName,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Behavior not found");
      return;
    }

    send(socket, {
      type: "model.get",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_get_failed", message);
  }
}

export async function handleModelCreate(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelCreatePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    isAdminOnlyModelType(
      payload.typeArg,
      undefined,
      ctx.authConfig.restrictedModelTypes,
    )
  ) {
    if (
      !authorizeOrReject(socket, requestId, principal, "admin", {
        kind: "access",
        name: "*",
        fields: {},
      }, ctx).allowed
    ) return;
  } else {
    if (
      !authorizeOrReject(socket, requestId, principal, "write", {
        kind: "model",
        name: payload.name ?? payload.typeArg,
        // A model being created has no tags yet; its type is the one named.
        fields: {
          name: payload.name ?? payload.typeArg,
          modelType: normalizedTypeOrRaw(payload.typeArg),
          tags: {},
        },
      }, ctx).allowed
    ) return;
  }
  // Every expression in a new model is added by this writer
  // (swamp-club#2755).
  const refusal = await authorizeExpressionReferences(
    socketAuthority(socket, requestId, principal, ctx),
    ctx,
    analyzeContentExpressions(payload.globalArguments ?? {}),
    "allowed",
  );
  if (refusal) {
    sendError(socket, requestId, "unauthorized", refusal.message);
    return;
  }

  // The root pushes only once the success reply was sent (swamp-club#3035).
  let replied = false;
  await runInRootUnitOfWork(
    ctx.repoContext,
    {
      flush: () =>
        replied
          ? pushChangedToRemote(ctx, {
            onError: (error) =>
              logger.warn(
                "Failed to push changes to remote datastore: {error}",
                { error },
              ),
          })
          : Promise.resolve(),
    },
    async () => {
      try {
        const libCtx = handlerLibSwampContext(ctx);
        const deps = await createModelCreateDeps(
          ctx.repoDir,
          ctx.managedDefinitionsDir,
          ctx.repoContext.definitionRepo,
        );

        let result: Record<string, unknown> | undefined;
        await consumeStream(
          modelCreate(libCtx, deps, {
            typeArg: payload.typeArg,
            name: payload.name ?? "",
            globalArguments: payload.globalArguments,
            principalId: principal ? principalToString(principal) : undefined,
          }),
          {
            creating: () => {},
            completed: (e) => {
              result = e.data as unknown as Record<string, unknown>;
            },
            error: (e) => {
              throw new Error(e.error.message);
            },
          },
        );

        if (controller.signal.aborted) {
          sendError(socket, requestId, "cancelled", "Operation was cancelled");
          return;
        }

        if (!result) {
          sendError(
            socket,
            requestId,
            "model_create_failed",
            "Behavior creation failed",
          );
          return;
        }

        send(socket, {
          type: "model.create",
          id: requestId,
          payload: { data: result },
        });
        replied = true;
      } catch (error) {
        const message = sanitizeErrorForClient(error);
        sendError(socket, requestId, "model_create_failed", message);
      }
    },
  );
}

export async function handleModelDelete(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelDeletePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  const resolved = await resolveModelTarget(
    ctx.repoContext.definitionRepo,
    payload.modelIdOrName,
  );
  // Deleting a model of a restricted type needs admin (swamp-club#3131).
  const { action, resolution: target } = restrictedModelAuthorization(
    resolved,
    "write",
    ctx.authConfig.restrictedModelTypes,
  );
  if (
    !authorizeResolved(
      socket,
      requestId,
      principal,
      action,
      target,
      payload.modelIdOrName,
      "model",
      ctx,
      "model_delete_failed",
    )
  ) return;
  const model = targetArgument(target, payload.modelIdOrName);

  // The root pushes only once the success reply was sent (swamp-club#3035).
  let replied = false;
  await runInRootUnitOfWork(
    ctx.repoContext,
    {
      flush: () =>
        replied
          ? pushChangedToRemote(ctx, {
            onError: (error) =>
              logger.warn(
                "Failed to push changes to remote datastore: {error}",
                { error },
              ),
          })
          : Promise.resolve(),
    },
    async () => {
      try {
        const libCtx = handlerLibSwampContext(ctx);
        const deps = createModelDeleteDeps(
          ctx.repoDir,
          ctx.datastoreResolver,
          ctx.repoContext.unifiedDataRepo,
          ctx.repoContext.markDirty,
          ctx.repoContext.definitionRepo,
        );

        const preview = await modelDeletePreview(
          libCtx,
          deps,
          {
            modelIdOrName: model.idOrName,
            byId: model.byId,
            expectedName: model.expectedName,
            force: payload.force ?? false,
          },
        );

        const hasData = preview.dataArtifactCount > 0 ||
          preview.outputCount > 0;
        if (!payload.force && hasData) {
          sendError(
            socket,
            requestId,
            "has_data",
            `Behavior has associated data (${preview.dataArtifactCount} artifacts, ${preview.outputCount} outputs). Use force to delete.`,
          );
          return;
        }

        let result: Record<string, unknown> | undefined;
        await consumeStream(
          modelDelete(libCtx, deps, {
            modelIdOrName: model.idOrName,
            byId: model.byId,
            expectedName: model.expectedName,
            force: payload.force ?? false,
            principalId: principal ? principalToString(principal) : undefined,
          }),
          {
            deleting: () => {},
            completed: (e) => {
              result = e.data as unknown as Record<string, unknown>;
            },
            error: (e) => {
              throw new Error(e.error.message);
            },
          },
        );

        if (controller.signal.aborted) {
          sendError(socket, requestId, "cancelled", "Operation was cancelled");
          return;
        }

        if (!result) {
          sendError(
            socket,
            requestId,
            "model_delete_failed",
            "Behavior deletion failed",
          );
          return;
        }

        send(socket, {
          type: "model.delete",
          id: requestId,
          payload: { data: result },
        });
        replied = true;
      } catch (error) {
        // modelDeletePreview throws a SwampError (e.g. notFound) rather than an
        // Error; wrap it so the client gets its message and allow-listed
        // reason.
        const clientError = isSwampError(error)
          ? new LibSwampStreamError(error)
          : error;
        sendError(
          socket,
          requestId,
          "model_delete_failed",
          sanitizeErrorForClient(clientError),
          clientErrorDetails(clientError),
        );
      }
    },
  );
}

export async function handleModelOutputGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelOutputGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // Resolve first and authorize every model that owns the output read, not
  // the raw argument: an output id prefix matches across every model
  // (swamp-club#2673).
  const access = await resolveOutputAccess(
    ctx.repoContext.definitionRepo,
    async () => {
      const deps = {
        ...await createModelOutputGetDeps(
          ctx.repoDir,
          ctx.datastoreResolver,
          ctx.repoContext.definitionRepo,
          ctx.repoContext.unreadableContent,
        ),
        retentionWatermarks: ctx.repoContext.retentionWatermarks,
      };
      return {
        deps,
        reference: await resolveOutputReference(
          deps,
          payload.outputIdOrModelName,
        ),
      };
    },
    payload.outputIdOrModelName,
    ["model"],
  );
  const authorized = authorizeReferenceAccess(
    socket,
    requestId,
    principal,
    "read",
    access,
    payload.outputIdOrModelName,
    ["model"],
    ctx,
    "model_output_get_failed",
  );
  if (!authorized) return;
  const { deps, reference } = authorized;

  try {
    const libCtx = handlerLibSwampContext(ctx);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelOutputGet(libCtx, deps, payload.outputIdOrModelName, { reference }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Output not found");
      return;
    }

    send(socket, {
      type: "model.output.get",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_output_get_failed", message);
  }
}

export async function handleModelOutputData(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelOutputDataPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // Resolve first and authorize every model that owns the output, not the
  // raw id prefix (swamp-club#2673). The read returns data artifact content,
  // so it needs a data read on those models too, as data.get does
  // (swamp-club#2739).
  const access = await resolveOutputAccess(
    ctx.repoContext.definitionRepo,
    async () => {
      const deps = createModelOutputDataDeps(
        ctx.repoDir,
        ctx.datastoreResolver,
        ctx.repoContext.unifiedDataRepo,
        ctx.repoContext.definitionRepo,
        ctx.repoContext.unreadableContent,
      );
      return {
        deps,
        reference: await resolveOutputIdReference(deps, payload.outputIdArg),
      };
    },
    payload.outputIdArg,
    ["model", "data"],
  );
  const authorized = authorizeReferenceAccess(
    socket,
    requestId,
    principal,
    "read",
    access,
    payload.outputIdArg,
    ["model", "data"],
    ctx,
    "model_output_data_failed",
  );
  if (!authorized) return;
  const { deps, reference } = authorized;

  try {
    const libCtx = handlerLibSwampContext(ctx);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelOutputData(libCtx, deps, {
        outputIdArg: payload.outputIdArg,
        name: payload.name,
        field: payload.field,
        version: payload.version,
        reference,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Output data not found");
      return;
    }

    send(socket, {
      type: "model.output.data",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_output_data_failed", message);
  }
}

export async function handleModelOutputLogs(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelOutputLogsPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // Resolve first and authorize every model that owns the output, not the
  // raw id prefix (swamp-club#2673). The read returns log data artifacts, so
  // it needs a data read on those models too, as data.get does
  // (swamp-club#2739).
  const access = await resolveOutputAccess(
    ctx.repoContext.definitionRepo,
    async () => {
      const deps = createModelOutputLogsDeps(
        ctx.repoDir,
        ctx.datastoreResolver,
        ctx.repoContext.unifiedDataRepo,
        ctx.repoContext.unreadableContent,
      );
      return {
        deps,
        reference: await resolveOutputIdReference(deps, payload.outputIdArg),
      };
    },
    payload.outputIdArg,
    ["model", "data"],
  );
  const authorized = authorizeReferenceAccess(
    socket,
    requestId,
    principal,
    "read",
    access,
    payload.outputIdArg,
    ["model", "data"],
    ctx,
    "model_output_logs_failed",
  );
  if (!authorized) return;
  const { deps, reference } = authorized;

  try {
    const libCtx = handlerLibSwampContext(ctx);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelOutputLogs(libCtx, deps, {
        outputIdArg: payload.outputIdArg,
        tail: payload.tail,
        reference,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Output logs not found");
      return;
    }

    send(socket, {
      type: "model.output.logs",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_output_logs_failed", message);
  }
}

export async function handleModelOutputSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ModelOutputSearchPayload,
): Promise<void> {
  if (
    !authorizeAnyOrReject(
      socket,
      requestId,
      principal,
      "read",
      "model",
      ctx,
    )
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const outputRepo = ctx.repoContext.outputRepo;
    const definitionRepo = ctx.repoContext.definitionRepo;
    // One read of the extension workflows per request, as
    // canonicalResources reads them (swamp-club#3779).
    const workflowRepo = ctx.repoContext.workflowRepo.memoizedView?.() ??
      ctx.repoContext.workflowRepo;
    // One owner lookup per definition names the outputs and authorizes them
    // (swamp-club#4141).
    const canonical = canonicalResources(ctx, controller.signal);

    // The scans stop when the request is cancelled, so it gives up its
    // place among the shared scan permits (swamp-club#4070).
    const deps: ModelOutputSearchDeps = {
      findAllOutputsGlobal: () => outputRepo.findAllGlobal(controller.signal),
      findAllOutputsGlobalSince: (cutoff) =>
        outputRepo.findAllGlobalSince(cutoff, controller.signal),
      findAllDefinitions: () => definitionRepo.findAllIncludingAutoGlobal(),
      resolveModelNames: (keys) => resolveModelNames(canonical, keys),
      resolveModel: async (idOrName) => {
        const found = new Map<string, ModelOutputSearchModel>();
        const add = (definition: Definition, type: ModelType) => {
          const key = JSON.stringify([type.normalized, definition.id]);
          if (!found.has(key)) {
            found.set(key, {
              definitionId: definition.id,
              name: definition.name,
              type: { normalized: type.normalized },
            });
          }
        };
        const byName = await definitionRepo.findByNameGlobal(idOrName);
        if (byName) add(byName.definition, byName.type);
        // Returns [] for a non-UUID name without scanning every
        // definition — a plain `model` filter never pays for the id scan.
        const byId = await findDefinitionsByIdGlobal(definitionRepo, idOrName);
        for (const { definition, type } of byId) add(definition, type);
        return [...found.values()];
      },
      findOutputsByDefinition: (type, definitionId, window) =>
        outputRepo.findHistoryByDefinition(
          ModelType.create(type.normalized),
          createDefinitionId(definitionId),
          window,
          controller.signal,
        ),
      resolveWorkflowNames: async (ids) => {
        const names = new Map<string, string>();
        for (const workflow of await workflowRepo.findAll()) {
          if (ids.has(workflow.id) && !names.has(workflow.id)) {
            names.set(workflow.id, workflow.name);
          }
        }
        return names;
      },
    };

    // Exported as the output_search diagnostic area's phases
    // (swamp-club#4056): the search's own, then authorization and response.
    await withDiagnosticArea("output_search", async () => {
      let result: ModelOutputSearchData | undefined;
      await consumeStream(
        // Limit only after model authorization, then redact unreadable run links.
        modelOutputSearch(libCtx, deps, {
          ...payload,
          limit: undefined,
          includeProvenance: true,
        }),
        {
          resolving: () => {},
          completed: (e) => {
            result = e.data;
          },
          error: (e) => {
            throw new LibSwampStreamError(e.error);
          },
        },
      );

      if (controller.signal.aborted) {
        sendError(socket, requestId, "cancelled", "Operation was cancelled");
        return;
      }

      const data = (result ?? {}) as {
        results?: ModelOutputSearchItem[];
      };
      const results = data.results;
      if (results) {
        data.results = await observeDiagnosticPhase(
          "authorization",
          {},
          async (phase) => {
            phase.tally.add("items", results.length);
            const readable = await filterOutputItems(
              results,
              canonical,
              socket,
              principal,
              ctx,
            );
            phase.tally.add("readable", readable.length);
            return readable;
          },
        );
      }
      await observeDiagnosticPhase("response", {}, async (phase) => {
        if (data.results) {
          if (payload?.limit !== undefined) {
            data.results = data.results.slice(0, payload.limit);
          }
          await redactWorkflowLinks(
            data.results,
            ctx.authConfig.mode === "none",
            nestedRunReadDecider(ctx, socket, principal),
          );
          phase.tally.add("results", data.results.length);
        }
        send(socket, {
          type: "model.output.search",
          id: requestId,
          payload: { data },
        });
      });
    }, controller.signal);
  } catch (error) {
    // A scan stopped by the cancel answers as one that ran to the end does.
    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }
    const message = sanitizeErrorForClient(error);
    sendError(
      socket,
      requestId,
      "model_output_search_failed",
      message,
      clientErrorDetails(error),
    );
  }
}

export async function handleModelMethodHistoryGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelMethodHistoryGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // Resolve first and authorize every model that owns the output read, not
  // the raw argument (swamp-club#2673).
  const access = await resolveOutputAccess(
    ctx.repoContext.definitionRepo,
    async () => {
      const deps = await createModelOutputGetDeps(
        ctx.repoDir,
        ctx.datastoreResolver,
        ctx.repoContext.definitionRepo,
        ctx.repoContext.unreadableContent,
      );
      return {
        deps,
        reference: await resolveOutputReference(
          deps,
          payload.outputIdOrModelName,
        ),
      };
    },
    payload.outputIdOrModelName,
    ["model"],
  );
  const authorized = authorizeReferenceAccess(
    socket,
    requestId,
    principal,
    "read",
    access,
    payload.outputIdOrModelName,
    ["model"],
    ctx,
    "model_method_history_get_failed",
  );
  if (!authorized) return;
  const { deps, reference } = authorized;

  try {
    const libCtx = handlerLibSwampContext(ctx);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelOutputGet(libCtx, deps, payload.outputIdOrModelName, { reference }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Method history not found");
      return;
    }

    send(socket, {
      type: "model.method.history.get",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(
      socket,
      requestId,
      "model_method_history_get_failed",
      message,
    );
  }
}

export async function handleModelMethodHistoryLogs(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelMethodHistoryLogsPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // Resolve first and authorize every model that owns the output read, not
  // the raw argument (swamp-club#2673).
  const access = await resolveOutputAccess(
    ctx.repoContext.definitionRepo,
    async () => {
      const deps = await createModelMethodHistoryLogsDeps(
        ctx.repoDir,
        ctx.datastoreResolver,
        ctx.repoContext.definitionRepo,
        ctx.repoContext.unreadableContent,
      );
      deps.readLogFile = containedLogFileReader(ctx.repoDir, deps.readLogFile);
      return {
        deps,
        reference: await resolveOutputReference(
          deps,
          payload.outputIdOrModelName,
        ),
      };
    },
    payload.outputIdOrModelName,
    ["model"],
  );
  const authorized = authorizeReferenceAccess(
    socket,
    requestId,
    principal,
    "read",
    access,
    payload.outputIdOrModelName,
    ["model"],
    ctx,
    "model_method_history_logs_failed",
  );
  if (!authorized) return;
  const { deps, reference } = authorized;

  try {
    const libCtx = handlerLibSwampContext(ctx);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelMethodHistoryLogs(libCtx, deps, {
        outputIdOrModelName: payload.outputIdOrModelName,
        tail: payload.tail,
        repoDir: ctx.repoDir,
        reference,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(
        socket,
        requestId,
        "not_found",
        "Method history logs not found",
      );
      return;
    }

    send(socket, {
      type: "model.method.history.logs",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(
      socket,
      requestId,
      "model_method_history_logs_failed",
      message,
    );
  }
}

export async function handleModelMethodHistorySearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ModelMethodHistorySearchPayload,
): Promise<void> {
  if (
    !authorizeAnyOrReject(
      socket,
      requestId,
      principal,
      "read",
      "model",
      ctx,
    )
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const outputRepo = ctx.repoContext.outputRepo;
    const definitionRepo = ctx.repoContext.definitionRepo;

    // One owner lookup per definition names the outputs and authorizes them
    // (swamp-club#4141).
    const canonical = canonicalResources(ctx, controller.signal);

    // The scan stops when the request is cancelled (swamp-club#4070).
    const deps: ModelOutputSearchDeps = {
      findAllOutputsGlobal: () => outputRepo.findAllGlobal(controller.signal),
      findAllDefinitions: () => definitionRepo.findAllIncludingAutoGlobal(),
      resolveModelNames: (keys) => resolveModelNames(canonical, keys),
    };

    // Exported as the output_search diagnostic area's phases
    // (swamp-club#4056).
    await withDiagnosticArea("output_search", async () => {
      let result: Record<string, unknown> | undefined;
      await consumeStream(
        modelOutputSearch(libCtx, deps, { query: payload?.query }),
        {
          resolving: () => {},
          completed: (e) => {
            result = e.data as unknown as Record<string, unknown>;
          },
          error: (e) => {
            throw new Error(e.error.message);
          },
        },
      );

      if (controller.signal.aborted) {
        sendError(socket, requestId, "cancelled", "Operation was cancelled");
        return;
      }

      const data = (result ?? {}) as {
        results?: ModelOutputSearchItem[];
      };
      const results = data.results;
      if (results) {
        data.results = await observeDiagnosticPhase(
          "authorization",
          {},
          async (phase) => {
            phase.tally.add("items", results.length);
            const readable = await filterOutputItems(
              results,
              canonical,
              socket,
              principal,
              ctx,
            );
            phase.tally.add("readable", readable.length);
            return readable;
          },
        );
      }
      await observeDiagnosticPhase("response", {}, (phase) => {
        phase.tally.add("results", data.results?.length ?? 0);
        send(socket, {
          type: "model.method.history.search",
          id: requestId,
          payload: { data },
        });
        return Promise.resolve();
      });
    }, controller.signal);
  } catch (error) {
    // A scan stopped by the cancel answers as one that ran to the end does.
    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }
    const message = sanitizeErrorForClient(error);
    sendError(
      socket,
      requestId,
      "model_method_history_search_failed",
      message,
    );
  }
}

export async function handleModelValidate(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ModelValidatePayload,
): Promise<void> {
  // Without a model this validates every model the caller may read, and only
  // those (swamp-club#2675). A named model is resolved first.
  const modelIdOrName = payload?.modelIdOrName;
  let model:
    | { idOrName: string; byId: boolean; expectedName?: string }
    | undefined;
  let include:
    | ((entry: DefinitionLookupResult) => boolean)
    | undefined;
  // An empty string reads as absent, exactly as libswamp reads it.
  if (!modelIdOrName) {
    if (
      !authorizeAnyOrReject(socket, requestId, principal, "read", "model", ctx)
    ) return;
    const readable = resourceDecider(socket, principal, "read", ctx);
    include = (entry) => readable(modelAccessResource(entry, "model"));
  } else {
    const target = await resolveModelTarget(
      ctx.repoContext.definitionRepo,
      modelIdOrName,
    );
    if (
      !authorizeResolved(
        socket,
        requestId,
        principal,
        "read",
        target,
        modelIdOrName,
        "model",
        ctx,
        "model_validate_failed",
      )
    ) return;
    model = targetArgument(target, modelIdOrName);
  }

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = createModelValidateDeps(
      ctx.repoDir,
      {
        labels: payload?.labels,
        method: payload?.method,
      },
      ctx.datastoreResolver,
      ctx.repoContext.unifiedDataRepo,
      ctx.repoContext.catalogStore,
      ctx.repoContext.definitionRepo,
    );

    let result: Record<string, unknown> | undefined;
    // In a root unit of work with no push: model checks receive the hooked
    // data and definition repositories, so a check that writes stages into
    // the root instead of reaching the hook through signalChange's fallback
    // (swamp-club#3056). Nothing pushes here, as before.
    await runInRootUnitOfWork(
      ctx.repoContext,
      { flush: undefined },
      () =>
        consumeStream(
          modelValidate(libCtx, deps, {
            modelIdOrName: model?.idOrName,
            byId: model?.byId,
            expectedName: model?.expectedName,
            include,
          }),
          {
            resolving: () => {},
            completed: (e) => {
              result = e.data as unknown as Record<string, unknown>;
            },
            error: (e) => {
              throw new Error(e.error.message);
            },
          },
        ),
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "model.validate",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_validate_failed", message);
  }
}

export async function handleModelEvaluate(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ModelEvaluatePayload,
): Promise<void> {
  // Without a model this evaluates every model — evaluation orders them all
  // in one dependency graph — but saves and returns only those the caller
  // may read (swamp-club#2675). A named model is resolved first.
  const modelIdOrName = payload?.modelIdOrName;
  let model:
    | { idOrName: string; byId: boolean; expectedName?: string }
    | undefined;
  let include:
    | ((entry: DefinitionLookupResult) => boolean)
    | undefined;
  // An empty string reads as absent, exactly as libswamp reads it.
  if (!modelIdOrName) {
    if (
      !authorizeAnyOrReject(socket, requestId, principal, "read", "model", ctx)
    ) return;
    const readable = resourceDecider(socket, principal, "read", ctx);
    include = (entry) => readable(modelAccessResource(entry, "model"));
  } else {
    const target = await resolveModelTarget(
      ctx.repoContext.definitionRepo,
      modelIdOrName,
    );
    if (
      !authorizeResolved(
        socket,
        requestId,
        principal,
        "read",
        target,
        modelIdOrName,
        "model",
        ctx,
        "model_evaluate_failed",
      )
    ) return;
    model = targetArgument(target, modelIdOrName);
  }
  // A later --last-evaluated run replays what evaluate saves, so it saves
  // only what the caller may run, decided as resolvedRunAllowed decides a
  // run: admin for a restricted or control-plane type, otherwise run
  // (swamp-club#3940). A caller who may only read gets the evaluation back
  // unsaved.
  const runnable = resourceDecider(socket, principal, "run", ctx);
  const administrable = resourceDecider(socket, principal, "admin", ctx);
  const persist = (entry: DefinitionLookupResult) => {
    const resource = modelAccessResource(entry, "model");
    return isAdminOnlyModelType(
        undefined,
        entry.type.normalized,
        ctx.authConfig.restrictedModelTypes,
      )
      ? administrable({ kind: "access", name: "*", fields: resource.fields })
      : runnable(resource);
  };

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = createModelEvaluateDeps(
      ctx.repoDir,
      ctx.datastoreResolver,
      ctx.repoContext.unifiedDataRepo,
      ctx.repoContext.catalogStore,
      ctx.repoContext.definitionRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      modelEvaluate(libCtx, deps, {
        modelIdOrName: model?.idOrName,
        byId: model?.byId,
        expectedName: model?.expectedName,
        include,
        persist,
      }),
      {
        evaluating: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    const data = result ?? {};

    send(socket, {
      type: "model.evaluate",
      id: requestId,
      payload: { data },
    });
  } catch (error) {
    // Evaluating every model can fail on one the caller may not read, and
    // the error may name it, so such a caller gets no detail.
    const message = !model &&
        !(await readsEveryModel(socket, principal, ctx))
      ? "Evaluating every behavior failed"
      : sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_evaluate_failed", message);
  }
}

/** Whether the caller may read every model definition in the repository. */
async function readsEveryModel(
  socket: WebSocket,
  principal: Principal | null,
  ctx: ConnectionContext,
): Promise<boolean> {
  try {
    const readable = resourceDecider(socket, principal, "read", ctx);
    const all = await ctx.repoContext.definitionRepo.findAllGlobal();
    return all.every((entry) => readable(modelAccessResource(entry, "model")));
  } catch {
    return false;
  }
}

export async function handleModelEdit(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelEditPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (rejectEditWithoutContent(socket, requestId, payload.content)) return;

  // Authorize the model the edit will act on, by its canonical name and full
  // fields, not the raw id-or-name: a grant matches the resource name, so an
  // id would sidestep name-scoped denies (swamp-club#2426, swamp-club#2674).
  let resolved: Awaited<ReturnType<typeof findDefinitionByIdOrName>> = null;
  try {
    resolved = await findDefinitionByIdOrName(
      ctx.repoContext.definitionRepo,
      payload.modelIdOrName,
    );
  } catch {
    // A model that cannot be loaded is authorized by the requested name and
    // then reported as not found.
  }
  const current: ModelEditTarget | null = resolved
    ? {
      name: resolved.definition.name,
      modelType: resolved.type.normalized,
      tags: { ...resolved.definition.tags },
    }
    : null;
  const authorization = current
    ? modelEditAuthorization(current, ctx.authConfig.restrictedModelTypes)
    : {
      action: "write" as const,
      resource: unresolvedAccessResource("model", payload.modelIdOrName),
    };
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      authorization.action,
      authorization.resource,
      ctx,
    ).allowed
  ) return;
  if (!resolved) {
    sendError(
      socket,
      requestId,
      "not_found",
      `Behavior not found: ${payload.modelIdOrName}`,
    );
    return;
  }

  // The root pushes only once the success reply was sent (swamp-club#3035).
  let replied = false;
  await runInRootUnitOfWork(
    ctx.repoContext,
    {
      flush: () =>
        replied
          ? pushChangedToRemote(ctx, {
            onError: (error) =>
              logger.warn(
                "Failed to push behavior edit to remote datastore: {error}",
                { error },
              ),
          })
          : Promise.resolve(),
    },
    async () => {
      try {
        const libCtx = handlerLibSwampContext(ctx);
        const deps = createModelEditDeps(
          ctx.repoDir,
          ctx.repoContext.definitionRepo,
        );

        let result: Record<string, unknown> | undefined;
        await consumeStream(
          modelEdit(libCtx, deps, {
            modelIdOrName: resolved.definition.id,
            byId: true,
            expectedName: resolved.definition.name,
            principalId: principal ? principalToString(principal) : undefined,
            stdinContent: payload.content,
            allowRename: payload.allowRename === true,
            // Every save is authorized against the edited model too, so a
            // rename or retag needs write on the result. It runs on every save
            // rather than only on a detected change, so a concurrent retag
            // between the lookup above and the save cannot skip it.
            authorizeUpdate: async (before, after) => {
              const { action, resource } = modelEditAuthorization(
                after,
                ctx.authConfig.restrictedModelTypes,
              );
              if (
                !authorizeOrReject(
                  socket,
                  requestId,
                  principal,
                  action,
                  resource,
                  ctx,
                ).allowed
              ) return false;
              // A control-plane or restricted model is edited as admin, which
              // covers its tags; any other retag or rename needs `tag`, judged
              // against the tags stored now too (swamp-club#3085).
              if (resource.kind !== "model" || action !== "write") return true;
              const stored = await findDefinitionByIdGlobal(
                ctx.repoContext.definitionRepo,
                resolved.definition.id,
                before.name,
              );
              return authorizeRetag(socket, requestId, principal, {
                prior: (tags) => modelEditResource({ ...before, tags }),
                after: resource,
                loaded: before.tags,
                stored: stored ? { ...stored.definition.tags } : null,
                afterTags: after.tags,
              }, ctx);
            },
            // The expressions the edit adds are authorized against this
            // writer; those already stored are not (swamp-club#2755).
            authorizeContent: async (before, after) => {
              const beforeData = before.toData();
              const afterData = after.toData();
              // An edit to what self or inputs read can retarget a stored
              // reference computed from them.
              const refusal = await authorizeExpressionReferences(
                socketAuthority(socket, requestId, principal, ctx),
                ctx,
                expressionsAddedByEdit(
                  analyzeContentExpressions(beforeData),
                  analyzeContentExpressions(afterData),
                  definitionRetargetSourcesChanged(beforeData, afterData),
                ),
                "allowed",
              );
              if (!refusal) return true;
              sendError(socket, requestId, "unauthorized", refusal.message);
              return false;
            },
          }),
          {
            resolving: () => {},
            launching: () => {},
            completed: (e) => {
              result = e.data as unknown as Record<string, unknown>;
            },
            error: (e) => {
              throw new Error(e.error.message);
            },
          },
        );

        if (controller.signal.aborted) {
          sendError(socket, requestId, "cancelled", "Operation was cancelled");
          return;
        }

        send(socket, {
          type: "model.edit",
          id: requestId,
          payload: { data: result ?? {} },
        });
        replied = true;
      } catch (error) {
        // A denied rename or retag was already reported by authorizeOrReject.
        if (wasRequestErrored(socket, requestId)) return;
        const message = sanitizeErrorForClient(error);
        sendError(socket, requestId, "model_edit_failed", message);
      }
    },
  );
}

/**
 * The action and resource an edit is authorized on, before and after. A
 * control-plane model (grant, group, token, worker) is its access record, so
 * editing one — or editing a model into one — needs admin (swamp-club#2756).
 * A model of a restricted type needs admin on access:*, judged on its fields,
 * as creating or running one does (swamp-club#3131).
 */
function modelEditAuthorization(
  target: ModelEditTarget,
  restrictedModelTypes: readonly string[],
): { action: Action; resource: AccessResource } {
  if (isControlPlaneModelType(target.modelType)) {
    return {
      action: "write",
      resource: controlPlaneRecordResource(target.modelType, {
        name: target.name,
        tags: target.tags,
      }),
    };
  }
  const resource = modelEditResource(target);
  if (isAdminOnlyModelType(undefined, target.modelType, restrictedModelTypes)) {
    return {
      action: "admin",
      resource: { kind: "access", name: "*", fields: resource.fields },
    };
  }
  return { action: "write", resource };
}

/** The model resource an edit of an ordinary model is authorized on. */
function modelEditResource(target: ModelEditTarget): AccessResource {
  return {
    kind: "model",
    name: target.name,
    fields: {
      modelType: target.modelType,
      name: target.name,
      tags: target.tags,
    },
  };
}

export async function handleModelTypeDescribe(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: ModelTypeDescribePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeAnyOrReject(
      socket,
      requestId,
      principal,
      "read",
      "model",
      ctx,
    )
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = createTypeDescribeDeps();
    const modelType = ModelType.create(payload.typeArg);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      typeDescribe(libCtx, deps, modelType),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "model.type.describe",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_type_describe_failed", message);
  }
}

export async function handleModelTypeSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: ModelTypeSearchPayload,
): Promise<void> {
  if (
    !authorizeAnyOrReject(
      socket,
      requestId,
      principal,
      "read",
      "model",
      ctx,
    )
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    await modelRegistry.ensureLoaded();
    const deps: TypeSearchDeps = {
      getRegisteredTypes: () => modelRegistry.publicTypes(),
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      typeSearch(libCtx, deps, { query: payload?.query }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "model.type.search",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_type_search_failed", message);
  }
}

/**
 * Drops the workflow linkage from each output whose workflow the principal
 * may not read. A linkage whose workflow no longer resolves cannot be
 * authorized, so it is dropped too unless the server has no authorization.
 */
export async function redactWorkflowLinks(
  items: ModelOutputSearchItem[],
  unrestricted: boolean,
  canRead: (workflow: NamedWorkflow) => Promise<boolean>,
): Promise<void> {
  for (const item of items) {
    if (
      item.workflowId === undefined && item.workflowRunId === undefined &&
      item.stepName === undefined
    ) continue;
    let readable = unrestricted;
    if (!readable && item.workflowId !== undefined && item.workflowName) {
      readable = await canRead({
        workflowId: item.workflowId,
        workflowName: item.workflowName,
      });
    }
    if (!readable) {
      delete item.workflowId;
      delete item.workflowName;
      delete item.workflowRunId;
      delete item.stepName;
    }
  }
}

/**
 * The names of the definitions an output search asks for, in order, from the
 * request's owner lookups, which authorizing its items then reuses. One at a
 * time, as authorization looks them up, so the files open at once stay
 * bounded.
 */
async function resolveModelNames(
  canonical: CanonicalResources,
  keys: ReadonlyArray<{ type: { normalized: string }; definitionId: string }>,
): Promise<Array<string | undefined>> {
  const names: Array<string | undefined> = [];
  for (const { type, definitionId } of keys) {
    names.push(await canonical.modelName(definitionId, type.normalized));
  }
  return names;
}

/**
 * Keeps the output or method-run items the caller may read: each is judged on
 * every model owning its definition id, with the method it ran, so a
 * methods-scoped or tag-conditioned grant applies to it (swamp-club#2675).
 */
function filterOutputItems(
  items: ModelOutputSearchItem[],
  canonical: CanonicalResources,
  socket: WebSocket,
  principal: Principal | null,
  ctx: ConnectionContext,
): Promise<ModelOutputSearchItem[]> {
  return filterByResources(
    items,
    async (item) =>
      (await canonical.modelOwners(
        item.definitionId,
        item.type,
        item.modelName ?? item.definitionId,
        "model",
      )).map((owner) => ({
        ...owner,
        fields: { ...owner.fields, methodName: item.methodName },
      })),
    socket,
    principal,
    "read",
    ctx,
  );
}

/**
 * The normalized model type for authorization, or the raw string when it
 * does not parse — the operation then reports the invalid type itself,
 * inside its own error handling.
 */
function normalizedTypeOrRaw(typeArg: string): string {
  try {
    return ModelType.create(typeArg).normalized;
  } catch {
    return typeArg;
  }
}
