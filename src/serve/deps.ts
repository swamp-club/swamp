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

import { SIGNAL_WAITS_NOT_CONFIGURED } from "../domain/workflows/signal_wait_store.ts";
import { join } from "@std/path";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import {
  repoUnitOfWorkFactory,
  runInRootUnitOfWork,
} from "../infrastructure/persistence/repo_unit_of_work.ts";
import { WorkflowRunCheckpointer } from "../infrastructure/persistence/workflow_run_checkpointer.ts";
import { withCommittedUnknownSteps } from "./handlers/shared.ts";
import type { ModelMethodRunDeps } from "../libswamp/models/run.ts";
import type {
  WorkflowRunDeps,
  WorkflowRunEvent,
  WorkflowRunInput,
  WorkflowTelemetrySink,
} from "../libswamp/workflows/run.ts";
import { errorPaths, markErrorPaths, UserError } from "../domain/errors.ts";
import type { WorkflowTriggerSource } from "../domain/telemetry/mod.ts";
import { createRunTelemetry, type RunTelemetry } from "./telemetry.ts";
import { createLibSwampContext } from "../libswamp/context.ts";
import { workflowRun } from "../libswamp/workflows/run.ts";
import {
  type DirectTypeResolver,
  type StepLockHook,
  WorkflowExecutionService,
} from "../domain/workflows/execution_service.ts";
import {
  findWorkflowById,
  findWorkflowByIdOrName,
} from "../domain/workflows/workflow_lookup.ts";
import type { RunTrackerRepository } from "../domain/models/run_tracker_repository.ts";
import type { RunCheckpointer } from "../domain/workflows/run_checkpointer.ts";
import { TriggerInputResolver } from "../domain/workflows/trigger_input_resolver.ts";
import { buildEnvContext } from "../domain/expressions/model_resolver.ts";
import { CelEvaluator } from "../infrastructure/cel/cel_evaluator.ts";
import { ModelType } from "../domain/models/model_type.ts";
import { resolveOrCreateDefinition } from "../libswamp/models/direct_execution.ts";
import { YamlDefinitionRepository } from "../infrastructure/persistence/yaml_definition_repository.ts";
import type { DefinitionId } from "../domain/definitions/definition.ts";
import {
  findDefinitionByIdGlobal,
  findDefinitionByIdOrName,
} from "../domain/models/model_lookup.ts";
import { resolveModelType } from "../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../domain/extensions/auto_resolver_context.ts";
import { DefaultMethodExecutionService } from "../domain/models/method_execution_service.ts";
import { VaultService } from "../domain/vaults/vault_service.ts";
import { ExpressionEvaluationService } from "../domain/expressions/expression_evaluation_service.ts";
import { DataQueryService } from "../domain/data/data_query_service.ts";
import {
  getSwampLogger,
  runFileSink,
} from "../infrastructure/logging/logger.ts";
import {
  resolvePulledExtensionsRoot,
  SWAMP_SUBDIRS,
  swampPath,
} from "../infrastructure/persistence/paths.ts";
import { SecretRedactor } from "../domain/secrets/mod.ts";
import { modelRegistry } from "../domain/models/model.ts";
import { vaultTypeRegistry } from "../domain/vaults/vault_type_registry.ts";
import { reportRegistry } from "../domain/reports/report_registry.ts";
import {
  type DatastoreConfig,
  isCustomDatastoreConfig,
} from "../domain/datastore/datastore_config.ts";
import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import { DefaultDatastorePathResolver } from "../infrastructure/persistence/default_datastore_path_resolver.ts";
import { YamlEvaluatedWorkflowRepository } from "../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import {
  acquireModelLocks,
  createWorkflowRunClaims,
  type LockProgressWriter,
  type ModelLockResult,
  tryModelLock,
} from "../cli/repo_context.ts";
import {
  AUTO_DEFINITION_RETENTION_LOCK_WAIT_MS,
  type AutoDefinitionRetentionSources,
  autoDefinitionRetentionSourcesOf,
} from "../libswamp/retention/auto_definitions.ts";
import {
  extractTraceContext,
  runWithParentTrace,
} from "../infrastructure/tracing/mod.ts";
import {
  type SyncGate,
  withRunSyncGate,
  withSharedSyncGate,
} from "./sync_gate.ts";
import { pushNamespace } from "../infrastructure/persistence/push_paths.ts";
import { refreshLocalModelsForRun } from "./local_model_refresh.ts";
import { runWithVaultAccess } from "../domain/vaults/run_vault_access.ts";
import type { ServeRunVaultScope } from "./run_vault_access_policy.ts";
import type { RunWriteFence } from "../domain/workflows/run_write_fence.ts";
import type { WorkflowRun } from "../domain/workflows/workflow_run.ts";

