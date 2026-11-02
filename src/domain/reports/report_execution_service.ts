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

import type { ReportDefinition, ReportScope } from "./report.ts";
import type { ReportContext } from "./report_context.ts";
import type { ReportRef, ReportSelection } from "./report_selection.ts";
import type { ReportRegistry } from "./report_registry.ts";
import type { DataHandle } from "../models/model.ts";
import type { ModelType } from "../models/model_type.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
import { DefaultDataWriter } from "../models/data_writer.ts";
import { modelRegistry } from "../models/model.ts";
import {
  redactAllValues,
  redactSensitiveValues,
} from "../models/sensitive_field_extractor.ts";
import { buildReportErrorResult } from "./builtin/report_error_report.ts";
import { sanitizeReportNameForData } from "./report_data_name.ts";

export { sanitizeReportNameForData };

export interface ReportFilterOptions {
  skipAllReports?: boolean;
  skipReportNames?: string[];
  skipReportLabels?: string[];
  reportNames?: string[];
  reportLabels?: string[];
}

export interface ReportExecutionResult {
  name: string;
  scope: ReportScope;
  success: boolean;
  markdown?: string;
  json?: Record<string, unknown>;
  dataHandles?: DataHandle[];
  error?: string;
}

export interface ReportExecutionSummary {
  results: ReportExecutionResult[];
  failures: number;
}

function getReportRefName(ref: ReportRef): string {
  return typeof ref === "string" ? ref : ref.name;
}

function getReportRefMethods(ref: ReportRef): string[] | undefined {
  return typeof ref === "string" ? undefined : ref.methods;
}

/**
 * a definition or workflow skip always wins, required reports are immune to CLI
 * skip flags; workflow scope (no modelTypeReports) has selection.require as its
 * only candidates
 */
export function filterReports(
  reports: Array<{ name: string; report: ReportDefinition }>,
  scope: ReportScope,
  selection: ReportSelection | undefined,
  filterOptions: ReportFilterOptions,
  methodName?: string,
  modelTypeReports?: string[],
): Array<{ name: string; report: ReportDefinition }> {
  const requiredRefs = selection?.require ?? [];
  const requiredNames = new Set(requiredRefs.map(getReportRefName));

  const candidateNames = new Set<string>(requiredNames);
  if (modelTypeReports) {
    for (const name of modelTypeReports) {
      candidateNames.add(name);
    }
  }

  if (filterOptions.skipAllReports) {
    return reports.filter(({ name, report }) =>
      report.scope === scope && requiredNames.has(name) &&
      candidateNames.has(name)
    );
  }

  const skippedNames = new Set(selection?.skip ?? []);

  const methodScopingMap = new Map<string, string[] | undefined>();
  for (const ref of requiredRefs) {
    methodScopingMap.set(getReportRefName(ref), getReportRefMethods(ref));
  }

  return reports.filter(({ name, report }) => {
    if (report.scope !== scope) return false;

    if (!candidateNames.has(name)) return false;

    if (skippedNames.has(name)) return false;

    if (methodName && methodScopingMap.has(name)) {
      const methods = methodScopingMap.get(name);
      if (methods && !methods.includes(methodName)) return false;
    }

    if (requiredNames.has(name)) return true;

    if (filterOptions.skipReportNames?.includes(name)) return false;

    if (
      filterOptions.skipReportLabels &&
      report.labels?.some((l) => filterOptions.skipReportLabels!.includes(l))
    ) {
      return false;
    }

    if (filterOptions.reportNames && filterOptions.reportNames.length > 0) {
      if (!filterOptions.reportNames.includes(name)) return false;
    }
    if (filterOptions.reportLabels && filterOptions.reportLabels.length > 0) {
      if (
        !report.labels?.some((l) => filterOptions.reportLabels!.includes(l))
      ) {
        return false;
      }
    }

    return true;
  });
}

/**
 * two artifacts per report: report-{reportName} (text/markdown) and
 * report-{reportName}-json (application/json)
 */
