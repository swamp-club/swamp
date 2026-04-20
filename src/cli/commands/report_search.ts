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
  resolveRepoDir,
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
  type StoredReportDetail,
  type StoredReportSummary,
} from "../../libswamp/mod.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import { createReportSearchRenderer } from "../../presentation/renderers/report_search.tsx";
import { createReportGetRenderer } from "../../presentation/renderers/report_get.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

async function buildSearchDeps(
  repoContext: RepositoryContext,
): Promise<ReportSearchDeps> {
  await reportRegistry.ensureLoaded();
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
    getReport: async (name) => {
      await reportRegistry.ensureTypeLoaded(name);
      return reportRegistry.get(name);
    },
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
 * Creates a fetchPreview closure that fetches full report detail data.
 * This bridges the presentation layer to the libswamp reportGet application
 * service, capturing the repository context dependency.
 */
function createReportFetchPreview(
  repoContext: RepositoryContext,
): (item: StoredReportSummary) => Promise<StoredReportDetail> {
  const libCtx = createLibSwampContext();
  const getDeps = buildGetDeps(repoContext);

  return async (item: StoredReportSummary): Promise<StoredReportDetail> => {
    let result: StoredReportDetail | undefined;
    await consumeStream(
      reportGet(libCtx, getDeps, {
        reportName: item.reportName,
        model: item.workflowName ? undefined : item.modelName,
        workflow: item.workflowName,
        variant: item.varySuffix,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data;
        },
        error: () => {},
      },
    );
    if (!result) {
      throw new Error(`Report not found: ${item.reportName}`);
    }
    return result;
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
  .example("Browse all reports", "swamp report search")
  .example("Search by keyword", "swamp report search cost")
  .arguments("[query:string]")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
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
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: effectiveMode,
    });

    const libCtx = createLibSwampContext({ logger: ctx.logger });

    const fetchPreview = effectiveMode === "log"
      ? createReportFetchPreview(repoContext)
      : undefined;

    const searchRenderer = createReportSearchRenderer(
      effectiveMode,
      query ?? "",
      fetchPreview,
    );
    await consumeStream(
      reportSearch(libCtx, await buildSearchDeps(repoContext), {
        query,
        model: options.model as string | undefined,
        workflow: options.workflow as string | undefined,
        scope: options.scope as string | undefined,
        labels: options.label as string[] | undefined,
      }),
      searchRenderer.handlers(),
    );

    const selected = searchRenderer.selectedItem();
    if (selected) {
      ctx.logger.debug`Selected report: ${selected.reportName}`;
      // In JSON mode, still display the full report detail after auto-select
      if (effectiveMode === "json") {
        await displayReportDetail(
          selected,
          repoContext,
          libCtx,
          effectiveMode,
        );
      }
      // In interactive mode, the scrollback from the picker already contains
      // the report detail, so no additional displayReportDetail call is needed.
    } else {
      ctx.logger.debug`Search cancelled`;
    }

    ctx.logger.debug("Report search command completed");
  });
