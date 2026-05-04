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

import type {
  EventHandlers,
  ExtensionPushEvent,
  ExtensionPushResolvedData,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { SafetyIssue } from "../../domain/extensions/extension_safety_analyzer.ts";
import type { QualityIssue } from "../../domain/extensions/extension_quality_checker.ts";
import type { CollectiveMismatch } from "../../domain/extensions/extension_collective_validator.ts";
import type { CompilationError } from "../../libswamp/mod.ts";

/** Extended renderer with methods for the prepare-phase outputs. */
export interface ExtensionPushRenderer extends Renderer<ExtensionPushEvent> {
  renderResolved(data: ExtensionPushResolvedData): void;
  renderSafetyWarnings(warnings: SafetyIssue[]): void;
  renderSafetyErrors(errors: SafetyIssue[]): void;
  renderCollectiveErrors(
    expectedCollective: string,
    mismatches: CollectiveMismatch[],
  ): void;
  renderQualityErrors(issues: QualityIssue[]): void;
  renderCompilationErrors(errors: CompilationError[]): void;
  renderDryRun(data: {
    name: string;
    version: string;
    archiveSize: number;
  }): void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

class LogExtensionPushRenderer implements ExtensionPushRenderer {
  private logger = getSwampLogger(["extension", "push"]);

  renderResolved(data: ExtensionPushResolvedData): void {
    this.logger.info`Extension: ${data.name}@${data.version}`;
    if (data.description) {
      this.logger.info`Description: ${data.description}`;
    }
    if (data.repository) {
      this.logger.info`Repository: ${data.repository}`;
    }
    if (data.releaseNotes) {
      this.logger.info`Release Notes: ${data.releaseNotes}`;
    }
    if (data.models.length > 0) {
      this.logger.info`Models (${data.models.length}):`;
      for (const m of data.models) {
        this.logger.info`  ${m.type} (${m.fileName})`;
        if (m.globalArguments && m.globalArguments.length > 0) {
          this.logger.info`    Global Arguments:`;
          for (const arg of m.globalArguments) {
            const opt = arg.required ? "" : " (optional)";
            this.logger.info`      ${arg.name}: ${arg.type}${opt}`;
          }
        }
      }
    }
    if (data.workflowFiles.length > 0) {
      this.logger.info`Workflows (${data.workflowFiles.length}):`;
      for (const f of data.workflowFiles) {
        this.logger.info`  ${f}`;
      }
    }
    if (data.vaults.length > 0) {
      this.logger.info`Vaults (${data.vaults.length}):`;
      for (const v of data.vaults) {
        const nameLabel = v.name ? ` - ${v.name}` : "";
        this.logger.info`  ${v.type}${nameLabel} (${v.fileName})`;
        if (v.configFields && v.configFields.length > 0) {
          this.logger.info`    Config Fields:`;
          for (const field of v.configFields) {
            const opt = field.required ? "" : " (optional)";
            this.logger.info`      ${field.name}: ${field.type}${opt}`;
          }
        }
      }
    }
    if (data.drivers.length > 0) {
      this.logger.info`Drivers (${data.drivers.length}):`;
      for (const d of data.drivers) {
        const nameLabel = d.name ? ` - ${d.name}` : "";
        this.logger.info`  ${d.type}${nameLabel} (${d.fileName})`;
        if (d.configFields && d.configFields.length > 0) {
          this.logger.info`    Config Fields:`;
          for (const field of d.configFields) {
            const opt = field.required ? "" : " (optional)";
            this.logger.info`      ${field.name}: ${field.type}${opt}`;
          }
        }
      }
    }
    if (data.datastores.length > 0) {
      this.logger.info`Datastores (${data.datastores.length}):`;
      for (const d of data.datastores) {
        const nameLabel = d.name ? ` - ${d.name}` : "";
        this.logger.info`  ${d.type}${nameLabel} (${d.fileName})`;
        if (d.configFields && d.configFields.length > 0) {
          this.logger.info`    Config Fields:`;
          for (const field of d.configFields) {
            const opt = field.required ? "" : " (optional)";
            this.logger.info`      ${field.name}: ${field.type}${opt}`;
          }
        }
      }
    }
    if (data.reports.length > 0) {
      this.logger.info`Reports (${data.reports.length}):`;
      for (const r of data.reports) {
        const scopeLabel = r.scope ? ` [${r.scope}]` : "";
        this.logger.info`  ${r.name}${scopeLabel} (${r.fileName})`;
      }
    }
    if (data.skills.length > 0) {
      this.logger.info`Skills (${data.skills.length}):`;
      for (const s of data.skills) {
        this.logger.info`  ${s.name} (${s.fileCount} files)`;
      }
    }
    if (data.additionalFiles.length > 0) {
      this.logger.info`Additional files (${data.additionalFiles.length}):`;
      for (const f of data.additionalFiles) {
        this.logger.info`  ${f}`;
      }
    }
    if (data.platforms.length > 0) {
      this.logger.info`Platforms: ${data.platforms.join(", ")}`;
    }
    if (data.labels.length > 0) {
      this.logger.info`Labels: ${data.labels.join(", ")}`;
    }
    if (data.dependencies.length > 0) {
      this.logger.info`Dependencies: ${data.dependencies.join(", ")}`;
    }
  }

  renderSafetyWarnings(warnings: SafetyIssue[]): void {
    this.logger.warn`Safety warnings:`;
    for (const w of warnings) {
      this.logger.warn`  ${w.file}: ${w.message}`;
    }
  }

  renderSafetyErrors(errors: SafetyIssue[]): void {
    this.logger.error`Safety errors (push blocked):`;
    for (const e of errors) {
      this.logger.error`  ${e.file}: ${e.message}`;
    }
  }

  renderCollectiveErrors(
    expectedCollective: string,
    mismatches: CollectiveMismatch[],
  ): void {
    this.logger.error`Collective errors (push blocked):`;
    this.logger
      .error`  All content must use collective ${expectedCollective}`;
    for (const m of mismatches) {
      this.logger.error`  ${m.kind}: ${m.identifier} in ${m.fileName}`;
    }
  }

  renderQualityErrors(issues: QualityIssue[]): void {
    this.logger.error`Quality checks failed (push blocked):`;
    for (const issue of issues) {
      const label = issue.check === "fmt" ? "Formatting" : "Lint";
      this.logger.error`  ${label} issues:`;
      this.logger.error`${issue.output}`;
    }
    this.logger
      .error`Run 'swamp extension fmt <manifest-path>' to fix these issues.`;
  }

  renderCompilationErrors(errors: CompilationError[]): void {
    this.logger.error`Bundle compilation failed:`;
    for (const r of errors) {
      this.logger.error`  ${r.file}: ${r.error}`;
    }
  }

  renderDryRun(data: {
    name: string;
    version: string;
    archiveSize: number;
  }): void {
    this.logger.info`Dry run complete for ${data.name}@${data.version}`;
    this.logger.info`Archive size: ${formatBytes(data.archiveSize)}`;
    this.logger.info("No API calls were made.");
  }

  handlers(): EventHandlers<ExtensionPushEvent> {
    return {
      pushing: () => {},
      completed: (e) => {
        this.logger
          .info`Pushed ${e.data.name}@${e.data.version}`;
        this.logger.info`Extension ID: ${e.data.extensionId}`;
        this.logger.info`Archive size: ${formatBytes(e.data.archiveSize)}`;
        const parts = [
          `Models: ${e.data.modelCount}`,
          `Workflows: ${e.data.workflowCount}`,
          `Vaults: ${e.data.vaultCount}`,
        ];
        if (e.data.driverCount > 0) {
          parts.push(`Drivers: ${e.data.driverCount}`);
        }
        if (e.data.datastoreCount > 0) {
          parts.push(`Datastores: ${e.data.datastoreCount}`);
        }
        if (e.data.reportCount > 0) {
          parts.push(`Reports: ${e.data.reportCount}`);
        }
        if (e.data.skillCount > 0) {
          parts.push(`Skills: ${e.data.skillCount}`);
        }
        parts.push(`Bundles: ${e.data.bundleCount}`);
        this.logger.info`${parts.join(", ")}`;
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonExtensionPushRenderer implements ExtensionPushRenderer {
  renderResolved(data: ExtensionPushResolvedData): void {
    console.log(JSON.stringify(data, null, 2));
  }

  renderSafetyWarnings(warnings: SafetyIssue[]): void {
    console.log(JSON.stringify({ warnings }, null, 2));
  }

  renderSafetyErrors(errors: SafetyIssue[]): void {
    console.log(JSON.stringify({ errors }, null, 2));
  }

  renderCollectiveErrors(
    expectedCollective: string,
    mismatches: CollectiveMismatch[],
  ): void {
    console.log(
      JSON.stringify(
        { collectiveErrors: { expectedCollective, mismatches } },
        null,
        2,
      ),
    );
  }

  renderQualityErrors(issues: QualityIssue[]): void {
    console.log(JSON.stringify({ qualityErrors: issues }, null, 2));
  }

  renderCompilationErrors(errors: CompilationError[]): void {
    console.log(JSON.stringify({ compilationErrors: errors }, null, 2));
  }

  renderDryRun(data: {
    name: string;
    version: string;
    archiveSize: number;
  }): void {
    console.log(JSON.stringify({ ...data, status: "dry_run" }, null, 2));
  }

  handlers(): EventHandlers<ExtensionPushEvent> {
    return {
      pushing: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createExtensionPushRenderer(
  mode: OutputMode,
): ExtensionPushRenderer {
  switch (mode) {
    case "json":
      return new JsonExtensionPushRenderer();
    case "log":
      return new LogExtensionPushRenderer();
  }
}

/** Renders cancellation message when user declines a prompt. */
export function renderExtensionPushCancelled(mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify({ status: "cancelled" }));
  } else {
    const logger = getSwampLogger(["extension", "push"]);
    logger.info("Push cancelled.");
  }
}
