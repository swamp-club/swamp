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

import type { Data } from "../../domain/data/data.ts";
import type { Definition } from "../../domain/definitions/definition.ts";
import type { ReportDefinition } from "../../domain/reports/report.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound } from "../errors.ts";
import type { ReportSearchEvent, StoredReportSummary } from "./report_views.ts";

/**
 * Input for the report search operation.
 */
export interface ReportSearchInput {
  query?: string;
  model?: string;
  workflow?: string;
  scope?: string;
  labels?: string[];
}

/**
 * Dependencies for the report search operation.
 */
export interface ReportSearchDeps {
  findAllGlobal: () => Promise<
    Array<{ data: Data; modelType: ModelType; modelId: string }>
  >;
  findAllForModel: (type: ModelType, modelId: string) => Promise<Data[]>;
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
  getReport: (name: string) => ReportDefinition | undefined;
}

/**
 * Checks whether a Data artifact is a markdown report entry
 * (skip the paired JSON artifacts).
 */
function isReportMarkdown(data: Data): boolean {
  return data.tags.type === "report" &&
    data.contentType === "text/markdown";
}

/**
 * Searches stored report data across all models and workflows.
 */
export async function* reportSearch(
  _ctx: LibSwampContext,
  deps: ReportSearchDeps,
  input: ReportSearchInput,
): AsyncGenerator<ReportSearchEvent> {
  yield { kind: "resolving" };

  // --- Collect candidate report data entries ---
  let candidates: Array<{
    data: Data;
    modelType: ModelType;
    modelId: string;
  }>;

  if (input.model) {
    const result = await deps.lookupDefinition(input.model);
    if (!result) {
      yield { kind: "error", error: notFound("Model", input.model) };
      return;
    }
    const items = await deps.findAllForModel(
      result.type,
      result.definition.id,
    );
    candidates = items.map((d) => ({
      data: d,
      modelType: result.type,
      modelId: result.definition.id,
    }));
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
    const items = await deps.findAllForModel(workflowModelType, wf.id);
    candidates = items.map((d) => ({
      data: d,
      modelType: workflowModelType,
      modelId: wf.id,
    }));
  } else {
    candidates = await deps.findAllGlobal();
  }

  // Filter to report markdown entries
  candidates = candidates.filter((c) => isReportMarkdown(c.data));

  // Apply scope filter
  if (input.scope) {
    candidates = candidates.filter(
      (c) => c.data.tags.reportScope === input.scope,
    );
  }

  // Apply label filter — only include reports whose definition has all requested labels
  if (input.labels && input.labels.length > 0) {
    candidates = candidates.filter((c) => {
      const reportName = c.data.tags.reportName;
      if (!reportName) return false;
      const def = deps.getReport(reportName);
      if (!def || !def.labels) return false;
      return input.labels!.every((l) => def.labels!.includes(l));
    });
  }

  // Apply text query filter
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

  // Sort by createdAt descending
  candidates.sort(
    (a, b) => b.data.createdAt.getTime() - a.data.createdAt.getTime(),
  );

  // --- Build summary results ---
  const reports: StoredReportSummary[] = [];

  for (const { data, modelType, modelId } of candidates) {
    const reportName = data.tags.reportName ?? data.name;
    const reportScope = data.tags.reportScope ?? "unknown";

    // Resolve model name
    let modelName = modelId;
    if (modelType.normalized === "workflow") {
      const wf = await deps.findWorkflowById(modelId);
      if (wf) modelName = wf.name;
    } else {
      const def = await deps.lookupDefinitionById(modelType, modelId);
      if (def) modelName = def.name;
    }

    // Resolve workflow name for workflow-scoped reports
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
}
