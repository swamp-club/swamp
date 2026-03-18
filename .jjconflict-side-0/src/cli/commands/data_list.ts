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

import { Command } from "@cliffy/command";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { WorkflowDataService } from "../../domain/data/workflow_data_service.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import {
  consumeStream,
  createLibSwampContext,
  dataList,
} from "../../libswamp/mod.ts";
import { createDataListRenderer } from "../../presentation/renderers/data_list.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const dataListCommand = new Command()
  .name("list")
  .description("List all data for a model or workflow, grouped by type")
  .arguments("[model_id_or_name:model_name]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option(
    "--type <type:string>",
    "Filter by data type (log, file, resource, data)",
  )
  .option(
    "--workflow <name:string>",
    "List data produced by a workflow",
  )
  .option(
    "--run <run_id:string>",
    "Specific workflow run ID (defaults to latest)",
  )
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, modelIdOrName?: string) {
    const cliCtx = createContext(options as GlobalOptions, ["data", "list"]);

    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: options.repoDir ?? ".",
      outputMode: cliCtx.outputMode,
    });
    const definitionRepo = repoContext.definitionRepo;
    const dataRepo = repoContext.unifiedDataRepo;
    const workflowRepo = repoContext.workflowRepo;
    const runRepo = repoContext.workflowRunRepo;

    const workflowDataService = new WorkflowDataService(
      definitionRepo,
      dataRepo,
    );

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = {
      lookupDefinition: (idOrName: string) =>
        findDefinitionByIdOrName(definitionRepo, idOrName),
      findAllForModel: (
        type: ModelType,
        definitionId: string,
      ) => dataRepo.findAllForModel(type, definitionId),
      findWorkflow: async (nameOrId: string) => {
        const wf = await workflowRepo.findByName(nameOrId) ??
          await workflowRepo.findById(createWorkflowId(nameOrId));
        return wf ? { id: wf.id, name: wf.name } : null;
      },
      findWorkflowRun: async (workflowId: string, runId: string) => {
        const run = await runRepo.findById(
          createWorkflowId(workflowId),
          runId as ReturnType<typeof runRepo.nextId>,
        );
        return run ? { id: run.id, status: run.status } : null;
      },
      findLatestRun: async (workflowId: string) => {
        const run = await runRepo.findLatestByWorkflowId(
          createWorkflowId(workflowId),
        );
        return run ? { id: run.id, status: run.status } : null;
      },
      findAllForWorkflowRun: async (workflowId: string, runId: string) => {
        const fullRun = await runRepo.findById(
          createWorkflowId(workflowId),
          runId as ReturnType<typeof runRepo.nextId>,
        );
        if (!fullRun) return [];
        return workflowDataService.findAllForWorkflowRun(fullRun);
      },
    };

    const renderer = createDataListRenderer(cliCtx.outputMode);
    await consumeStream(
      dataList(ctx, deps, {
        modelIdOrName,
        workflowName: options.workflow as string | undefined,
        runId: options.run as string | undefined,
        typeFilter: options.type as string | undefined,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Data list command completed");
  });