async function persistReportData(
  repo: UnifiedDataRepository,
  modelType: ModelType,
  modelId: string,
  reportName: string,
  scope: ReportScope,
  markdown: string,
  json: Record<string, unknown>,
  varySuffix?: string,
  modelName?: string,
): Promise<DataHandle[]> {
  const handles: DataHandle[] = [];
  const tags: Record<string, string> = {
    type: "report",
    reportName,
    reportScope: scope,
    ...(varySuffix ? { varySuffix } : {}),
    ...(modelName ? { modelName } : {}),
  };

  const sanitized = sanitizeReportNameForData(reportName);
  const baseName = varySuffix
    ? `report-${sanitized}-${varySuffix}`
    : `report-${sanitized}`;

  const mdWriter = new DefaultDataWriter(
    repo,
    modelType,
    modelId,
    {
      name: baseName,
      specName: "report",
      kind: "file",
      contentType: "text/markdown",
      lifetime: "30d",
      garbageCollection: 5,
      tags: { ...tags },
    },
  );
  const mdHandle = await mdWriter.writeText(markdown);
  handles.push(mdHandle);

  const jsonWriter = new DefaultDataWriter(
    repo,
    modelType,
    modelId,
    {
      name: `${baseName}-json`,
      specName: "report",
      kind: "file",
      contentType: "application/json",
      lifetime: "30d",
      garbageCollection: 5,
      tags: { ...tags },
    },
  );
  const jsonHandle = await jsonWriter.writeText(JSON.stringify(json, null, 2));
  handles.push(jsonHandle);

  return handles;
}

export interface ReportEventCallback {
  onReportStarted(reportName: string, scope: ReportScope): void;
  onReportCompleted(
    reportName: string,
    scope: ReportScope,
    markdown: string,
    json: Record<string, unknown>,
    dataHandles: DataHandle[],
  ): void;
  onReportFailed(
    reportName: string,
    scope: ReportScope,
    error: string,
    dataHandles?: DataHandle[],
  ): void;
}

function buildRedactSensitiveArgs(
  context: ReportContext,
): (
  args: Record<string, unknown>,
  argsKind: "global" | "method",
) => Record<string, unknown> {
  return (args, argsKind) => {
    if (Object.keys(args).length === 0) return args;
    if (context.scope === "workflow") return args;

    const modelDef = modelRegistry.get(context.modelType);
    if (!modelDef) return redactAllValues(args);

    const schema = argsKind === "global"
      ? modelDef.globalArguments
      : modelDef.methods[context.methodName]?.arguments;
    if (!schema) return redactAllValues(args);

    return redactSensitiveValues(schema, args);
  };
}

