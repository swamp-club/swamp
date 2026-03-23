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
  interactiveOutputMode,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import { createDefinitionId } from "../../domain/definitions/definition.ts";
import {
  consumeStream,
  createLibSwampContext,
  type LibSwampContext,
  reportGet,
  type ReportGetDeps,
  reportSearch,
  type ReportSearchDeps,
  result,
  type StoredReportSummary,
  type SwampError,
} from "../../libswamp/mod.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import {
  renderReportSearch,
  type ReportSearchData,
} from "../../presentation/output/report_search_output.tsx";
import { createReportGetRenderer } from "../../presentation/renderers/report_get.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

function buildSearchDeps(repoContext: RepositoryContext): ReportSearchDeps {
  return {
    findAllGlobal: () => repoContext.unifiedDataRepo.findAllGlobal(),
    findAllForModel: (type, modelId) =>
      repoContext.unifiedDataRepo.findAllForModel(type, modelId),
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
    getReport: (name) => reportRegistry.get(name),
  };
}

function buildGetDeps(repoContext: RepositoryContext): ReportGetDeps {
  return {
    findAllGlobal: () => repoContext.unifiedDataRepo.findAllGlobal(),
    findAllForModel: (type, modelId) =>
      repoContext.unifiedDataRepo.findAllForModel(type, modelId),
    getContent: (type, modelId, dataName, version) =>
      repoContext.unifiedDataRepo.getContent(type, modelId, dataName, version),
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
}

/**
 * Fetches and displays full report content for a selected summary.
 */
async function displayReportDetail(
  summary: StoredReportSummary,
  repoContext: RepositoryContext,
  libCtx: LibSwampContext,
  outputMode: OutputMode,
): Promise<void> {
  const getDeps = buildGetDeps(repoContext);
  const renderer = createReportGetRenderer(outputMode);
  await consumeStream(
    reportGet(libCtx, getDeps, {
      reportName: summary.reportName,
      model: summary.workflowName ? undefined : summary.modelName,
      workflow: summary.workflowName,
      variant: summary.varySuffix,
    }),
    renderer.handlers(),
  );
}

export const reportSearchCommand = new Command()
  .name("search")
  .description("Search stored report results across all models and workflows")
  .arguments("[query:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--model <name:string>", "Filter to a specific model")
  .option("--workflow <name:string>", "Filter to a specific workflow")
  .option(
    "--scope <scope:string>",
    "Filter by report scope (method, model, workflow)",
  )
  .option(
    "--label <label:string>",
    "Filter by report label (repeatable)",
    { collect: true },
  )
  .action(async function (options: AnyOptions, query?: string) {
    const ctx = createContext(options as GlobalOptions, [
      "report",
      "search",
    ]);
    const effectiveMode = interactiveOutputMode(ctx);

    const { repoContext } = await requireInitializedRepoReadOnly({
      repoDir: options.repoDir ?? ".",
      outputMode: effectiveMode,
    });

    const libCtx = createLibSwampContext({ logger: ctx.logger });

    // Consume the search generator to get summaries
    let searchResult;
    try {
      searchResult = await result(
        reportSearch(libCtx, buildSearchDeps(repoContext), {
          query,
          model: options.model as string | undefined,
          workflow: options.workflow as string | undefined,
          scope: options.scope as string | undefined,
          labels: options.label as string[] | undefined,
        }),
      );
    } catch (err) {
      const swampErr = err as SwampError;
      throw new UserError(swampErr.message ?? String(err));
    }

    const summaries = searchResult.data.reports;

    // For JSON mode with exactly one match, show full detail directly
    if (effectiveMode === "json" && query && summaries.length === 1) {
      await displayReportDetail(
        summaries[0],
        repoContext,
        libCtx,
        effectiveMode,
      );
      return;
    }

    const data: ReportSearchData = {
      query: query ?? "",
      results: summaries,
    };

    const selected = await renderReportSearch(data, effectiveMode);

    if (selected) {
      ctx.logger.debug`Selected report: ${selected.reportName}`;
      await displayReportDetail(selected, repoContext, libCtx, effectiveMode);
    } else {
      ctx.logger.debug`Search cancelled`;
    }

    ctx.logger.debug("Report search command completed");
  });
