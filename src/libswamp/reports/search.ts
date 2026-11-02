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

import type { Data } from "../../domain/data/data.ts";
import {
  createDefinitionId,
  type Definition,
} from "../../domain/definitions/definition.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import type { ReportDefinition } from "../../domain/reports/report.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import type { FindStoredReports } from "../../domain/reports/stored_report_data.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { YamlWorkflowRepository } from "../../infrastructure/persistence/yaml_workflow_repository.ts";
import { SWAMP_SUBDIRS } from "../../infrastructure/persistence/paths.ts";
import { findLatestReportData } from "../../infrastructure/persistence/catalog_report_adapter.ts";
import { DataQueryService } from "../../domain/data/data_query_service.ts";
import {
  createCatalogStore,
  namespaceFromResolver,
} from "../../infrastructure/persistence/repository_factory.ts";
import type { LibSwampContext } from "../context.ts";
import { behaviorNotFound, notFound } from "../errors.ts";
import type { ReportSearchEvent, StoredReportSummary } from "./report_views.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
export interface ReportSearchInput {
  query?: string;
  model?: string;
  workflow?: string;
  scope?: string;
  type?: string;
  labels?: string[];
}

export interface ReportSearchDeps {
  findReportData: FindStoredReports;
  lookupDefinition: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  lookupDefinitionById: (
    type: ModelType,
    id: string,
  ) => Promise<Definition | null>;
  findWorkflowByName: (
    name: string,
  ) => Promise<{ id: string; name: string } | null>;
  findWorkflowById: (
    id: string,
  ) => Promise<{ id: string; name: string } | null>;
  getReport: (name: string) => Promise<ReportDefinition | undefined>;
}

export async function createReportSearchDeps(
  repoDir: string,
  datastoreResolver?: DatastorePathResolver,
): Promise<ReportSearchDeps> {
  await reportRegistry.ensureLoaded();
  const dsPath = (subdir: string): string | undefined =>
    datastoreResolver?.resolvePath(subdir);
  const definitionRepo = new YamlDefinitionRepository(repoDir);
  const catalogStore = createCatalogStore(repoDir, datastoreResolver);
  const dataRepo = new FileSystemUnifiedDataRepository(
    repoDir,
    dsPath(SWAMP_SUBDIRS.data),
    catalogStore,
    undefined,
    undefined,
    namespaceFromResolver(datastoreResolver),
  );
  const dataQueryService = new DataQueryService(catalogStore, dataRepo);
  const workflowRepo = new YamlWorkflowRepository(repoDir);
  return {
    findReportData: (owner) =>
      findLatestReportData(dataQueryService, catalogStore, dataRepo, {
        owner,
      }),
    lookupDefinition: (idOrName) =>
      findDefinitionByIdOrName(definitionRepo, idOrName),
    lookupDefinitionById: (type, id) =>
      definitionRepo.findById(type, createDefinitionId(id)),
    findWorkflowByName: async (name) => {
      const wf = await workflowRepo.findByName(name);
      if (!wf) return null;
      return { id: wf.id, name: wf.name };
    },
    findWorkflowById: async (id) => {
      const all = await workflowRepo.findAll();
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

function isReportMarkdown(data: Data): boolean {
  return data.tags.type === "report" &&
    data.contentType === "text/markdown";
}

export async function* reportSearch(
  _ctx: LibSwampContext,
  deps: ReportSearchDeps,
  input: ReportSearchInput,
): AsyncGenerator<ReportSearchEvent> {
  yield* withGeneratorSpan(
    "swamp.report.search",
    {},
    (async function* () {
      yield { kind: "resolving" };

      let candidates: Array<{
        data: Data;
        modelType: ModelType;
        modelId: string;
      }>;

      if (input.model) {
        const result = await deps.lookupDefinition(input.model);
        if (!result) {
          yield { kind: "error", error: behaviorNotFound(input.model) };
          return;
        }
        candidates = await deps.findReportData({
          type: result.type,
          modelId: result.definition.id,
        });
      } else if (input.workflow) {
        const wf = await deps.findWorkflowByName(input.workflow);
        if (!wf) {
          yield { kind: "error", error: notFound("Workflow", input.workflow) };
          return;
        }
        const { ModelType: MT } = await import(
          "../../domain/models/model_type.ts"
        );
        const workflowModelType = MT.create("workflow");
        candidates = await deps.findReportData({
          type: workflowModelType,
          modelId: wf.id,
        });
      } else {
        candidates = await deps.findReportData();
      }

      candidates = candidates.filter((c) => isReportMarkdown(c.data));

      if (input.scope) {
        candidates = candidates.filter(
          (c) => c.data.tags.reportScope === input.scope,
        );
      }

      // exact match on the reportName tag, with no fallback to data.name, so
      // entries missing the tag are excluded; runs before the label filter to
      // shrink the candidate set ahead of its per-candidate definition lookups
      if (input.type) {
        candidates = candidates.filter(
          (c) => c.data.tags.reportName === input.type,
        );
      }

      if (input.labels && input.labels.length > 0) {
        const filtered: typeof candidates = [];
        for (const c of candidates) {
          const reportName = c.data.tags.reportName;
          if (!reportName) continue;
          const def = await deps.getReport(reportName);
          if (!def || !def.labels) continue;
          if (input.labels!.every((l) => def.labels!.includes(l))) {
            filtered.push(c);
          }
        }
        candidates = filtered;
      }

      if (input.query) {
        const q = input.query.toLowerCase();
        candidates = candidates.filter((c) => {
          const reportName = c.data.tags.reportName ?? "";
          const varySuffix = c.data.tags.varySuffix ?? "";
          return reportName.toLowerCase().includes(q) ||
            c.data.name.toLowerCase().includes(q) ||
            varySuffix.toLowerCase().includes(q);
        });
      }

      candidates.sort(
        (a, b) => b.data.createdAt.getTime() - a.data.createdAt.getTime(),
      );

      const reports: StoredReportSummary[] = [];

      for (const { data, modelType, modelId } of candidates) {
        const reportName = data.tags.reportName ?? data.name;
        const reportScope = data.tags.reportScope ?? "unknown";

        let modelName = modelId;
        if (modelType.normalized === "workflow") {
          const wf = await deps.findWorkflowById(modelId);
          if (wf) modelName = wf.name;
        } else {
          const def = await deps.lookupDefinitionById(modelType, modelId);
          if (def) modelName = def.name;
        }

        let workflowName: string | undefined;
        if (modelType.normalized === "workflow") {
          const wf = await deps.findWorkflowById(modelId);
          if (wf) workflowName = wf.name;
        }

        reports.push({
          reportName,
          reportScope,
          modelId,
          modelName,
          modelType: modelType.normalized,
          version: data.version,
          createdAt: data.createdAt.toISOString(),
          workflowName,
          dataName: data.name,
          varySuffix: data.tags.varySuffix || undefined,
        });
      }

      yield { kind: "completed", data: { reports } };
    })(),
  );
}