const logger = getSwampLogger(["serve", "deps"]);

export async function createWorkflowRunDeps(
  repoDir: string,
  repoContext: RepositoryContext,
  datastoreConfig: DatastoreConfig,
  stepLockHook?: StepLockHook,
  runTracker?: RunTrackerRepository,
  options?: {
    /**
     * undefined for callers that are not a serve-executed run and when
     * telemetry is disabled, so libswamp's bridge is never constructed
     */
    telemetrySink?: WorkflowTelemetrySink;
    runCheckpointer?: RunCheckpointer;
    /**
     * the repo's defaultVault as serve read it at startup: where a step's
     * sensitive outputs land when nothing names a vault
     */
    defaultVault?: string;
    /**
     * serve's run write fence, closed by shutdown for the runs it interrupts;
     * every serve caller passes it
     */
    runWriteFence?: RunWriteFence;
    onCompletedRun?: (run: WorkflowRun) => void;
  },
): Promise<WorkflowRunDeps> {
  await Promise.all([
    modelRegistry.ensureLoaded(),
    vaultTypeRegistry.ensureLoaded(),
    reportRegistry.ensureLoaded(),
  ]);
  await refreshLocalModelsForRun();
  // Read from the datastore-resolved path ExecutionService writes to.
  const evaluatedWorkflows = () =>
    new YamlEvaluatedWorkflowRepository(
      repoDir,
      new DefaultDatastorePathResolver(repoDir, datastoreConfig)
        .resolvePath(SWAMP_SUBDIRS.workflowsEvaluated),
    );
  return {
    workflowRepo: repoContext.workflowRepo,
    runRepo: repoContext.workflowRunRepo,
    repoDir,
    lookupWorkflow: (repo, idOrName) => findWorkflowByIdOrName(repo, idOrName),
    createExecutionService: (
      wfRepo,
      rnRepo,
      dir,
      catalogStore,
      ephRepo,
      ephCatalog,
    ) => {
      // direct type execution must work over serve as it does locally, as serve
      // is the only way to run workflows with worker placement
      const directResolver: DirectTypeResolver = async (
        typeArg,
        defName,
        methodName,
        inputs,
        globalArgs,
        authoredExpressions,
        sensitiveValues,
        provenance,
      ) => {
        let resolvedType = ModelType.create(typeArg);
        let modelDef = await resolveModelType(resolvedType, getAutoResolver());
        if (!modelDef && typeArg.startsWith("@")) {
          const strippedType = ModelType.create(typeArg.slice(1));
          const strippedDef = await resolveModelType(
            strippedType,
            getAutoResolver(),
          );
          if (strippedDef) {
            resolvedType = strippedType;
            modelDef = strippedDef;
          }
        }
        if (!modelDef) {
          throw new Error(`Unknown behavior type: ${resolvedType.normalized}`);
        }
        resolvedType = modelDef.type;
        const autoDefRepo = new YamlDefinitionRepository(
          dir,
          repoContext.eventBus,
          repoContext.autoDefinitionsDir,
          false,
          repoContext.markDirty,
        );
        const result = await resolveOrCreateDefinition(
          {
            // from serve's definition index, so a new name does not walk every
            // definition before the creation lock and again under it
            lookupDefinition: (name) =>
              findDefinitionByIdOrName(
                repoContext.definitionRepo,
                name,
                (n) => repoContext.definitionRepo.findByNameGlobalFromIndex(n),
              ),
            getModelDef: (type) => resolveModelType(type, getAutoResolver()),
            saveDefinition: (type, def) => autoDefRepo.save(type, def),
            getDefinitionPath: (type, id) =>
              autoDefRepo.getPath(type, id as DefinitionId),
          },
          typeArg,
          defName,
          methodName,
          inputs,
          resolvedType,
          modelDef,
          globalArgs,
          repoContext.autoDefinitionsDir,
          authoredExpressions,
          sensitiveValues,
          provenance,
        );
        if (!result.ok) throw new Error(result.error.message);
        return {
          definition: result.definition,
          modelType: result.modelType,
          created: result.created,
          routedMethodInputs: result.routedInputs.methodArguments,
          authoredExpressions: result.authoredExpressions,
        };
      };
      const resolver = new DefaultDatastorePathResolver(dir, datastoreConfig);
      const service = new WorkflowExecutionService(
        wfRepo,
        rnRepo,
        dir,
        undefined,
        resolver.resolvePath(SWAMP_SUBDIRS.data),
        catalogStore,
        directResolver,
        repoContext.markDirty,
        repoContext.unifiedDataRepo.namespace,
        stepLockHook,
        runTracker,
        ephRepo,
        ephCatalog,
        resolvePulledExtensionsRoot(dir),
        repoContext.hydrateFile,
        undefined,
        resolver,
        repoContext.autoGc,
        repoContext.unifiedDataRepo.fetchForeignContent,
        repoContext.unreadableContent,
        options?.defaultVault,
        repoContext.unifiedDataRepo.writeSync,
      );
      service.signalWaits = repoContext.signalWaits ??
        SIGNAL_WAITS_NOT_CONFIGURED;
      if (repoContext.commitLog !== undefined) {
        service.reportLock = stepLockHook;
      }
      // a resume takes the run's lock and its suspension's claim, so two serve
      // instances on one datastore never take over the same run
      service.runClaims = createWorkflowRunClaims(datastoreConfig);
      service.continuationClaims = repoContext.continuationClaims;
      service.runRecordCurrency = repoContext.runRecordCurrency;
      if (options?.runCheckpointer !== undefined) {
        service.runCheckpointer = options.runCheckpointer;
      }
      if (options?.runWriteFence !== undefined) {
        service.runWriteFence = options.runWriteFence;
      }
      return service;
    },
    catalogStore: repoContext.catalogStore,
    dataRepo: repoContext.unifiedDataRepo,
    definitionRepo: repoContext.definitionRepo,
    telemetrySink: options?.telemetrySink,
    onCompletedRun: options?.onCompletedRun,
    supersede: {
      findSuspendedRuns: (workflowId, signal) =>
        repoContext.workflowRunRepo.findByStatus(
          workflowId,
          "suspended",
          signal,
        ),
      findEvaluatedWorkflow: (runId) => evaluatedWorkflows().findByRunId(runId),
      // on a v3 datastore only evaluations with no forwarded writer run: none
      // trusted refuses rather than falling back to the file
      evaluatedCache: async (name) => {
        const trust = repoContext.evaluationTrust;
        if (trust === undefined) {
          return await evaluatedWorkflows().findByNameWithProvenance(name);
        }
        const cache = await trust.workflow(name);
        if (cache === null) {
          throw new UserError(
            `No previously evaluated workflow found for "${name}" that this ` +
              `server can run.\n\nEvaluate the workflow first:\n` +
              `  swamp workflow evaluate ${name}`,
          );
        }
        return cache;
      },
      // Superseded runs are locally owned, so a local approve, reject or
      // cancel can be deciding one at the same moment.
      runClaims: createWorkflowRunClaims(datastoreConfig),
    },
  };
}