export async function executeReports(
  registry: ReportRegistry,
  context: ReportContext,
  modelType: ModelType,
  modelId: string,
  selection: ReportSelection | undefined,
  filterOptions: ReportFilterOptions,
  events?: ReportEventCallback,
  methodName?: string,
  modelTypeReports?: string[],
  varySuffix?: string,
  emitUnresolvableRequireFailures = true,
): Promise<ReportExecutionSummary> {
  const modelName = context.scope === "workflow"
    ? context.workflowName
    : context.definition.name;

  // promote lazy-registered reports for every candidate name before getAll(),
  // which excludes lazy entries; otherwise user extension reports from the
  // bundle catalog would be silently filtered out
  // #1089.
  // promoted unconditionally, scope-mismatched ones included, since scope is
  // unknown until import; wasted imports are bounded and once per process; load
  // errors propagate so a broken required bundle fails loudly
  const candidateNames = new Set<string>();
  for (const ref of selection?.require ?? []) {
    candidateNames.add(getReportRefName(ref));
  }
  if (modelTypeReports) {
    for (const name of modelTypeReports) {
      candidateNames.add(name);
    }
  }
  await Promise.all(
    Array.from(candidateNames, (name) => registry.ensureTypeLoaded(name)),
  );

  const results: ReportExecutionResult[] = [];
  let failures = 0;

  // a required report still absent after promotion fails loudly and counts in
  // failures, since require is a contract; skipped names are exempt; callers
  // emit this on exactly one call per selection
  if (emitUnresolvableRequireFailures) {
    const skipNames = new Set(selection?.skip ?? []);
    const seen = new Set<string>();
    for (const ref of selection?.require ?? []) {
      const name = getReportRefName(ref);
      if (seen.has(name) || skipNames.has(name)) continue;
      seen.add(name);
      if (registry.get(name)) continue;

      const errorMessage = `Required report not found: ${name}. ` +
        `No loaded or indexed report matches this name — check the ` +
        `reports.require entry, pull the extension that provides it, or ` +
        `run 'swamp doctor extensions --repair'.`;
      context.logger.warn(
        "Required report not found: {report} — check the reports.require " +
          "entry, pull the extension that provides it, or run " +
          "'swamp doctor extensions --repair'",
        { report: name },
      );

      events?.onReportStarted(name, context.scope);

      // Persist an error artifact so `swamp report search` surfaces the
      // failure instead of returning nothing for the report.
      let errorDataHandles: DataHandle[] | undefined;
      try {
        const fallback = buildReportErrorResult(
          name,
          context.scope,
          errorMessage,
        );
        errorDataHandles = await persistReportData(
          context.dataRepository,
          modelType,
          modelId,
          name,
          context.scope,
          fallback.markdown,
          fallback.json,
          varySuffix,
          modelName,
        );
      } catch {
        // Best-effort — the failure event carries the message regardless.
      }

      events?.onReportFailed(
        name,
        context.scope,
        errorMessage,
        errorDataHandles,
      );

      results.push({
        name,
        scope: context.scope,
        success: false,
        error: errorMessage,
        dataHandles: errorDataHandles,
      });
      failures++;
    }
  }

  const allReports = registry.getAll();
  const applicable = filterReports(
    allReports,
    context.scope,
    selection,
    filterOptions,
    methodName,
    modelTypeReports,
  );

  if (applicable.length === 0) {
    return { results, failures };
  }

  if (context.scope !== "workflow") {
    await modelRegistry.ensureTypeLoaded(context.modelType);
  }
  context.redactSensitiveArgs = buildRedactSensitiveArgs(context);

  for (const { name, report } of applicable) {
    events?.onReportStarted(name, report.scope);

    try {
      const result = await report.execute(context);

      // Empty markdown means the report is not applicable to this method.
      // Skip persistence so the previous real version stays latest, but still
      // announce completion so renderers can show it in verbose mode.
      if (result.markdown.trim() === "") {
        events?.onReportCompleted(
          name,
          report.scope,
          result.markdown,
          result.json,
          [],
        );
        results.push({
          name,
          scope: report.scope,
          success: true,
          markdown: result.markdown,
          json: result.json,
          dataHandles: [],
        });
        continue;
      }

      const dataHandles = await persistReportData(
        context.dataRepository,
        modelType,
        modelId,
        name,
        report.scope,
        result.markdown,
        result.json,
        varySuffix,
        modelName,
      );

      events?.onReportCompleted(
        name,
        report.scope,
        result.markdown,
        result.json,
        dataHandles,
      );

      results.push({
        name,
        scope: report.scope,
        success: true,
        markdown: result.markdown,
        json: result.json,
        dataHandles,
      });
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      let errorDataHandles: DataHandle[] | undefined;
      try {
        const fallback = buildReportErrorResult(
          name,
          report.scope,
          errorMessage,
          errorStack,
        );
        errorDataHandles = await persistReportData(
          context.dataRepository,
          modelType,
          modelId,
          name,
          report.scope,
          fallback.markdown,
          fallback.json,
          varySuffix,
          modelName,
        );
      } catch {
        // Best-effort — don't mask the original report error.
      }

      events?.onReportFailed(
        name,
        report.scope,
        errorMessage,
        errorDataHandles,
      );

      results.push({
        name,
        scope: report.scope,
        success: false,
        error: errorMessage,
        dataHandles: errorDataHandles,
      });
      failures++;
    }
  }

  return { results, failures };
}
