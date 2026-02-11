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
import {
  type DataGetData,
  renderDataGet,
} from "../../presentation/output/data_get_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { UserError } from "../../domain/errors.ts";
import { WorkflowDataService } from "../../domain/data/workflow_data_service.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";

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
      const ctx = createContext(options as GlobalOptions, ["data", "get"]);

      const workflowName = options.workflow as string | undefined;

      // When using --workflow, positional args shift:
      // `swamp data get --workflow <wf> <data_name>` → modelIdOrName holds the data name
      if (workflowName && modelIdOrName && dataName) {
        throw new UserError(
          "Too many arguments. Usage: swamp data get --workflow <name> <data_name>",
        );
      }
      if (!modelIdOrName && !workflowName) {
        throw new UserError(
          "Either a model name or --workflow is required.",
        );
      }

      const { repoContext } = await requireInitializedRepo({
        repoDir: options.repoDir ?? ".",
        outputMode: ctx.outputMode,
      });
      const definitionRepo = repoContext.definitionRepo;
      const dataRepo = repoContext.unifiedDataRepo;

      if (workflowName) {
        // Workflow-scoped data get
        if (!dataName && !modelIdOrName) {
          throw new UserError(
            "A data name is required when using --workflow. Usage: swamp data get --workflow <name> <data_name>",
          );
        }
        // When using --workflow, the first positional arg is the data name
        const actualDataName = modelIdOrName ?? dataName;
        if (!actualDataName) {
          throw new UserError(
            "A data name is required when using --workflow.",
          );
        }

        ctx.logger
          .debug`Getting workflow data: workflow=${workflowName}, name=${actualDataName}`;
        const workflowRepo = repoContext.workflowRepo;
        const runRepo = repoContext.workflowRunRepo;

        const workflow = await workflowRepo.findByName(workflowName) ??
          await workflowRepo.findById(createWorkflowId(workflowName));

        if (!workflow) {
          throw new UserError(`Workflow not found: ${workflowName}`);
        }

        const runId = options.run as string | undefined;
        const run = runId
          ? await runRepo.findById(
            workflow.id,
            runId as ReturnType<typeof runRepo.nextId>,
          )
          : await runRepo.findLatestByWorkflowId(workflow.id);

        if (!run) {
          throw new UserError(
            runId
              ? `Run "${runId}" not found for workflow: ${workflow.name}`
              : `No runs found for workflow: ${workflow.name}`,
          );
        }

        const workflowDataService = new WorkflowDataService(
          definitionRepo,
          dataRepo,
        );
        const version = options.version as number | undefined;
        const item = await workflowDataService.findByNameInWorkflowRun(
          run,
          actualDataName,
          version,
        );

        if (!item) {
          const versionInfo = version ? ` (version ${version})` : "";
          throw new UserError(
            `Data "${actualDataName}" not found in workflow "${workflow.name}"${versionInfo}`,
          );
        }

        const output: DataGetData = {
          id: item.data.id,
          name: item.data.name,
          modelId: item.modelId,
          modelName: item.modelName,
          modelType: item.modelType.normalized,
          version: item.data.version,
          contentType: item.data.contentType,
          lifetime: item.data.lifetime,
          garbageCollection: item.data.garbageCollection,
          streaming: item.data.streaming,
          tags: item.data.tags,
          ownerDefinition: item.data.ownerDefinition,
          createdAt: item.data.createdAt.toISOString(),
          size: item.data.size,
          checksum: item.data.checksum,
          contentPath: item.contentPath,
        };

        if (options.content !== false) {
          const rawContent = await dataRepo.getContent(
            item.modelType,
            item.modelId,
            item.data.name,
            item.data.version,
          );
          if (rawContent) {
            output.content = new TextDecoder().decode(rawContent);
          }
        }

        renderDataGet(output, ctx.outputMode);
      } else {
        // Model-scoped data get (original behavior)
        if (!dataName) {
          throw new UserError(
            "A data name is required. Usage: swamp data get <model> <data_name>",
          );
        }

        ctx.logger
          .debug`Getting data: model=${modelIdOrName!}, name=${dataName}`;

        // Look up the model definition
        ctx.logger.debug`Looking up model: ${modelIdOrName!}`;
        const result = await findDefinitionByIdOrName(
          definitionRepo,
          modelIdOrName!,
        );
        if (!result) {
          throw new UserError(`Model not found: ${modelIdOrName!}`);
        }
        const { definition, type: modelType } = result;

        ctx.logger
          .debug`Found model: id=${definition.id}, type=${modelType.normalized}`;

        // Get the data
        const version = options.version as number | undefined;
        const data = await dataRepo.findByName(
          modelType,
          definition.id,
          dataName,
          version,
        );

        if (!data) {
          const versionInfo = version ? ` (version ${version})` : "";
          throw new UserError(
            `Data "${dataName}" not found for model "${modelIdOrName!}"${versionInfo}`,
          );
        }

        const contentPath = dataRepo.getContentPath(
          modelType,
          definition.id,
          dataName,
          data.version,
        );

        const output: DataGetData = {
          id: data.id,
          name: data.name,
          modelId: definition.id,
          modelName: definition.name,
          modelType: modelType.normalized,
          version: data.version,
          contentType: data.contentType,
          lifetime: data.lifetime,
          garbageCollection: data.garbageCollection,
          streaming: data.streaming,
          tags: data.tags,
          ownerDefinition: data.ownerDefinition,
          createdAt: data.createdAt.toISOString(),
          size: data.size,
          checksum: data.checksum,
          contentPath,
        };

        if (options.content !== false) {
          const rawContent = await dataRepo.getContent(
            modelType,
            definition.id,
            dataName,
            data.version,
          );
          if (rawContent) {
            output.content = new TextDecoder().decode(rawContent);
          }
        }

        renderDataGet(output, ctx.outputMode);
      }

      ctx.logger.debug("Data get command completed");
    },
  );
