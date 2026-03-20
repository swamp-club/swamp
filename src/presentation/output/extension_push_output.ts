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

import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { SafetyIssue } from "../../domain/extensions/extension_safety_analyzer.ts";
import type { QualityIssue } from "../../domain/extensions/extension_quality_checker.ts";
import type { ExtractedArgument } from "../../domain/extensions/extension_content.ts";
import type { CollectiveMismatch } from "../../domain/extensions/extension_collective_validator.ts";

const logger = getSwampLogger(["extension", "push"]);

/** A model entry enriched with extracted metadata for the resolved display. */
export interface ResolvedModelEntry {
  type: string;
  fileName: string;
  globalArguments?: ExtractedArgument[];
}

/** A vault entry enriched with extracted metadata for the resolved display. */
export interface ResolvedVaultEntry {
  type: string;
  fileName: string;
  name?: string;
  hasConfigSchema?: boolean;
  configFields?: ExtractedArgument[];
}

/** A driver entry enriched with extracted metadata for the resolved display. */
export interface ResolvedDriverEntry {
  type: string;
  fileName: string;
  name?: string;
  hasConfigSchema?: boolean;
  configFields?: ExtractedArgument[];
}

/** A datastore entry enriched with extracted metadata for the resolved display. */
export interface ResolvedDatastoreEntry {
  type: string;
  fileName: string;
  name?: string;
  hasConfigSchema?: boolean;
  configFields?: ExtractedArgument[];
}

/** A report entry enriched with extracted metadata for the resolved display. */
export interface ResolvedReportEntry {
  name: string;
  fileName: string;
  description?: string;
  scope?: string;
  labels?: string[];
}

/** Data for showing resolved extension contents before push. */
export interface ExtensionPushResolvedData {
  name: string;
  version: string;
  description: string | undefined;
  repository: string | undefined;
  releaseNotes: string | undefined;
  models: ResolvedModelEntry[];
  workflowFiles: string[];
  vaults: ResolvedVaultEntry[];
  drivers: ResolvedDriverEntry[];
  datastores: ResolvedDatastoreEntry[];
  reports: ResolvedReportEntry[];
  additionalFiles: string[];
  platforms: string[];
  labels: string[];
  dependencies: string[];
}

/** Data for successful push output. */
export interface ExtensionPushSuccessData {
  name: string;
  version: string;
  extensionId: string;
  archiveSize: number;
  modelCount: number;
  workflowCount: number;
  bundleCount: number;
  vaultCount: number;
  driverCount: number;
  datastoreCount: number;
  reportCount: number;
}

/** Data for compilation error output. */
export interface CompilationError {
  file: string;
  error: string;
}

/**
 * Renders the resolved extension contents before push.
 */
export function renderExtensionPushResolved(
  data: ExtensionPushResolvedData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    logger.info`Extension: ${data.name}@${data.version}`;
    if (data.description) {
      logger.info`Description: ${data.description}`;
    }
    if (data.repository) {
      logger.info`Repository: ${data.repository}`;
    }
    if (data.releaseNotes) {
      logger.info`Release Notes: ${data.releaseNotes}`;
    }
    if (data.models.length > 0) {
      logger.info`Models (${data.models.length}):`;
      for (const m of data.models) {
        logger.info`  ${m.type} (${m.fileName})`;
        if (m.globalArguments && m.globalArguments.length > 0) {
          logger.info`    Global Arguments:`;
          for (const arg of m.globalArguments) {
            const opt = arg.required ? "" : " (optional)";
            logger.info`      ${arg.name}: ${arg.type}${opt}`;
          }
        }
      }
    }
    if (data.workflowFiles.length > 0) {
      logger.info`Workflows (${data.workflowFiles.length}):`;
      for (const f of data.workflowFiles) {
        logger.info`  ${f}`;
      }
    }
    if (data.vaults.length > 0) {
      logger.info`Vaults (${data.vaults.length}):`;
      for (const v of data.vaults) {
        const nameLabel = v.name ? ` - ${v.name}` : "";
        logger.info`  ${v.type}${nameLabel} (${v.fileName})`;
        if (v.configFields && v.configFields.length > 0) {
          logger.info`    Config Fields:`;
          for (const field of v.configFields) {
            const opt = field.required ? "" : " (optional)";
            logger.info`      ${field.name}: ${field.type}${opt}`;
          }
        }
      }
    }
    if (data.drivers.length > 0) {
      logger.info`Drivers (${data.drivers.length}):`;
      for (const d of data.drivers) {
        const nameLabel = d.name ? ` - ${d.name}` : "";
        logger.info`  ${d.type}${nameLabel} (${d.fileName})`;
        if (d.configFields && d.configFields.length > 0) {
          logger.info`    Config Fields:`;
          for (const field of d.configFields) {
            const opt = field.required ? "" : " (optional)";
            logger.info`      ${field.name}: ${field.type}${opt}`;
          }
        }
      }
    }
    if (data.datastores.length > 0) {
      logger.info`Datastores (${data.datastores.length}):`;
      for (const d of data.datastores) {
        const nameLabel = d.name ? ` - ${d.name}` : "";
        logger.info`  ${d.type}${nameLabel} (${d.fileName})`;
        if (d.configFields && d.configFields.length > 0) {
          logger.info`    Config Fields:`;
          for (const field of d.configFields) {
            const opt = field.required ? "" : " (optional)";
            logger.info`      ${field.name}: ${field.type}${opt}`;
          }
        }
      }
    }
    if (data.reports.length > 0) {
      logger.info`Reports (${data.reports.length}):`;
      for (const r of data.reports) {
        const scopeLabel = r.scope ? ` [${r.scope}]` : "";
        logger.info`  ${r.name}${scopeLabel} (${r.fileName})`;
      }
    }
    if (data.additionalFiles.length > 0) {
      logger.info`Additional files (${data.additionalFiles.length}):`;
      for (const f of data.additionalFiles) {
        logger.info`  ${f}`;
      }
    }
    if (data.platforms.length > 0) {
      logger.info`Platforms: ${data.platforms.join(", ")}`;
    }
    if (data.labels.length > 0) {
      logger.info`Labels: ${data.labels.join(", ")}`;
    }
    if (data.dependencies.length > 0) {
      logger.info`Dependencies: ${data.dependencies.join(", ")}`;
    }
  }
}

