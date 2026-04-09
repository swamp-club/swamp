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
import { WorkflowExecutionService } from "../domain/workflows/execution_service.ts";
import { createWorkflowId } from "../domain/workflows/workflow_id.ts";
import { findDefinitionByIdOrName } from "../domain/models/model_lookup.ts";
import { extractModelReferencesFromWorkflow } from "../domain/workflows/model_reference_extractor.ts";
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
import { driverTypeRegistry } from "../domain/drivers/driver_type_registry.ts";
import { reportRegistry } from "../domain/reports/report_registry.ts";
import type { DatastoreConfig } from "../domain/datastore/datastore_config.ts";
import { acquireModelLocks } from "../cli/repo_context.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

export async function createWorkflowRunDeps(
  repoDir: string,
  repoContext: RepositoryContext,
): Promise<WorkflowRunDeps> {
  await Promise.all([
    modelRegistry.ensureLoaded(),
    vaultTypeRegistry.ensureLoaded(),
    driverTypeRegistry.ensureLoaded(),
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
    createExecutionService: (wfRepo, rnRepo, dir, catalogStore) =>
      new WorkflowExecutionService(
        wfRepo,
        rnRepo,
        dir,
        undefined,
        undefined,
        catalogStore,
      ),
    catalogStore: repoContext.catalogStore,
    dataRepo: repoContext.unifiedDataRepo,
    definitionRepo: repoContext.definitionRepo,
  };
}

export async function createModelMethodRunDeps(
  repoDir: string,
  repoContext: RepositoryContext,
): Promise<ModelMethodRunDeps> {
  await Promise.all([
    modelRegistry.ensureLoaded(),
    vaultTypeRegistry.ensureLoaded(),
    driverTypeRegistry.ensureLoaded(),
    reportRegistry.ensureLoaded(),
  ]);
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
    queryData:
      ((dqs) => (predicate: string, select?: string) =>
        dqs.query(predicate, { select }))(
          new DataQueryService(
            repoContext.catalogStore,
            repoContext.unifiedDataRepo,
          ),
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
      const logCategory: string[] = [];
      await runFileSink.register(
        logCategory,
        logFilePath,
        redactor,
        swampPath(repoDir),
      );
      return {
        logFilePath,
        redactor,
        cleanup: () => runFileSink.unregister(logCategory),
      };
    },
  };
}

const depsLogger = getSwampLogger(["serve", "deps"]);

/**
 * Executes a workflow run with model lock acquisition — the single code path
 * for both WebSocket-triggered and scheduled workflow execution.
 *
 * Handles: pre-lookup → lock acquisition → workflowRun → lock release.
 * The caller provides a callback to consume the event stream.
 */
export async function executeWorkflowWithLocks(
  repoDir: string,
  repoContext: RepositoryContext,
  datastoreConfig: DatastoreConfig,
  input: WorkflowRunInput,
  signal: AbortSignal,
  onEvent: (event: WorkflowRunEvent) => void,
): Promise<void> {
  let flushLocks: (() => Promise<void>) | null = null;

  try {
    // Pre-lookup workflow for per-model lock acquisition
    const workflowRepo = repoContext.workflowRepo;
    const workflow = await workflowRepo.findByName(
      input.workflowIdOrName,
    ) ?? await workflowRepo.findById(
      createWorkflowId(input.workflowIdOrName),
    );

    if (workflow) {
      const modelRefs = await extractModelReferencesFromWorkflow(
        workflow,
        workflowRepo,
      );
      if (modelRefs !== null && modelRefs.length > 0) {
        const resolvedModels: Array<{ modelType: string; modelId: string }> =
          [];
        for (const ref of modelRefs) {
          const result = await findDefinitionByIdOrName(
            repoContext.definitionRepo,
            ref,
          );
          if (result) {
            resolvedModels.push({
              modelType: result.type.normalized,
              modelId: result.definition.id,
            });
          }
        }
        if (resolvedModels.length > 0) {
          const lockResult = await acquireModelLocks(
            datastoreConfig,
            resolvedModels,
            repoDir,
          );
          if (lockResult.synced) repoContext.catalogStore.invalidate();
          flushLocks = lockResult.flush;
        }
      }
    }

    const deps = await createWorkflowRunDeps(repoDir, repoContext);
    const libCtx = createLibSwampContext({ signal });

    for await (const event of workflowRun(libCtx, deps, input)) {
      onEvent(event);
    }
  } finally {
    if (flushLocks) {
      try {
        await flushLocks();
      } catch (releaseError) {
        depsLogger.warn("Failed to release locks: {error}", {
          error: releaseError instanceof Error
            ? releaseError.message
            : String(releaseError),
        });
      }
    }
  }
}
