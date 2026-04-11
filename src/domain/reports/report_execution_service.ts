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

import type { ReportDefinition, ReportScope } from "./report.ts";
import type { ReportContext } from "./report_context.ts";
import type { ReportRef, ReportSelection } from "./report_selection.ts";
import type { ReportRegistry } from "./report_registry.ts";
import type { DataHandle } from "../models/model.ts";
import type { ModelType } from "../models/model_type.ts";
import type { UnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import { DefaultDataWriter } from "../models/data_writer.ts";
import { modelRegistry } from "../models/model.ts";
import {
  extractSensitiveFields,
  getNestedValue,
  setNestedValue,
} from "../models/sensitive_field_extractor.ts";

/**
 * Options for filtering which reports to execute.
 */
export interface ReportFilterOptions {
  /** Skip all reports. */
  skipAllReports?: boolean;
  /** Skip specific reports by name. */
  skipReportNames?: string[];
  /** Skip reports matching these labels. */
  skipReportLabels?: string[];
  /** Only run these specific reports (inclusion filter). */
  reportNames?: string[];
  /** Only run reports matching these labels (inclusion filter). */
  reportLabels?: string[];
}

/**
 * Result of a single report execution.
 */
export interface ReportExecutionResult {
  name: string;
  scope: ReportScope;
  success: boolean;
  markdown?: string;
  json?: Record<string, unknown>;
  dataHandles?: DataHandle[];
  error?: string;
}

/**
 * Result of executing all applicable reports.
 */
export interface ReportExecutionSummary {
  results: ReportExecutionResult[];
  failures: number;
}

/**
 * Gets the name from a ReportRef.
 */
function getReportRefName(ref: ReportRef): string {
  return typeof ref === "string" ? ref : ref.name;
}

/**
 * Gets the method scoping from a ReportRef (undefined = all methods).
 */
function getReportRefMethods(ref: ReportRef): string[] | undefined {
  return typeof ref === "string" ? undefined : ref.methods;
}

/**
 * Filters reports based on selection rules and CLI flags.
 *
 * Filtering logic:
 * 1. Build candidate set from model-type defaults + selection.require
 * 2. Definition/workflow-level skip always wins
 * 3. Respect YAML method scoping
 * 4. Required reports immune to CLI skip flags
 * 5. Honor CLI: --skip-reports, --skip-report, --skip-report-label
 * 6. Inclusion filters: --report, --report-label
 *
 * When `modelTypeReports` is provided (method/model scope), the candidate set
 * is reports whose name appears in modelTypeReports OR in selection.require.
 * When `modelTypeReports` is undefined (workflow scope), the candidate set
 * is reports in selection.require only.
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

  // Build the candidate set: model-type defaults + require
  // When modelTypeReports is provided (method/model scope), candidates are
  // reports in modelTypeReports OR in selection.require.
  // When modelTypeReports is undefined (workflow scope), candidates are
  // reports in selection.require only.
  const candidateNames = new Set<string>(requiredNames);
  if (modelTypeReports) {
    for (const name of modelTypeReports) {
      candidateNames.add(name);
    }
  }

  if (filterOptions.skipAllReports) {
    // Still allow required reports through
    return reports.filter(({ name, report }) =>
      report.scope === scope && requiredNames.has(name) &&
      candidateNames.has(name)
    );
  }

  const skippedNames = new Set(selection?.skip ?? []);

  // Build method scoping map from required refs
  const methodScopingMap = new Map<string, string[] | undefined>();
  for (const ref of requiredRefs) {
    methodScopingMap.set(getReportRefName(ref), getReportRefMethods(ref));
  }

  return reports.filter(({ name, report }) => {
    // Only include reports matching the requested scope
    if (report.scope !== scope) return false;

    // Only include candidates (model-type defaults + require)
    if (!candidateNames.has(name)) return false;

    // Definition-level skip always wins
    if (skippedNames.has(name)) return false;

    // Respect method scoping from YAML
    if (methodName && methodScopingMap.has(name)) {
      const methods = methodScopingMap.get(name);
      if (methods && !methods.includes(methodName)) return false;
    }

    // Required reports are immune to CLI skip flags
    if (requiredNames.has(name)) return true;

    // CLI skip by name
    if (filterOptions.skipReportNames?.includes(name)) return false;

    // CLI skip by label
    if (
      filterOptions.skipReportLabels &&
      report.labels?.some((l) => filterOptions.skipReportLabels!.includes(l))
    ) {
      return false;
    }

    // Inclusion filters (narrow to subset)
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
 * Sanitizes a report name for use as a data name component.
 *
 * Report names use the `@collective/name` scoped pattern, but data names
 * reject `/`, `\`, `..`, and null bytes as path traversal risks.
 * Follows the same pattern as `sanitizeVaultKey` in `data_writer.ts`.
 */
export function sanitizeReportNameForData(reportName: string): string {
  return reportName
    .replace(/@/g, "")
    .replace(/[/\\]/g, "-")
    .replace(/\.\./g, ".")
    .replace(/\0/g, "");
}

/**
 * Persists report results as data artifacts.
 *
 * Stores two artifacts per report:
 * - Markdown: data name `report-{reportName}`, contentType `text/markdown`
 * - JSON: data name `report-{reportName}-json`, contentType `application/json`
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
): Promise<DataHandle[]> {
  const handles: DataHandle[] = [];
  const tags: Record<string, string> = {
    type: "report",
    reportName,
    reportScope: scope,
    ...(varySuffix ? { varySuffix } : {}),
  };

  const sanitized = sanitizeReportNameForData(reportName);
  const baseName = varySuffix
    ? `report-${sanitized}-${varySuffix}`
    : `report-${sanitized}`;

  // Persist markdown artifact
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

  // Persist JSON artifact
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

/**
 * Event callback for report execution progress.
 */
export interface ReportEventCallback {
  onReportStarted(reportName: string, scope: ReportScope): void;
  onReportCompleted(
    reportName: string,
    scope: ReportScope,
    markdown: string,
    json: Record<string, unknown>,
    dataHandles: DataHandle[],
  ): void;
  onReportFailed(reportName: string, scope: ReportScope, error: string): void;
}

/**
 * Builds a redactSensitiveArgs helper bound to the given report context.
 */
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
    if (!modelDef) return args;

    const schema = argsKind === "global"
      ? modelDef.globalArguments
      : modelDef.methods[context.methodName]?.arguments;
    if (!schema) return args;

    const fields = extractSensitiveFields(schema);
    if (fields.length === 0) return args;

    const redacted = structuredClone(args);
    for (const field of fields) {
      if (getNestedValue(redacted, field.path) !== undefined) {
        setNestedValue(redacted, field.path, "***");
      }
    }
    return redacted;
  };
}

