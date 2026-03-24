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

import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import {
  type AuthDeps,
  createDataListDeps,
  createLibSwampContext,
  dataList,
  dataSearch,
  type DataSearchDeps,
  modelSearch,
  type ModelSearchDeps,
  whoami,
  workflowRun,
  type WorkflowRunDeps,
  workflowSearch,
  type WorkflowSearchDeps,
} from "../libswamp/mod.ts";
import { WorkflowExecutionService } from "../domain/workflows/execution_service.ts";
import { createWorkflowId } from "../domain/workflows/workflow_id.ts";
import { findDefinitionByIdOrName } from "../domain/models/model_lookup.ts";
import { createDefinitionId } from "../domain/definitions/definition.ts";
import { ModelType } from "../domain/models/model_type.ts";
import type {
  CommandResponse,
  ParsedCommand,
  ProgressUpdate,
} from "./types.ts";
import {
  formatDataList,
  formatDataSearch,
  formatModelSearch,
  formatWhoami,
  formatWorkflowRun,
  formatWorkflowSearch,
} from "./response_formatter.ts";

type ProgressCallback = (update: ProgressUpdate) => void;

/** Dependencies injected into the command router at startup. */
export interface CommandRouterDeps {
  readonly repoDir: string;
  readonly repoContext: RepositoryContext;
  readonly authDeps: AuthDeps;
}

/**
 * Route a parsed command to the appropriate libswamp operation,
 * consume its event stream, and return a formatted chat response.
 */
export async function routeCommand(
  deps: CommandRouterDeps,
  command: ParsedCommand,
  onProgress?: ProgressCallback,
): Promise<CommandResponse> {
  const key = `${command.domain}.${command.verb}`;
  const ctx = createLibSwampContext();

  try {
    switch (key) {
      case "workflow.run":
        return await routeWorkflowRun(deps, command, ctx, onProgress);
      case "workflow.search":
        return await routeWorkflowSearch(deps, command, ctx);
      case "model.search":
        return await routeModelSearch(deps, command, ctx);
      case "data.list":
        return await routeDataList(deps, command, ctx);
      case "data.search":
        return await routeDataSearch(deps, command, ctx);
      case "auth.whoami":
        return await routeWhoami(deps, ctx);
      default:
        return {
          text:
            `Unknown command: ${key}. Try: workflow run, workflow search, model search, data list, data search, status`,
          success: false,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: `Command failed: ${message}`, success: false };
  }
}

async function routeWorkflowRun(
  deps: CommandRouterDeps,
  command: ParsedCommand,
  ctx: ReturnType<typeof createLibSwampContext>,
  onProgress?: ProgressCallback,
): Promise<CommandResponse> {
  if (!command.target) {
    return {
      text: "Usage: workflow run <workflow-name> [--input key=value]",
      success: false,
    };
  }

  const inputs: Record<string, string> = {};
  const inputValue = command.options.get("input");
  if (inputValue) {
    const eqIndex = inputValue.indexOf("=");
    if (eqIndex !== -1) {
      inputs[inputValue.slice(0, eqIndex)] = inputValue.slice(eqIndex + 1);
    }
  }

  const runDeps: WorkflowRunDeps = {
    workflowRepo: deps.repoContext.workflowRepo,
    runRepo: deps.repoContext.workflowRunRepo,
    repoDir: deps.repoDir,
    lookupWorkflow: async (repo, idOrName) => {
      return await repo.findByName(idOrName) ??
        await repo.findById(createWorkflowId(idOrName));
    },
    createExecutionService: (wfRepo, rnRepo, dir) =>
      new WorkflowExecutionService(wfRepo, rnRepo, dir),
    dataRepo: deps.repoContext.unifiedDataRepo,
    definitionRepo: deps.repoContext.definitionRepo,
  };

  return await formatWorkflowRun(
    workflowRun(ctx, runDeps, {
      workflowIdOrName: command.target,
      inputs: Object.keys(inputs).length > 0 ? inputs : undefined,
    }),
    onProgress,
  );
}

async function routeWorkflowSearch(
  deps: CommandRouterDeps,
  command: ParsedCommand,
  ctx: ReturnType<typeof createLibSwampContext>,
): Promise<CommandResponse> {
  const searchDeps: WorkflowSearchDeps = {
    findAllWorkflows: () => deps.repoContext.workflowRepo.findAll(),
  };
  return await formatWorkflowSearch(
    workflowSearch(ctx, searchDeps, { query: command.target || undefined }),
  );
}

async function routeModelSearch(
  deps: CommandRouterDeps,
  command: ParsedCommand,
  ctx: ReturnType<typeof createLibSwampContext>,
): Promise<CommandResponse> {
  const searchDeps: ModelSearchDeps = {
    findAllGlobal: () => deps.repoContext.definitionRepo.findAllGlobal(),
  };
  return await formatModelSearch(
    modelSearch(ctx, searchDeps, { query: command.target || undefined }),
  );
}

async function routeDataList(
  deps: CommandRouterDeps,
  command: ParsedCommand,
  ctx: ReturnType<typeof createLibSwampContext>,
): Promise<CommandResponse> {
  const listDeps = createDataListDeps(deps.repoDir);
  return await formatDataList(
    dataList(ctx, listDeps, {
      modelIdOrName: command.target || undefined,
    }),
  );
}

async function routeDataSearch(
  deps: CommandRouterDeps,
  command: ParsedCommand,
  ctx: ReturnType<typeof createLibSwampContext>,
): Promise<CommandResponse> {
  const definitionRepo = deps.repoContext.definitionRepo;
  const searchDeps: DataSearchDeps = {
    findAllGlobal: () => deps.repoContext.unifiedDataRepo.findAllGlobal(),
    findDefinitionById: (type, defId) =>
      definitionRepo.findById(
        ModelType.create(type.normalized),
        createDefinitionId(defId),
      ),
    findDefinitionByIdOrName: (idOrName) =>
      findDefinitionByIdOrName(definitionRepo, idOrName),
  };
  return await formatDataSearch(
    dataSearch(ctx, searchDeps, { query: command.target || undefined }),
  );
}

async function routeWhoami(
  deps: CommandRouterDeps,
  ctx: ReturnType<typeof createLibSwampContext>,
): Promise<CommandResponse> {
  return await formatWhoami(whoami(ctx, deps.authDeps));
}