/**
 * Renders safety warnings.
 */
export function renderExtensionPushSafetyWarnings(
  warnings: SafetyIssue[],
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ warnings }, null, 2));
  } else {
    logger.warn`Safety warnings:`;
    for (const w of warnings) {
      logger.warn`  ${w.file}: ${w.message}`;
    }
  }
}

/**
 * Renders safety errors.
 */
export function renderExtensionPushSafetyErrors(
  errors: SafetyIssue[],
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ errors }, null, 2));
  } else {
    logger.error`Safety errors (push blocked):`;
    for (const e of errors) {
      logger.error`  ${e.file}: ${e.message}`;
    }
  }
}

/**
 * Renders collective mismatch errors.
 */
export function renderExtensionPushCollectiveErrors(
  expectedCollective: string,
  mismatches: CollectiveMismatch[],
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(
      JSON.stringify(
        { collectiveErrors: { expectedCollective, mismatches } },
        null,
        2,
      ),
    );
  } else {
    logger.error`Collective errors (push blocked):`;
    logger.error`  All content must use collective "${expectedCollective}"`;
    for (const m of mismatches) {
      logger.error`  ${m.kind}: "${m.identifier}" in ${m.fileName}`;
    }
  }
}

/**
 * Renders successful push result.
 */
export function renderExtensionPush(
  data: ExtensionPushSuccessData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    logger.info`Pushed ${data.name}@${data.version}`;
    logger.info`Extension ID: ${data.extensionId}`;
    logger.info`Archive size: ${formatBytes(data.archiveSize)}`;
    const parts = [
      `Models: ${data.modelCount}`,
      `Workflows: ${data.workflowCount}`,
      `Vaults: ${data.vaultCount}`,
    ];
    if (data.driverCount > 0) parts.push(`Drivers: ${data.driverCount}`);
    if (data.datastoreCount > 0) {
      parts.push(`Datastores: ${data.datastoreCount}`);
    }
    if (data.reportCount > 0) parts.push(`Reports: ${data.reportCount}`);
    parts.push(`Bundles: ${data.bundleCount}`);
    logger.info`${parts.join(", ")}`;
  }
}

/**
 * Renders cancellation message.
 */
export function renderExtensionPushCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ status: "cancelled" }));
  } else {
    logger.info("Push cancelled.");
  }
}

/**
 * Renders compilation errors.
 */
export function renderExtensionPushCompilationErrors(
  results: CompilationError[],
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ compilationErrors: results }, null, 2));
  } else {
    logger.error`Bundle compilation failed:`;
    for (const r of results) {
      logger.error`  ${r.file}: ${r.error}`;
    }
  }
}

/**
 * Renders dry-run completion message.
 */
export function renderExtensionPushDryRun(
  data: { name: string; version: string; archiveSize: number },
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ ...data, status: "dry_run" }, null, 2));
  } else {
    logger.info`Dry run complete for ${data.name}@${data.version}`;
    logger.info`Archive size: ${formatBytes(data.archiveSize)}`;
    logger.info("No API calls were made.");
  }
}

/**
 * Renders quality check errors (formatting/lint issues that block push).
 */
export function renderExtensionPushQualityErrors(
  issues: QualityIssue[],
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ qualityErrors: issues }, null, 2));
  } else {
    logger.error`Quality checks failed (push blocked):`;
    for (const issue of issues) {
      const label = issue.check === "fmt" ? "Formatting" : "Lint";
      logger.error`  ${label} issues:`;
      logger.error`${issue.output}`;
    }
    logger
      .error`Run 'swamp extension fmt <manifest-path>' to fix these issues.`;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
