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
 * Factories that construct WorkflowRunDeps and ModelMethodRunDeps from a
 * RepositoryContext. These mirror the patterns in the CLI commands but are
 * decoupled from Cliffy options parsing.
 */

import { join } from "@std/path";
import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import type {
  ModelMethodRunDeps,
  WorkflowRunDeps,
  WorkflowRunEvent,
  WorkflowRunInput,
} from "../libswamp/mod.ts";
import { createLibSwampContext, workflowRun } from "../libswamp/mod.ts";
import {
  type DirectTypeResolver,
  type StepLockHook,
  WorkflowExecutionService,
} from "../domain/workflows/execution_service.ts";
import { createWorkflowId } from "../domain/workflows/workflow_id.ts";
import { TriggerInputResolver } from "../domain/workflows/trigger_input_resolver.ts";
import { buildEnvContext } from "../domain/expressions/model_resolver.ts";
import { CelEvaluator } from "../infrastructure/cel/cel_evaluator.ts";
import { ModelType } from "../domain/models/model_type.ts";
import { resolveOrCreateDefinition } from "../libswamp/mod.ts";
import { YamlDefinitionRepository } from "../infrastructure/persistence/yaml_definition_repository.ts";
import type { DefinitionId } from "../domain/definitions/definition.ts";
import { findDefinitionByIdOrName } from "../domain/models/model_lookup.ts";
import { resolveModelType } from "../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../domain/extensions/auto_resolver_context.ts";
import { DefaultMethodExecutionService } from "../domain/models/method_execution_service.ts";
import { VaultService } from "../domain/vaults/vault_service.ts";
import { ExpressionEvaluationService } from "../domain/expressions/expression_evaluation_service.ts";
import { DataQueryService } from "../domain/data/data_query_service.ts";
import { runFileSink } from "../infrastructure/logging/logger.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../infrastructure/persistence/paths.ts";
import { SecretRedactor } from "../domain/secrets/mod.ts";
import { modelRegistry } from "../domain/models/model.ts";
import { vaultTypeRegistry } from "../domain/vaults/vault_type_registry.ts";
import { reportRegistry } from "../domain/reports/report_registry.ts";
import type { DatastoreConfig } from "../domain/datastore/datastore_config.ts";
import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import { acquireModelLocks } from "../cli/repo_context.ts";

export async function createWorkflowRunDeps(
  repoDir: string,
  repoContext: RepositoryContext,
  stepLockHook?: StepLockHook,
): Promise<WorkflowRunDeps> {
  await Promise.all([
    modelRegistry.ensureLoaded(),
    vaultTypeRegistry.ensureLoaded(),
    reportRegistry.ensureLoaded(),
  ]);
  return {
    workflowRepo: repoContext.workflowRepo,
    runRepo: repoContext.workflowRunRepo,
    repoDir,
    lookupWorkflow: async (repo, idOrName) => {
      return await repo.findByName(idOrName) ??
        await repo.findById(createWorkflowId(idOrName));
    },
    createExecutionService: (wfRepo, rnRepo, dir, catalogStore) => {
      // Direct type execution (auto-create-then-run steps) must work over
      // serve exactly as it does locally — serve is the only way to run
      // workflows with worker placement. Mirrors the CLI's resolver in
      // workflow_run.ts.
      const directResolver: DirectTypeResolver = async (
        typeArg,
        defName,
        methodName,
        inputs,
        globalArgs,
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
          throw new Error(`Unknown model type: ${resolvedType.normalized}`);
        }
        const autoDefRepo = new YamlDefinitionRepository(
          dir,
          undefined,
          swampPath(dir, SWAMP_SUBDIRS.autoDefinitions),
          false,
        );
        const result = await resolveOrCreateDefinition(
          {
            lookupDefinition: (name) =>
              findDefinitionByIdOrName(repoContext.definitionRepo, name),
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
        );
        if (!result.ok) throw new Error(result.error.message);
        return {
          definition: result.definition,
          modelType: result.modelType,
          created: result.created,
          routedMethodInputs: result.routedInputs.methodArguments,
        };
      };
      return new WorkflowExecutionService(
        wfRepo,
        rnRepo,
        dir,
        undefined,
        undefined,
        catalogStore,
        directResolver,
        repoContext.markDirty,
        repoContext.unifiedDataRepo.namespace,
        stepLockHook,
      );
    },
    catalogStore: repoContext.catalogStore,
    dataRepo: repoContext.unifiedDataRepo,
    definitionRepo: repoContext.definitionRepo,
  };
}

