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
  type DataGroupedByType,
  type DataListData,
  type DataListItem,
  renderDataList,
  type WorkflowDataListData,
  type WorkflowDataListItem,
} from "../../presentation/output/data_list_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { UserError } from "../../domain/errors.ts";
import { WorkflowDataService } from "../../domain/data/workflow_data_service.ts";
import { createWorkflowId } from "../../domain/workflows/workflow_id.ts";

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
    const ctx = createContext(options as GlobalOptions, ["data", "list"]);

    const workflowName = options.workflow as string | undefined;

    // Validate: exactly one of model or --workflow
    if (modelIdOrName && workflowName) {
      throw new UserError(
        "Cannot specify both a model and --workflow. Use one or the other.",
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
      // Workflow-scoped data list
      ctx.logger.debug`Listing data for workflow: ${workflowName}`;
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
      const workflowData = await workflowDataService.findAllForWorkflowRun(run);

      // Filter by type if specified
      const typeFilter = options.type as string | undefined;
      const filteredData = typeFilter
        ? workflowData.filter((d) => d.data.type === typeFilter)
        : workflowData;

      // Group by type tag
      const groupedByType = new Map<string, WorkflowDataListItem[]>();

      for (const item of filteredData) {
        const typeTag = item.data.type;
        if (!groupedByType.has(typeTag)) {
          groupedByType.set(typeTag, []);
        }
        groupedByType.get(typeTag)!.push({
          id: item.data.id,
          name: item.data.name,
          version: item.data.version,
          contentType: item.data.contentType,
          type: typeTag,
          streaming: item.data.streaming,
          size: item.data.size,
          createdAt: item.data.createdAt.toISOString(),
          modelId: item.modelId,
          modelName: item.modelName,
          modelType: item.modelType.normalized,
          jobName: item.jobName,
          stepName: item.stepName,
        });
      }

      // Sort groups by type name
      const standardTypes = ["log", "file", "resource", "data"];
      const groups: Array<{ type: string; items: WorkflowDataListItem[] }> = [];

      for (const type of standardTypes) {
        const items = groupedByType.get(type);
        if (items) {
          groups.push({
            type,
            items: items.sort((a, b) => a.name.localeCompare(b.name)),
          });
          groupedByType.delete(type);
        }
      }

      const customTypes = Array.from(groupedByType.keys()).sort();
      for (const type of customTypes) {
        const items = groupedByType.get(type)!;
        groups.push({
          type,
          items: items.sort((a, b) => a.name.localeCompare(b.name)),
        });
      }

      const output: WorkflowDataListData = {
        workflowId: workflow.id,
        workflowName: workflow.name,
        runId: run.id,
        runStatus: run.status,
        groups,
        total: filteredData.length,
      };

      renderDataList(output, ctx.outputMode);
    } else {
      // Model-scoped data list (original behavior)
      ctx.logger.debug`Listing data for model: ${modelIdOrName!}`;

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

      // Get all data for the model
      const allData = await dataRepo.findAllForModel(modelType, definition.id);

      // Filter by type if specified
      const typeFilter = options.type as string | undefined;
      const filteredData = typeFilter
        ? allData.filter((d) => d.type === typeFilter)
        : allData;

      // Group by type tag
      const groupedByType = new Map<string, DataListItem[]>();

      for (const data of filteredData) {
        const typeTag = data.type;
        if (!groupedByType.has(typeTag)) {
          groupedByType.set(typeTag, []);
        }
        groupedByType.get(typeTag)!.push({
          id: data.id,
          name: data.name,
          version: data.version,
          contentType: data.contentType,
          type: typeTag,
          streaming: data.streaming,
          size: data.size,
          createdAt: data.createdAt.toISOString(),
        });
      }

      // Sort groups by type name, with standard types first
      const standardTypes = ["log", "file", "resource", "data"];
      const groups: DataGroupedByType[] = [];

      // Add standard types first (in order)
      for (const type of standardTypes) {
        const items = groupedByType.get(type);
        if (items) {
          groups.push({
            type,
            items: items.sort((a, b) => a.name.localeCompare(b.name)),
          });
          groupedByType.delete(type);
        }
      }

      // Add remaining custom types
      const customTypes = Array.from(groupedByType.keys()).sort();
      for (const type of customTypes) {
        const items = groupedByType.get(type)!;
        groups.push({
          type,
          items: items.sort((a, b) => a.name.localeCompare(b.name)),
        });
      }

      const output: DataListData = {
        modelId: definition.id,
        modelName: definition.name,
        modelType: modelType.normalized,
        groups,
        total: filteredData.length,
      };

      renderDataList(output, ctx.outputMode);
    }

    ctx.logger.debug("Data list command completed");
  });
