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
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { createDefinitionId } from "../../domain/definitions/definition.ts";
import {
  consumeStream,
  createLibSwampContext,
  reportGet,
  type ReportGetDeps,
} from "../../libswamp/mod.ts";
import { createReportGetRenderer } from "../../presentation/renderers/report_get.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const reportGetCommand = new Command()
  .name("get")
  .description("Show a stored report's content")
  .example("Get a report", "swamp report get cost-summary")
  .example(
    "Scoped to a model",
    "swamp report get cost-summary --model my-server",
  )
  .example(
    "Scoped to a workflow",
    "swamp report get cost-summary --workflow deploy-pipeline",
  )
  .arguments("<report_name:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--model <name:string>", "Scope to a specific model")
  .option("--workflow <name:string>", "Scope to a specific workflow")
  .option(
    "--version <version:number>",
    "Get specific version (default: latest)",
  )
  .option("--variant <variant:string>", "Select a specific forEach variant")
  .action(async function (options: AnyOptions, reportName: string) {
    const ctx = createContext(options as GlobalOptions, ["report", "get"]);

    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: ctx.outputMode,
    });

    const deps: ReportGetDeps = {
      findAllGlobal: () => repoContext.unifiedDataRepo.findAllGlobal(),
      findAllForModel: (type, modelId) =>
        repoContext.unifiedDataRepo.findAllForModel(type, modelId),
      getContent: (type, modelId, dataName, version) =>
        repoContext.unifiedDataRepo.getContent(
          type,
          modelId,
          dataName,
          version,
        ),
      lookupDefinition: (idOrName) =>
        findDefinitionByIdOrName(repoContext.definitionRepo, idOrName),
      lookupDefinitionById: (type, id) =>
        repoContext.definitionRepo.findById(type, createDefinitionId(id)),
      findWorkflowByName: async (name) => {
        const wf = await repoContext.workflowRepo.findByName(name);
        if (!wf) return null;
        return { id: wf.id, name: wf.name };
      },
      findWorkflowById: async (id) => {
        const all = await repoContext.workflowRepo.findAll();
        const wf = all.find((w) => w.id === id);
        if (!wf) return null;
        return { id: wf.id, name: wf.name };
      },
    };

    const libCtx = createLibSwampContext({ logger: ctx.logger });
    const renderer = createReportGetRenderer(ctx.outputMode);

    await consumeStream(
      reportGet(libCtx, deps, {
        reportName,
        model: options.model as string | undefined,
        workflow: options.workflow as string | undefined,
        version: options.version as number | undefined,
        variant: options.variant as string | undefined,
      }),
      renderer.handlers(),
    );

    ctx.logger.debug("Report get command completed");
  });