export async function createModelMethodRunDeps(
  repoDir: string,
  repoContext: RepositoryContext,
  options?: { directExecution?: boolean },
): Promise<ModelMethodRunDeps> {
  await Promise.all([
    modelRegistry.ensureLoaded(),
    vaultTypeRegistry.ensureLoaded(),
    reportRegistry.ensureLoaded(),
  ]);

  const isDirectExecution = options?.directExecution ?? false;

  return {
    repoDir,
    lookupDefinition: (idOrName) =>
      findDefinitionByIdOrName(repoContext.definitionRepo, idOrName),
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
      repoContext.evaluatedDefinitionRepo.findByName(type, name),
    saveEvaluatedDefinition: (type, definition) =>
      repoContext.evaluatedDefinitionRepo.save(type, definition),
    createExecutionService: () => new DefaultMethodExecutionService(),
    createVaultService: () => VaultService.fromRepository(repoDir),
    dataRepo: repoContext.unifiedDataRepo,
    definitionRepo: repoContext.definitionRepo,
    outputRepo: repoContext.outputRepo,
    dataQueryService: new DataQueryService(
      repoContext.catalogStore,
      repoContext.unifiedDataRepo,
    ),
    createRunLog: async (modelType, method, definitionId) => {
      const redactor = new SecretRedactor();
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
      );
      return {
        logFilePath,
        redactor,
        cleanup: () => runFileSink.unregister(logHandle),
      };
    },
    createAndSaveDefinition: isDirectExecution
      ? async (type, definition) => {
        const autoDefRepo = new YamlDefinitionRepository(
          repoDir,
          undefined,
          swampPath(repoDir, SWAMP_SUBDIRS.autoDefinitions),
          false,
        );
        await autoDefRepo.save(type, definition);
      }
      : undefined,
    getDefinitionPath: isDirectExecution
      ? (type, id) => {
        return join(
          swampPath(repoDir, SWAMP_SUBDIRS.autoDefinitions),
          type.toDirectoryPath(),
          `${id}.yaml`,
        );
      }
      : undefined,
  };
}

/**
 * Executes a workflow run with per-step model lock acquisition — the single
 * code path for both WebSocket-triggered and scheduled workflow execution.
 *
 * Handles: pre-lookup → stepLockHook creation → workflowRun.
 * Locks are acquired and released per-step by the execution service rather
 * than held for the entire workflow duration.
 * The caller provides a callback to consume the event stream.
 */
export async function executeWorkflowWithLocks(
  repoDir: string,
  repoContext: RepositoryContext,
  datastoreConfig: DatastoreConfig,
  input: WorkflowRunInput,
  signal: AbortSignal,
  onEvent: (event: WorkflowRunEvent) => void,
  /**
   * Sync service shared with the repo context's markDirty hook so the
   * fast-path watermark read here sees the writes the hook flipped. See
   * `design/datastores.md` for the contract; omit only for filesystem
   * datastores where no service exists.
   */
  syncService?: DatastoreSyncService,
): Promise<void> {
  // Pre-lookup workflow for trigger.inputs resolution
  const workflowRepo = repoContext.workflowRepo;
  const workflow = await workflowRepo.findByName(
    input.workflowIdOrName,
  ) ?? await workflowRepo.findById(
    createWorkflowId(input.workflowIdOrName),
  );

  const stepLockHook: StepLockHook = async (modelType, modelId) => {
    const result = await acquireModelLocks(
      datastoreConfig,
      [{ modelType, modelId }],
      repoDir,
      syncService,
      repoContext.catalogStore,
    );
    if (result.synced) repoContext.catalogStore.invalidate();
    return result;
  };

  const deps = await createWorkflowRunDeps(repoDir, repoContext, stepLockHook);
  const libCtx = createLibSwampContext({ signal });

  // Layer the workflow's trigger.inputs under any caller-supplied inputs so
  // scheduled and webhook trigger-fired runs get baseline values at fire
  // time. Downstream workflowRun applies schema defaults and validates,
  // yielding precedence: caller inputs > trigger.inputs > schema defaults.
  //
  // For webhook runs, trigger.inputs may reference the request payload via the
  // `webhook` CEL namespace (e.g. "${{ webhook.body.data.issue.identifier }}").
  // Resolve those against the payload here — before workflowRun's coercion and
  // validation — so a required input mapped from the payload satisfies the
  // schema.
  let resolvedTriggerInputs: Record<string, unknown> | undefined;
  if (workflow && input.webhook && workflow.triggerInputs) {
    const resolver = new TriggerInputResolver(new CelEvaluator());
    resolvedTriggerInputs = await resolver.resolve(workflow.triggerInputs, {
      model: {},
      env: buildEnvContext(),
      webhook: input.webhook,
    });
  }

  const effectiveInput = workflow
    ? {
      ...input,
      inputs: workflow.baselineInputs(
        input.inputs ?? {},
        resolvedTriggerInputs,
      ),
    }
    : input;

  for await (const event of workflowRun(libCtx, deps, effectiveInput)) {
    onEvent(event);
  }
}