/**
 * Executes applicable reports and persists their results.
 */
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
): Promise<ReportExecutionSummary> {
  // Promote lazy-registered reports for every candidate name before calling
  // getAll(). getAll() only returns fully-loaded entries from the registry's
  // `reports` Map; lazy entries in `lazyTypes` are excluded. Without this
  // step, user extension reports registered lazily from the bundle catalog
  // (second+ process run) would be silently filtered out of the applicable
  // set — the regression fixed by #81 after the lazy loading rework in
  // #1089.
  //
  // We promote every candidate name unconditionally, including ones whose
  // scope will end up mismatched by filterReports() below. We cannot inspect
  // `report.scope` until the bundle is imported, and extending
  // LazyReportEntry with scope would duplicate the bundle catalog and
  // defeat the point of lazy loading for scope-mismatched reports anyway.
  // Wasted imports are bounded by |selection.require ∪ modelTypeReports|
  // and only happen once per process — ensureTypeLoaded() dedupes concurrent
  // callers via typeLoadPromises, and is a no-op for already-loaded and
  // unknown names. Errors from ensureTypeLoaded() propagate unchanged: a
  // broken bundle for a required report must fail loudly rather than be
  // silently skipped.
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
    return { results: [], failures: 0 };
  }

  const results: ReportExecutionResult[] = [];
  let failures = 0;

  context.redactSensitiveArgs = buildRedactSensitiveArgs(context);

  for (const { name, report } of applicable) {
    events?.onReportStarted(name, report.scope);

    try {
      const result = await report.execute(context);

      // Persist results
      const dataHandles = await persistReportData(
        context.dataRepository,
        modelType,
        modelId,
        name,
        report.scope,
        result.markdown,
        result.json,
        varySuffix,
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

      events?.onReportFailed(name, report.scope, errorMessage);

      results.push({
        name,
        scope: report.scope,
        success: false,
        error: errorMessage,
      });
      failures++;
    }
  }

  return { results, failures };
}