export async function createModelMethodRunDeps(
  repoDir: string,
  repoContext: RepositoryContext,
  options?: {
    directExecution?: boolean;
    runTracker?: ModelMethodRunDeps["runTracker"];
    defaultVault?: string;
  },
): Promise<ModelMethodRunDeps> {
  await Promise.all([
    modelRegistry.ensureLoaded(),
    vaultTypeRegistry.ensureLoaded(),
    reportRegistry.ensureLoaded(),
  ]);
  await refreshLocalModelsForRun();

  const isDirectExecution = options?.directExecution ?? false;

  return {
    repoDir,
    lookupDefinition: (idOrName) =>
      findDefinitionByIdOrName(repoContext.definitionRepo, idOrName),
    lookupDefinitionById: (id, expectedName) =>
      findDefinitionByIdGlobal(repoContext.definitionRepo, id, expectedName),
    getModelDef: (type) => resolveModelType(type, getAutoResolver()),
    createEvaluationService: () => {
      const dqs = new DataQueryService(
        repoContext.catalogStore,
        repoContext.unifiedDataRepo,
      );
      return new ExpressionEvaluationService(
        repoContext.definitionRepo,
        repoDir,
        {
          dataRepo: repoContext.unifiedDataRepo,
          dataQueryService: dqs,
        },
      );
    },
    loadEvaluatedDefinition: (type, name) =>
      repoContext.evaluationTrust?.definition(type, name) ??
        repoContext.evaluatedDefinitionRepo.findByNameWithProvenance(
          type,
          name,
        ),
    saveEvaluatedDefinition: (
      type,
      definition,
      provenance,
      authoredExpressions,
      writtenReferences,
      maskedPaths,
      persistedProvenance,
    ) =>
      repoContext.evaluatedDefinitionRepo.save(
        type,
        definition,
        provenance,
        authoredExpressions,
        undefined,
        writtenReferences,
        maskedPaths,
        persistedProvenance,
      ),
    createExecutionService: () => new DefaultMethodExecutionService(),
    createVaultService: () =>
      VaultService.fromRepository(repoDir, {
        defaultVaultName: options?.defaultVault,
      }),
    dataRepo: repoContext.unifiedDataRepo,
    catalogStore: repoContext.catalogStore,
    definitionRepo: repoContext.definitionRepo,
    outputRepo: repoContext.outputRepo,
    dataQueryService: new DataQueryService(
      repoContext.catalogStore,
      repoContext.unifiedDataRepo,
    ),
    createRunLog: async (modelType, method, definitionId) => {
      const redactor = new SecretRedactor();
      const runId = crypto.randomUUID();
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logFilePath = join(
        swampPath(repoDir, SWAMP_SUBDIRS.outputs),
        modelType.normalized,
        method,
        `${definitionId}-${timestamp}.log`,
      );
      const logHandle = await runFileSink.register(
        [],
        logFilePath,
        redactor,
        swampPath(repoDir),
        { runId },
      );
      return {
        logFilePath,
        redactor,
        cleanup: () => runFileSink.unregister(logHandle),
        runId,
      };
    },
    createAndSaveDefinition: isDirectExecution
      ? async (type, definition) => {
        const autoDefRepo = new YamlDefinitionRepository(
          repoDir,
          repoContext.eventBus,
          repoContext.autoDefinitionsDir,
          false,
          repoContext.markDirty,
        );
        await autoDefRepo.save(type, definition);
      }
      : undefined,
    getDefinitionPath: isDirectExecution
      ? (type, id) => {
        return join(
          repoContext.autoDefinitionsDir,
          type.toDirectoryPath(),
          `${id}.yaml`,
        );
      }
      : undefined,
    runTracker: options?.runTracker,
    eventBus: repoContext.eventBus,
    workflowRepo: repoContext.workflowRepo,
    workflowRunRepo: repoContext.workflowRunRepo,
  };
}

