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
import { consumeStream } from "../../libswamp/mod.ts";
import { dataGet } from "../../libswamp/data/get.ts";
import type { DataGetDeps } from "../../libswamp/data/get.ts";
import { createDataGetRenderer } from "../../presentation/renderers/data_get.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { WorkflowDataService } from "../../domain/data/workflow_data_service.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";
import { toRelativePath } from "../../infrastructure/persistence/paths.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const dataGetCommand = new Command()
  .name("get")
  .description("Get data by model and name, or by workflow")
  .arguments("[model_id_or_name:model_name] [data_name:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--version <version:number>", "Specific version (defaults to latest)")
  .option(
    "--workflow <name:string>",
    "Get data produced by a workflow",
  )
  .option(
    "--run <run_id:string>",
    "Specific workflow run ID (defaults to latest)",
  )
  .option(
    "--no-content",
    "Show metadata only, without content",
  )
  .action(
    // @ts-expect-error - Cliffy custom type returns unknown instead of string
    async function (
      options: AnyOptions,
      modelIdOrName?: string,
      dataName?: string,
    ) {
      const cliCtx = createContext(options as GlobalOptions, ["data", "get"]);

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

      const deps: DataGetDeps = {
        lookupDefinition: (idOrName) =>
          findDefinitionByIdOrName(definitionRepo, idOrName),
        findWorkflow: async (idOrName) =>
          await workflowRepo.findByName(idOrName) ??
            await workflowRepo.findById(createWorkflowId(idOrName)),
        findWorkflowRun: async (workflowId, runId) => {
          const wfId = createWorkflowId(workflowId);
          if (runId) {
            return await runRepo.findById(
              wfId,
              runId as ReturnType<typeof runRepo.nextId>,
            );
          }
          return await runRepo.findLatestByWorkflowId(wfId);
        },
        findDataByName: (modelType, modelId, name, version) =>
          dataRepo.findByName(modelType, modelId, name, version),
        findDataInWorkflowRun: async (run, dataNameArg, version) => {
          // We need the full workflow run for the service
          // The run passed in is a minimal shape, but we stored the real one
          // Look up the actual run from all workflows
          const allWorkflows = await workflowRepo.findAll();
          for (const wf of allWorkflows) {
            const fullRun = await runRepo.findById(
              wf.id,
              run.id as ReturnType<typeof runRepo.nextId>,
            );
            if (fullRun) {
              return await workflowDataService.findByNameInWorkflowRun(
                fullRun,
                dataNameArg,
                version,
              );
            }
          }
          return null;
        },
        getContent: (modelType, modelId, name, version) =>
          dataRepo.getContent(modelType, modelId, name, version),
        getContentPath: (modelType, modelId, name, version) =>
          dataRepo.getContentPath(modelType, modelId, name, version),
        toRelativePath,
      };

      const renderer = createDataGetRenderer(cliCtx.outputMode);
      await consumeStream(
        dataGet(deps, {
          modelIdOrName,
          dataName,
          workflowName: options.workflow as string | undefined,
          runId: options.run as string | undefined,
          version: options.version as number | undefined,
          includeContent: options.content !== false,
          repoDir: options.repoDir ?? ".",
        }),
        renderer.handlers(),
      );

      cliCtx.logger.debug("Data get command completed");
    },
  );
