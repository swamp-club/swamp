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
import { UserError } from "../../domain/errors.ts";
import type { WidthOptions } from "../../presentation/markdown_renderer.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const MIN_MAX_WIDTH = 20;
const MIN_MAX_COL_WIDTH = 5;

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
  .example(
    "Output as markdown",
    "swamp report get cost-summary --model my-server --markdown > report.md",
  )
  .example(
    "Cap total table width",
    "swamp report get cost-summary --max-width 120",
  )
  .example(
    "Cap individual column width",
    "swamp report get cost-summary --max-col-width 60",
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
  .option(
    "--markdown",
    "Output as plain markdown instead of terminal-formatted",
    {
      conflicts: ["json"],
    },
  )
  .option(
    "--max-width <width:number>",
    "Cap total output width in columns (env: SWAMP_REPORT_MAX_WIDTH)",
  )
  .option(
    "--max-col-width <width:number>",
    "Cap individual table column width in characters (env: SWAMP_REPORT_MAX_COL_WIDTH)",
  )
  .action(async function (options: AnyOptions, reportName: string) {
    const ctx = createContext(options as GlobalOptions, ["report", "get"]);

    const widthOptions = resolveWidthOptions(options);

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
    const reportMode = options.markdown ? "markdown" as const : ctx.outputMode;
    const renderer = createReportGetRenderer(reportMode, widthOptions);

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

function resolveWidthOptions(
  options: AnyOptions,
): WidthOptions | undefined {
  const maxWidthRaw = options.maxWidth as number | undefined ??
    parseEnvInt("SWAMP_REPORT_MAX_WIDTH");
  const maxColWidthRaw = options.maxColWidth as number | undefined ??
    parseEnvInt("SWAMP_REPORT_MAX_COL_WIDTH");

  if (maxWidthRaw !== undefined && maxWidthRaw < MIN_MAX_WIDTH) {
    throw new UserError(
      `--max-width must be at least ${MIN_MAX_WIDTH}, got ${maxWidthRaw}`,
    );
  }
  if (maxColWidthRaw !== undefined && maxColWidthRaw < MIN_MAX_COL_WIDTH) {
    throw new UserError(
      `--max-col-width must be at least ${MIN_MAX_COL_WIDTH}, got ${maxColWidthRaw}`,
    );
  }

  if (maxWidthRaw === undefined && maxColWidthRaw === undefined) {
    return undefined;
  }

  return {
    maxWidth: maxWidthRaw,
    maxColWidth: maxColWidthRaw,
  };
}

function parseEnvInt(name: string): number | undefined {
  const raw = Deno.env.get(name);
  if (raw === undefined) return undefined;
  const n = parseInt(raw, 10);
  if (isNaN(n)) return undefined;
  return n;
}