/**
 * pull and flush push run in the sync gate's shared mode, never overlapping a
 * poller pull; a lock's last publish runs alone; syncGate is required so a new
 * caller cannot run ungated
 */
export function createStepLockHook(
  repoDir: string,
  repoContext: RepositoryContext,
  datastoreConfig: DatastoreConfig,
  syncService: DatastoreSyncService | undefined,
  syncGate: SyncGate | undefined,
  progressWriter?: (modelId: string) => LockProgressWriter,
  /**
   * called when a step's fenced lease at serve lapses so the caller cancels the
   * run; only a checkout's locks are serve leases, serve's own runs lock
   * locally
   */
  onLeaseLost?: (reason: unknown) => void,
  /** false only for a checkout, whose lease at serve commits before release */
  commitBeforeRelease = true,
): StepLockHook {
  return async (modelType, modelId, _step, signal) => {
    const result = await acquireModelLocks(
      datastoreConfig,
      [{ modelType, modelId }],
      repoDir,
      syncService,
      repoContext.catalogStore,
      progressWriter?.(modelId),
      {
        wrapSync: (fn, kind) => withRunSyncGate(syncGate, fn, kind),
        repoContext,
        signal,
        commitBeforeRelease,
      },
    );
    if (result.synced) repoContext.catalogStore.invalidate();
    const lost = result.leaseLost;
    if (lost !== undefined && onLeaseLost !== undefined) {
      if (lost.aborted) onLeaseLost(lost.reason);
      else {
        lost.addEventListener("abort", () => onLeaseLost(lost.reason), {
          once: true,
        });
      }
    }
    return result;
  };
}

