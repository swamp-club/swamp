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
  modelOutputSearch,
  type ModelOutputSearchDeps,
  type ModelOutputSearchItem,
} from "../../libswamp/models/output_search.ts";
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
import { withSharedSyncGate } from "../sync_gate.ts";
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
  findDefinitionByIdOrName,
} from "../../domain/models/model_lookup.ts";
import type { AccessResource } from "../../domain/access/access_decision_service.ts";
import type { Action } from "../../domain/access/action.ts";
import { createDefinitionId } from "../../domain/definitions/definition.ts";
import {
  acquireModelLocks,
  type ModelLockResult,
  runUnderModelLocks,
} from "../../cli/repo_context.ts";
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
import {
  inferMethodKind,
  isMutatingKind,
  modelRegistry,
} from "../../domain/models/model.ts";
import { resolveModelType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../../domain/extensions/auto_resolver_context.ts";
import { RegistryCapacityError } from "../active_run_registry.ts";
import { RunEventBuffer } from "../run_event_buffer.ts";
import { deleteActiveRun, writeActiveRun } from "../active_run_tracker.ts";
import {
  authorizeAnyOrReject,
  authorizeOrReject,
  clientErrorDetails,
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
  sanitizeErrorForClient,
  send,
  sendError,
  subscribeUntilDetach,
  wasRequestErrored,
} from "./shared.ts";
import { requestRunVaultScope } from "../run_vault_access_policy.ts";
import { runGeneratorWithVaultAccess } from "../../domain/vaults/run_vault_access.ts";
import { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";
import {
  authorizeReferenceAccess,
  authorizeResolved,
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
import {
  analyzeContentExpressions,
  definitionRetargetSourcesChanged,
  expressionsAddedByEdit,
} from "../../domain/expressions/expression_references.ts";
import { authorizeExpressionReferences } from "./expression_reference_authorization.ts";

const logger = getSwampLogger(["serve", "connection"]);

const DEFAULT_BUFFER_CAPACITY = 10_000;

export async function isMethodMutating(
  modelType: string,
  methodName: string,
): Promise<boolean> {
  try {
    const modelDef = await resolveModelType(modelType, getAutoResolver());
    if (!modelDef) return true;
    const method = modelDef.methods[methodName];
    return isMutatingKind(inferMethodKind(methodName, method));
  } catch {
    return true;
  }
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
 * Replies and returns false on a refusal.
 */
async function authorizeRunInputs(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  payload: ModelMethodRunPayload,
  target: MethodRunTarget,
  ctx: ConnectionContext,
): Promise<boolean> {
  const expressions = analyzeContentExpressions(payload.inputs ?? {});
  if (expressions.length === 0) return true;
  const runOn = target.run?.resource ?? target.resource;
  const { methodName: _methodName, ...fields } = runOn.fields;
  // Decided only when an input reads env, so a refusal is audited exactly
  // when it decides the request.
  const writable = !expressions.some((e) => e.references.usesEnv) ||
    isAuthorized(socket, requestId, principal, "write", {
      ...runOn,
      fields,
    }, ctx);
  const refusal = await authorizeExpressionReferences(
    socket,
    requestId,
    principal,
    ctx,
    expressions,
    writable ? "allowed" : { refusedFor: runOn.name },
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
    let mutating = true;
    let lockPushFailure: { error: unknown } | undefined;
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
        const message = sanitizeErrorForClient(error);
        const exType = exceptionTypeForClient(error);
        sendError(
          socket,
          requestId,
          "method_execution_failed",
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

      // The root's flush is the model lock's push when the run took one, on
      // every outcome; otherwise the run's push once it completed. The
      // reply, telemetry and cancel deregistration keep their place: before
      // a lock's push, and around the no-lock push as before
      // (swamp-club#3055).
      await runInRootUnitOfWork(
        ctx.repoContext,
        {
          flush: async ({ completed }) => {
            if (modelLocks) {
              try {
                await modelLocks.push();
              } catch (error) {
                lockPushFailure = { error };
              }
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
              // A direct type execution can rewrite an existing definition's
              // global arguments whatever the method, so it always locks.
              mutating = target.run !== undefined ||
                await isMethodMutating(
                  preResult.type.normalized,
                  payload.methodName,
                );
              if (mutating) {
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
                  { wrapSync: (fn) => withSharedSyncGate(ctx.syncGate, fn) },
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

            if (ctx.cancelRegistry) {
              ctx.cancelRegistry.register("method-run", requestId, controller);
            }

            const runMethod = async () => {
              for await (
                const event of runGeneratorWithVaultAccess(
                  vaultAccess?.access,
                  () =>
                    modelMethodRun(libCtx, deps, {
                      modelIdOrName: target.modelIdOrName,
                      byId: target.byId,
                      expectedName: target.expectedName,
                      methodName: payload.methodName,
                      inputs: payload.inputs ?? {},
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
            if (modelLocks) await telemetry?.finish(null);
          } catch (error) {
            if (modelLocks) {
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
          if (modelLocks) deregister();
        },
      );
      if (!modelLocks) await telemetry?.finish(null);
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
  const buffer = new RunEventBuffer(DEFAULT_BUFFER_CAPACITY);
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

  const detachedMutating = preResult
    ? target.run !== undefined ||
      await isMethodMutating(preResult.type.normalized, payload.methodName)
    : true;

  (async () => {
    // Assigned in the root below, which control flow analysis cannot see.
    let modelLocks = undefined as ModelLockResult | undefined;
    let lockPushFailure: { error: unknown } | undefined;
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
          code: "method_execution_failed",
          message: sanitizeErrorForClient(error),
          ...(exType !== undefined && {
            details: { exceptionType: exType },
          }),
        });
      }
    };
    try {
      // The root's flush is the model lock's push when the run took one, on
      // every outcome, after the stream's terminal; otherwise the run's push
      // once it completed, before the terminal (swamp-club#3055).
      await runInRootUnitOfWork(
        ctx.repoContext,
        {
          flush: async ({ completed }) => {
            if (modelLocks) {
              try {
                await modelLocks.push();
              } catch (error) {
                lockPushFailure = { error };
              }
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
                { wrapSync: (fn) => withSharedSyncGate(ctx.syncGate, fn) },
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

            const doRun = async () => {
              for await (
                const event of runGeneratorWithVaultAccess(
                  vaultAccess?.access,
                  () =>
                    modelMethodRun(libCtx, deps, {
                      modelIdOrName: target.modelIdOrName,
                      byId: target.byId,
                      expectedName: target.expectedName,
                      methodName: payload.methodName,
                      inputs: payload.inputs ?? {},
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
            if (modelLocks) {
              buffer.finish({ kind: "done" });
              await detachedTelemetry?.finish(null);
            }
          } catch (error) {
            if (modelLocks) {
              answered = true;
              answeredError = error;
              await finishWithError(error);
            }
            throw error;
          }
        },
      );
      if (!modelLocks) {
        buffer.finish({ kind: "done" });
        await detachedTelemetry?.finish(null);
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
      sendError(socket, requestId, "not_found", "Model not found");
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
    socket,
    requestId,
    principal,
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
            "Model creation failed",
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
            `Model has associated data (${preview.dataArtifactCount} artifacts, ${preview.outputCount} outputs). Use force to delete.`,
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
            "Model deletion failed",
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
      const deps = await createModelOutputGetDeps(
        ctx.repoDir,
        undefined,
        ctx.repoContext.definitionRepo,
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

    const deps: ModelOutputSearchDeps = {
      findAllOutputsGlobal: () => outputRepo.findAllGlobal(),
      findDefinitionById: (type, definitionId) =>
        definitionRepo.findById(
          ModelType.create(type.normalized),
          createDefinitionId(definitionId),
        ),
    };

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
    if (data.results) {
      data.results = await filterOutputItems(
        data.results,
        socket,
        principal,
        ctx,
      );
    }

    send(socket, {
      type: "model.output.search",
      id: requestId,
      payload: { data },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "model_output_search_failed", message);
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
        undefined,
        ctx.repoContext.definitionRepo,
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
        undefined,
        ctx.repoContext.definitionRepo,
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

    const deps: ModelOutputSearchDeps = {
      findAllOutputsGlobal: () => outputRepo.findAllGlobal(),
      findDefinitionById: (type, definitionId) =>
        definitionRepo.findById(
          ModelType.create(type.normalized),
          createDefinitionId(definitionId),
        ),
    };

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
    if (data.results) {
      data.results = await filterOutputItems(
        data.results,
        socket,
        principal,
        ctx,
      );
    }

    send(socket, {
      type: "model.method.history.search",
      id: requestId,
      payload: { data },
    });
  } catch (error) {
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
      ? "Evaluating every model failed"
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
      `Model not found: ${payload.modelIdOrName}`,
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
                "Failed to push model edit to remote datastore: {error}",
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
            stdinContent: payload.content,
            // Every save is authorized against the edited model too, so a
            // rename or retag needs write on the result. It runs on every save
            // rather than only on a detected change, so a concurrent retag
            // between the lookup above and the save cannot skip it.
            authorizeUpdate: (_before, after) => {
              const { action, resource } = modelEditAuthorization(
                after,
                ctx.authConfig.restrictedModelTypes,
              );
              return authorizeOrReject(
                socket,
                requestId,
                principal,
                action,
                resource,
                ctx,
              ).allowed;
            },
            // The expressions the edit adds are authorized against this
            // writer; those already stored are not (swamp-club#2755).
            authorizeContent: async (before, after) => {
              const beforeData = before.toData();
              const afterData = after.toData();
              // An edit to what self or inputs read can retarget a stored
              // reference computed from them.
              const refusal = await authorizeExpressionReferences(
                socket,
                requestId,
                principal,
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
  const fields = {
    modelType: target.modelType,
    name: target.name,
    tags: target.tags,
  };
  if (isAdminOnlyModelType(undefined, target.modelType, restrictedModelTypes)) {
    return { action: "admin", resource: { kind: "access", name: "*", fields } };
  }
  return {
    action: "write",
    resource: { kind: "model", name: target.name, fields },
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
 * Keeps the output or method-run items the caller may read: each is judged on
 * every model owning its definition id, with the method it ran, so a
 * methods-scoped or tag-conditioned grant applies to it (swamp-club#2675).
 */
function filterOutputItems(
  items: ModelOutputSearchItem[],
  socket: WebSocket,
  principal: Principal | null,
  ctx: ConnectionContext,
): Promise<ModelOutputSearchItem[]> {
  const canonical = canonicalResources(ctx);
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
