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
import type { ModelType } from "../../domain/models/model_type.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound, validationFailed } from "../errors.ts";
import type { ReportGetEvent, StoredReportDetail } from "./report_views.ts";

/**
 * Input for the report get operation.
 */
export interface ReportGetInput {
  reportName: string;
  model?: string;
  workflow?: string;
  version?: number;
  variant?: string;
}

/**
 * Dependencies for the report get operation.
 */
export interface ReportGetDeps {
  findAllGlobal: () => Promise<
    Array<{ data: Data; modelType: ModelType; modelId: string }>
  >;
  findAllForModel: (type: ModelType, modelId: string) => Promise<Data[]>;
  getContent: (
    type: ModelType,
    modelId: string,
    dataName: string,
    version?: number,
  ) => Promise<Uint8Array | null>;
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
}

/**
 * Checks whether a Data artifact is a markdown report with matching name.
 */
function isMatchingReport(data: Data, reportName: string): boolean {
  return data.tags.type === "report" &&
    data.contentType === "text/markdown" &&
    data.tags.reportName === reportName;
}

/**
 * Fetches a specific stored report's content.
 */
export async function* reportGet(
  _ctx: LibSwampContext,
  deps: ReportGetDeps,
  input: ReportGetInput,
): AsyncGenerator<ReportGetEvent> {
  yield { kind: "resolving" };

  // --- Find matching report data entries ---
  let matches: Array<{
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
    matches = items
      .filter((d) => isMatchingReport(d, input.reportName))
      .map((d) => ({
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
    matches = items
      .filter((d) => isMatchingReport(d, input.reportName))
      .map((d) => ({
        data: d,
        modelType: workflowModelType,
        modelId: wf.id,
      }));
  } else {
    // Global search
    const all = await deps.findAllGlobal();
    matches = all.filter((c) => isMatchingReport(c.data, input.reportName));
  }

  // Filter by variant when specified
  if (input.variant) {
    matches = matches.filter(
      (m) => m.data.tags.varySuffix === input.variant,
    );
  }

  if (matches.length === 0) {
    yield {
      kind: "error",
      error: notFound("Report", input.reportName),
    };
    return;
  }

  // Ambiguity check: multiple models/workflows have this report
  if (matches.length > 1 && !input.model && !input.workflow) {
    const locations = new Set<string>();
    for (const m of matches) {
      if (m.modelType.normalized === "workflow") {
        const wf = await deps.findWorkflowById(m.modelId);
        locations.add(`workflow:${wf?.name ?? m.modelId}`);
      } else {
        const def = await deps.lookupDefinitionById(m.modelType, m.modelId);
        locations.add(`model:${def?.name ?? m.modelId}`);
      }
    }
    if (locations.size > 1) {
      const locationList = [...locations].join(", ");
      yield {
        kind: "error",
        error: validationFailed(
          `Report "${input.reportName}" exists in multiple locations: ${locationList}. Use --model or --workflow to disambiguate.`,
        ),
      };
      return;
    }
  }

  // Ambiguity check: multiple variants on the same model
  if (matches.length > 1 && !input.variant) {
    const variants = new Set(
      matches.map((m) => m.data.tags.varySuffix).filter(Boolean),
    );
    if (variants.size > 1) {
      const variantList = [...variants].join(", ");
      yield {
        kind: "error",
        error: validationFailed(
          `Report "${input.reportName}" has multiple variants: ${variantList}. Use --variant to select one.`,
        ),
      };
      return;
    }
  }

  // Pick the best match (latest version or specific version)
  let match = matches[0];
  if (input.version) {
    const versionMatch = matches.find(
      (m) => m.data.version === input.version,
    );
    if (!versionMatch) {
      yield {
        kind: "error",
        error: notFound(
          "Report",
          `"${input.reportName}" version ${input.version}`,
        ),
      };
      return;
    }
    match = versionMatch;
  } else {
    // Pick latest by createdAt
    matches.sort(
      (a, b) => b.data.createdAt.getTime() - a.data.createdAt.getTime(),
    );
    match = matches[0];
  }

  const { data, modelType, modelId } = match;
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

  // Resolve workflow name
  let workflowName: string | undefined;
  if (modelType.normalized === "workflow") {
    const wf = await deps.findWorkflowById(modelId);
    if (wf) workflowName = wf.name;
  }

  // Fetch markdown content
  const rawMd = await deps.getContent(
    modelType,
    modelId,
    data.name,
    data.version,
  );
  const markdown = rawMd ? new TextDecoder().decode(rawMd) : "";

  // Fetch paired JSON content
  const jsonDataName = `${data.name}-json`;
  const rawJson = await deps.getContent(
    modelType,
    modelId,
    jsonDataName,
    data.version,
  );
  let json: Record<string, unknown> = {};
  if (rawJson) {
    try {
      json = JSON.parse(new TextDecoder().decode(rawJson));
    } catch {
      // Leave as empty if JSON parse fails
    }
  }

  const detail: StoredReportDetail = {
    reportName: input.reportName,
    reportScope,
    modelId,
    modelName,
    modelType: modelType.normalized,
    version: data.version,
    createdAt: data.createdAt.toISOString(),
    workflowName,
    varySuffix: data.tags.varySuffix || undefined,
    dataName: data.name,
    markdown,
    json,
  };

  yield { kind: "completed", data: detail };
}