/**
 * one record's model lock for a write serve makes itself, outside any run;
 * its pull and push take the sync gate's shared mode like a step's
 */
export function createRecordLock(
  repoDir: string,
  repoContext: RepositoryContext,
  datastoreConfig: DatastoreConfig,
  syncService: DatastoreSyncService | undefined,
  syncGate: SyncGate | undefined,
): (modelType: string, modelId: string) => Promise<ModelLockResult> {
  return (modelType, modelId) =>
    acquireModelLocks(
      datastoreConfig,
      [{ modelType, modelId }],
      repoDir,
      syncService,
      repoContext.catalogStore,
      undefined,
      {
        wrapSync: (fn, kind) => withRunSyncGate(syncGate, fn, kind),
        repoContext,
      },
    );
}

/**
 * runs in one root unit of work whose flush is the post-run push, on every
 * outcome; call only where no root is open, since a nested root makes
 * runInRootUnitOfWork throw rather than drop its push
 */
export async function executeWorkflowWithLocks(
  repoDir: string,
  repoContext: RepositoryContext,
  datastoreConfig: DatastoreConfig,
  input: WorkflowRunInput,
  signal: AbortSignal,
  onEvent: (event: WorkflowRunEvent) => void,
  syncService: DatastoreSyncService | undefined,
  runTracker: RunTrackerRepository | undefined,
  options: {
    /**
     * the run's step syncs and post-run push take its shared mode so they never
     * overlap a poller pull; required so a new caller cannot run ungated
     */
    syncGate: SyncGate | undefined;
    triggerSource?: WorkflowTriggerSource;
    initiatedBy?: string;
    /**
     * entered around the run so every vault operation in it is decided for the
     * triggering principal; every serve caller passes it; undefined where no
     * policy applies
     */
    vaultAccess?: ServeRunVaultScope;
    defaultVault?: string;
    runWriteFence?: RunWriteFence;
    /** handed the live run before its completed event reaches onEvent */
    onCompletedRun?: (run: WorkflowRun) => void;
  },
): Promise<void> {
  // Pre-lookup workflow for trigger.inputs resolution — by the same rule the
  // run itself uses, so both see the same workflow.
  const workflowRepo = repoContext.workflowRepo;
  const workflow = input.byId
    ? await findWorkflowById(
      workflowRepo,
      input.workflowIdOrName,
      input.expectedName,
    )
    : await findWorkflowByIdOrName(workflowRepo, input.workflowIdOrName);

  const stepLockHook = createStepLockHook(
    repoDir,
    repoContext,
    datastoreConfig,
    syncService,
    options.syncGate,
  );

  const runTelemetry = options.triggerSource
    ? createRunTelemetry(
      options.triggerSource,
      workflow?.name ?? input.workflowIdOrName,
      {
        initiatedBy: options.initiatedBy,
      },
    )
    : undefined;

  const runCheckpointer = new WorkflowRunCheckpointer(repoContext);
  const deps = await createWorkflowRunDeps(
    repoDir,
    repoContext,
    datastoreConfig,
    stepLockHook,
    runTracker,
    {
      telemetrySink: runTelemetry?.sink,
      runCheckpointer,
      defaultVault: options.defaultVault,
      runWriteFence: options.runWriteFence,
      onCompletedRun: options.onCompletedRun,
    },
  );
  const libCtx = createLibSwampContext({
    signal,
    openUnitOfWork: repoUnitOfWorkFactory(repoContext),
  });

  // precedence is caller inputs > trigger.inputs > schema defaults; webhook
  // trigger.inputs resolve against the payload here, before coercion and
  // validation, so a required input mapped from it satisfies the schema
  let resolvedTriggerInputs: Record<string, unknown> | undefined;
  if (workflow && input.webhook && workflow.triggerInputs) {
    const resolver = new TriggerInputResolver(new CelEvaluator());
    resolvedTriggerInputs = await resolver.resolve(workflow.triggerInputs, {
      model: {},
      env: buildEnvContext(),
      webhook: input.webhook,
    });
  }

  const effectiveInput: WorkflowRunInput = {
    ...(workflow
      ? {
        ...input,
        inputs: workflow.baselineInputs(
          input.inputs ?? {},
          resolvedTriggerInputs,
        ),
      }
      : input),
    triggerSource: options.triggerSource,
  };

  // A workflow run reports failure through the event stream, not by
  // throwing: input validation, a failed step, and a cancellation all
  // complete normally from the caller's point of view. Recording those as
  // successes would credit work that did not happen, so the outcome is read
  // from the stream rather than from control flow.
  let streamError: string | undefined;
  let streamErrorPaths: string[] = [];
  let finalStatus: string | undefined;
  const vaultScope = options.vaultAccess;
  const consume = async () => {
    for await (const event of workflowRun(libCtx, deps, effectiveInput)) {
      if (event.kind === "error") {
        streamError = event.error.message;
        streamErrorPaths = errorPaths(event.error.cause);
      }
      if (event.kind === "completed" || event.kind === "cancelled") {
        finalStatus = event.run.status;
      }
      if (
        vaultScope && event.kind === "started" &&
        event.parentRunId === undefined
      ) {
        vaultScope.runId = event.runId;
      }
      onEvent(event);
    }
  };
  // The scope is entered around the loop that drives the run's generator,
  // so every next() — and with it the run's own code — runs inside it.
  const run = vaultScope
    ? () => runWithVaultAccess(vaultScope.access, consume)
    : consume;

  const runTraced = async () => {
    if (input.traceparent) {
      const headers: Record<string, string> = {
        traceparent: input.traceparent,
      };
      if (input.tracestate) headers.tracestate = input.tracestate;
      const traceCtx = extractTraceContext(headers);
      await runWithParentTrace(traceCtx, run);
    } else {
      await run();
    }
  };

  await runInRootUnitOfWork(
    repoContext,
    {
      flush: syncService
        ? async () => {
          const namespace = isCustomDatastoreConfig(datastoreConfig)
            ? datastoreConfig.namespace
            : undefined;
          try {
            await withSharedSyncGate(
              options.syncGate,
              () => pushNamespace(syncService, namespace),
            );
          } catch (pushErr) {
            logger.warn(
              "Post-run push failed; terminal status may be delayed: {error}",
              {
                error: pushErr instanceof Error
                  ? pushErr.message
                  : String(pushErr),
              },
            );
          }
        }
        : undefined,
    },
    async () => {
      if (!runTelemetry) {
        await runTraced();
        return;
      }

      // Record the run's own parent entry however it ends. Telemetry must never
      // be able to fail a workflow run, so `finish` is isolated from the run's
      // own error and the original error always propagates.
      try {
        await runTraced();
      } catch (error) {
        await finishRunTelemetry(
          runTelemetry,
          error instanceof Error ? error : new Error(String(error)),
        );
        throw error;
      }

      const failure = finalStatus === "succeeded" ? null : markErrorPaths(
        new Error(
          streamError ?? `workflow run ${finalStatus ?? "did not complete"}`,
        ),
        streamErrorPaths,
      );
      await finishRunTelemetry(runTelemetry, failure);
    },
  ).catch(async (error) => {
    await runCheckpointer.restoreUncommittedRuns(
      () => runTracker,
      error,
    );
    throw withCommittedUnknownSteps(error, runCheckpointer);
  }).finally(() => runCheckpointer.close());
}

async function finishRunTelemetry(
  runTelemetry: RunTelemetry,
  error: Error | null,
): Promise<void> {
  try {
    await runTelemetry.finish(error);
  } catch (telemetryError) {
    logger.warn(
      "Failed to record workflow run telemetry: {error}",
      {
        error: telemetryError instanceof Error
          ? telemetryError.message
          : String(telemetryError),
      },
    );
  }
}

/** serve takes no datastore lock for retention, so a definition a run holds is skipped */
export function serveAutoDefinitionRetentionSources(
  repoContext: RepositoryContext,
  datastoreConfig: DatastoreConfig,
): AutoDefinitionRetentionSources {
  return autoDefinitionRetentionSourcesOf(
    repoContext,
    (type, id) =>
      tryModelLock(
        datastoreConfig,
        type.normalized,
        id,
        AUTO_DEFINITION_RETENTION_LOCK_WAIT_MS,
      ),
  );
}
