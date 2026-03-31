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
import type { ModelMethodRunDeps, WorkflowRunDeps } from "../libswamp/mod.ts";
import { WorkflowExecutionService } from "../domain/workflows/execution_service.ts";
import { createWorkflowId } from "../domain/workflows/workflow_id.ts";
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

export function createWorkflowRunDeps(
  repoDir: string,
  repoContext: RepositoryContext,
): WorkflowRunDeps {
  return {
    workflowRepo: repoContext.workflowRepo,
    runRepo: repoContext.workflowRunRepo,
    repoDir,
    lookupWorkflow: async (repo, idOrName) => {
      return await repo.findByName(idOrName) ??
        await repo.findById(createWorkflowId(idOrName));
    },
    createExecutionService: (wfRepo, rnRepo, dir) =>
      new WorkflowExecutionService(wfRepo, rnRepo, dir),
    dataRepo: repoContext.unifiedDataRepo,
    definitionRepo: repoContext.definitionRepo,
  };
}

export function createModelMethodRunDeps(
  repoDir: string,
  repoContext: RepositoryContext,
): ModelMethodRunDeps {
  return {
    repoDir,
    lookupDefinition: (idOrName) =>
      findDefinitionByIdOrName(repoContext.definitionRepo, idOrName),
    getModelDef: (type) => resolveModelType(type, getAutoResolver()),
    createEvaluationService: () =>
      new ExpressionEvaluationService(
        repoContext.definitionRepo,
        repoDir,
        {
          dataRepo: repoContext.unifiedDataRepo,
          dataQueryService: repoContext.catalogStore
            ? new DataQueryService(
              repoContext.catalogStore,
              repoContext.unifiedDataRepo,
            )
            : undefined,
        },
      ),
    loadEvaluatedDefinition: (type, name) =>
      repoContext.evaluatedDefinitionRepo.findByName(type, name),
    saveEvaluatedDefinition: (type, definition) =>
      repoContext.evaluatedDefinitionRepo.save(type, definition),
    createExecutionService: () => new DefaultMethodExecutionService(),
    createVaultService: () => VaultService.fromRepository(repoDir),
    dataRepo: repoContext.unifiedDataRepo,
    definitionRepo: repoContext.definitionRepo,
    outputRepo: repoContext.outputRepo,
    queryData: repoContext.catalogStore
      ? ((dqs) => (predicate: string, select?: string) =>
        dqs.query(predicate, { select }))(
          new DataQueryService(
            repoContext.catalogStore,
            repoContext.unifiedDataRepo,
          ),
        )
      : undefined,
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
