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
import type { Definition } from "../../domain/definitions/definition.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import type { FindStoredReports } from "../../domain/reports/stored_report_data.ts";
import type { LibSwampContext } from "../context.ts";
import { behaviorNotFound, notFound, validationFailed } from "../errors.ts";
import type { ReportGetEvent, StoredReportDetail } from "./report_views.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
export interface ReportGetInput {
  reportName: string;
  model?: string;
  workflow?: string;
  version?: number;
  variant?: string;
  /**
   * Keeps only the reports whose owner this accepts, before variants or
   * ambiguity are considered, so neither the result nor an ambiguity error
   * names an owner the caller may not read. `modelName` is the owner's name
   * as recorded on the report.
   */
  include?: (
    owner: { modelType: string; modelId: string; modelName: string },
  ) => Promise<boolean>;
}

export interface ReportGetDeps {
  findReportData: FindStoredReports;
  findDataByVersion: (
    type: ModelType,
    modelId: string,
    dataName: string,
    version: number,
  ) => Promise<Data | null>;
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

function isMatchingReport(data: Data, reportName: string): boolean {
  return data.tags.type === "report" &&
    data.contentType === "text/markdown" &&
    data.tags.reportName === reportName;
}

export async function* reportGet(
  _ctx: LibSwampContext,
  deps: ReportGetDeps,
  input: ReportGetInput,
): AsyncGenerator<ReportGetEvent> {
  yield* withGeneratorSpan(
    "swamp.report.get",
    {},
    (async function* () {
      yield { kind: "resolving" };

      let matches: Array<{
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
        const items = await deps.findReportData({
          type: result.type,
          modelId: result.definition.id,
        });
        matches = items.filter((c) =>
          isMatchingReport(c.data, input.reportName)
        );
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
        const items = await deps.findReportData({
          type: workflowModelType,
          modelId: wf.id,
        });
        matches = items.filter((c) =>
          isMatchingReport(c.data, input.reportName)
        );
      } else {
        const all = await deps.findReportData();
        matches = all.filter((c) => isMatchingReport(c.data, input.reportName));
      }

      if (input.include) {
        const accepted: typeof matches = [];
        for (const m of matches) {
          if (
            await input.include({
              modelType: m.modelType.normalized,
              modelId: m.modelId,
              modelName: m.data.tags.modelName ?? m.modelId,
            })
          ) accepted.push(m);
        }
        matches = accepted;
      }

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
              `Report "${input.reportName}" exists in multiple locations: ${locationList}. Use --behavior or --workflow to disambiguate.`,
            ),
          };
          return;
        }
      }

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

      // Candidates hold only the latest version of each data item, so pick
      // the newest candidate, then load the requested version for it.
      matches.sort(
        (a, b) => b.data.createdAt.getTime() - a.data.createdAt.getTime(),
      );
      let match = matches[0];
      if (input.version) {
        const versioned = await deps.findDataByVersion(
          match.modelType,
          match.modelId,
          match.data.name,
          input.version,
        );
        if (!versioned || !isMatchingReport(versioned, input.reportName)) {
          yield {
            kind: "error",
            error: notFound(
              "Report",
              `"${input.reportName}" version ${input.version}`,
            ),
          };
          return;
        }
        match = { ...match, data: versioned };
      }

      const { data, modelType, modelId } = match;
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

      const rawMd = await deps.getContent(
        modelType,
        modelId,
        data.name,
        data.version,
      );
      const markdown = rawMd ? new TextDecoder().decode(rawMd) : "";

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
    })(),
  );
}
