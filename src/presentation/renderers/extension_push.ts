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

import type {
  EventHandlers,
  ExtensionPushEvent,
  ExtensionPushResolvedData,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import {
  getSwampLogger,
  writeOutput,
} from "../../infrastructure/logging/logger.ts";
import type { SafetyIssue } from "../../domain/extensions/extension_safety_analyzer.ts";
import {
  qualityCheckLabel,
  type QualityIssue,
} from "../../domain/extensions/extension_quality_checker.ts";
import type { DependencyTrustIssue } from "../../domain/extensions/extension_dependency_trust_checker.ts";
import type { ReviewFinding } from "../../domain/extensions/extension_review_rules.ts";
import type { CollectiveMismatch } from "../../domain/extensions/extension_collective_validator.ts";
import type { CompilationError } from "../../libswamp/mod.ts";

/**
 * A review warning as it appears in the accepted-warnings record: the
 * finding without its report skeleton, which the `reviewRuleWarnings`
 * document already carries in full.
 */
export type AcceptedReviewWarning = Omit<ReviewFinding, "skeleton">;

/**
 * The safety and review warnings the pusher waived with `--accept-warnings`.
 * Recorded in the dry-run and push summaries so a reviewer can see exactly
 * what was accepted. Advisory warnings (dependency trust, version drift,
 * upgrade entries) never gate a push and are not part of the record.
 */
export interface AcceptedWarnings {
  safety: SafetyIssue[];
  review: AcceptedReviewWarning[];
}

/** Summary data for a completed dry run. */
export interface ExtensionPushDryRunData {
  name: string;
  version: string;
  archiveSize: number;
  visibility: ExtensionPushResolvedData["visibility"];
  /** Present only when `--accept-warnings` waived at least one warning. */
  acceptedWarnings?: AcceptedWarnings;
}

/** Per-run inputs for the stream handlers. */
export interface ExtensionPushHandlerOptions {
  /** Present only when `--accept-warnings` waived at least one warning. */
  acceptedWarnings?: AcceptedWarnings;
}

/** Extended renderer with methods for the prepare-phase outputs. */
export interface ExtensionPushRenderer extends Renderer<ExtensionPushEvent> {
  renderResolved(data: ExtensionPushResolvedData): void;
  renderDependencyTrustWarnings(warnings: DependencyTrustIssue[]): void;
  renderDependencyTrustErrors(errors: DependencyTrustIssue[]): void;
  renderReviewRuleWarnings(warnings: ReviewFinding[]): void;
  renderReviewRuleErrors(errors: ReviewFinding[]): void;
  renderSafetyWarnings(warnings: SafetyIssue[]): void;
  renderSafetyErrors(errors: SafetyIssue[]): void;
  renderCollectiveErrors(
    expectedCollective: string,
    mismatches: CollectiveMismatch[],
  ): void;
  renderQualityErrors(issues: QualityIssue[]): void;
  renderUpgradeChainErrors(issues: QualityIssue[]): void;
  renderVersionDriftWarnings(warnings: QualityIssue[]): void;
  renderVersionBumpUpgradeWarnings(warnings: QualityIssue[]): void;
  renderCompilationErrors(errors: CompilationError[]): void;
  /**
   * Tells an interactive dry run that the warnings it just saw would stop a
   * non-interactive push. The dry run itself never prompts.
   */
  renderAcceptWarningsHint(): void;
  renderDryRun(data: ExtensionPushDryRunData): void;
  handlers(
    options?: ExtensionPushHandlerOptions,
  ): EventHandlers<ExtensionPushEvent>;
}

function acceptedWarningsHeader(accepted: AcceptedWarnings): string {
  const count = accepted.safety.length + accepted.review.length;
  const noun = count === 1 ? "warning" : "warnings";
  return `Accepted ${count} ${noun} with --accept-warnings:`;
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
    renderRequestedVisibility(data.visibility);
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
    if (data.webhooks.length > 0) {
      this.logger.info`Webhooks (${data.webhooks.length}):`;
      for (const w of data.webhooks) {
        const nameLabel = w.name ? ` - ${w.name}` : "";
        this.logger.info`  ${w.type}${nameLabel} (${w.fileName})`;
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

  renderDependencyTrustWarnings(warnings: DependencyTrustIssue[]): void {
    this.logger.warn`Dependency trust warnings (non-blocking):`;
    for (const w of warnings) {
      this.logger.warn`  ${w.dependency}: ${w.message}`;
    }
  }

  renderDependencyTrustErrors(errors: DependencyTrustIssue[]): void {
    this.logger.error`Dependency trust errors (push blocked):`;
    for (const e of errors) {
      this.logger.error`  ${e.dependency}: ${e.message}`;
    }
  }

  renderReviewRuleWarnings(warnings: ReviewFinding[]): void {
    // No "(non-blocking)" qualifier — these warnings do trigger the push
    // confirmation prompt, matching the `Safety warnings:` style.
    this.logger.warn`Extension review warnings:`;
    for (const w of warnings) {
      // Render the first line only; multi-line detail (e.g. the report
      // skeleton) stays in the JSON output.
      const summary = w.message.split("\n")[0];
      this.logger
        .warn`  [${w.severity}] ${w.dimension} — ${w.file}: ${summary}`;
    }
  }

  renderReviewRuleErrors(errors: ReviewFinding[]): void {
    this.logger.error`Extension review rule errors (push blocked):`;
    for (const e of errors) {
      const summary = e.message.split("\n")[0];
      this.logger
        .error`  [${e.severity}] ${e.dimension} — ${e.file}: ${summary}`;
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
      const label = qualityCheckLabel(issue.check);
      this.logger.error`  ${label} issues:`;
      this.logger.error`${issue.output}`;
    }
    this.logger
      .error`Run 'swamp extension fmt <manifest-path>' to fix these issues.`;
  }

  renderUpgradeChainErrors(issues: QualityIssue[]): void {
    this.logger.error`Upgrade chain validation failed (push blocked):`;
    for (const issue of issues) {
      this.logger.error`  ${issue.output}`;
    }
  }

  renderVersionDriftWarnings(warnings: QualityIssue[]): void {
    this.logger.warn`Version drift warnings (non-blocking):`;
    for (const w of warnings) {
      this.logger.warn`  ${w.output}`;
    }
  }

  renderVersionBumpUpgradeWarnings(warnings: QualityIssue[]): void {
    this.logger.warn`Version bump without upgrade entry (non-blocking):`;
    for (const w of warnings) {
      this.logger.warn`  ${w.output}`;
    }
  }

  renderCompilationErrors(errors: CompilationError[]): void {
    this.logger.error`Bundle compilation failed:`;
    for (const r of errors) {
      this.logger.error`  ${r.file}: ${r.error}`;
    }
  }

  renderAcceptWarningsHint(): void {
    this.logger.info(
      "A non-interactive push (--json or no terminal) needs --accept-warnings for these warnings.",
    );
  }

  private renderAcceptedWarnings(accepted: AcceptedWarnings): void {
    this.logger.warn(acceptedWarningsHeader(accepted));
    for (const w of accepted.safety) {
      this.logger.warn`  ${w.file}: ${w.message}`;
    }
    for (const w of accepted.review) {
      const summary = w.message.split("\n")[0];
      this.logger
        .warn`  [${w.severity}] ${w.dimension} — ${w.file}: ${summary}`;
    }
  }

  renderDryRun(data: ExtensionPushDryRunData): void {
    this.logger.info`Dry run complete for ${data.name}@${data.version}`;
    renderRequestedVisibility(data.visibility);
    this.logger.info`Archive size: ${formatBytes(data.archiveSize)}`;
    this.logger.info("No API calls were made.");
    if (data.acceptedWarnings) {
      this.renderAcceptedWarnings(data.acceptedWarnings);
    }
  }

  handlers(
    options?: ExtensionPushHandlerOptions,
  ): EventHandlers<ExtensionPushEvent> {
    return {
      pushing: () => {},
      completed: (e) => {
        this.logger
          .info`Pushed ${e.data.name}@${e.data.version}`;
        this.logger.info`Channel: ${e.data.channel}`;
        this.logger.info`Visibility: ${e.data.visibility}`;
        if (e.data.visibility === "private") {
          this.logger
            .warn`This extension is private — only collective members can pull it`;
        }
        this.logger.info`Extension ID: ${e.data.extensionId}`;
        this.logger.info`Archive size: ${formatBytes(e.data.archiveSize)}`;
        const parts = [
          `Models: ${e.data.modelCount}`,
          `Workflows: ${e.data.workflowCount}`,
          `Vaults: ${e.data.vaultCount}`,
        ];
        if (e.data.datastoreCount > 0) {
          parts.push(`Datastores: ${e.data.datastoreCount}`);
        }
        if (e.data.reportCount > 0) {
          parts.push(`Reports: ${e.data.reportCount}`);
        }
        if (e.data.webhookCount > 0) {
          parts.push(`Webhooks: ${e.data.webhookCount}`);
        }
        if (e.data.skillCount > 0) {
          parts.push(`Skills: ${e.data.skillCount}`);
        }
        parts.push(`Bundles: ${e.data.bundleCount}`);
        this.logger.info`${parts.join(", ")}`;
        if (options?.acceptedWarnings) {
          this.renderAcceptedWarnings(options.acceptedWarnings);
        }
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

  renderDependencyTrustWarnings(warnings: DependencyTrustIssue[]): void {
    console.log(
      JSON.stringify({ dependencyTrustWarnings: warnings }, null, 2),
    );
  }

  renderDependencyTrustErrors(errors: DependencyTrustIssue[]): void {
    console.log(JSON.stringify({ dependencyTrustErrors: errors }, null, 2));
  }

  renderReviewRuleWarnings(warnings: ReviewFinding[]): void {
    console.log(
      JSON.stringify({ reviewRuleWarnings: warnings }, null, 2),
    );
  }

  renderReviewRuleErrors(errors: ReviewFinding[]): void {
    console.log(JSON.stringify({ reviewRuleErrors: errors }, null, 2));
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

  renderUpgradeChainErrors(issues: QualityIssue[]): void {
    console.log(JSON.stringify({ upgradeChainErrors: issues }, null, 2));
  }

  renderVersionDriftWarnings(warnings: QualityIssue[]): void {
    console.log(
      JSON.stringify({ versionDriftWarnings: warnings }, null, 2),
    );
  }

  renderVersionBumpUpgradeWarnings(warnings: QualityIssue[]): void {
    console.log(
      JSON.stringify({ versionBumpUpgradeWarnings: warnings }, null, 2),
    );
  }

  renderCompilationErrors(errors: CompilationError[]): void {
    console.log(JSON.stringify({ compilationErrors: errors }, null, 2));
  }

  renderAcceptWarningsHint(): void {
    // A JSON run never reaches the hint: without --accept-warnings it is
    // refused, and with the flag the record goes in the summary instead.
  }

  renderDryRun(data: ExtensionPushDryRunData): void {
    // `acceptedWarnings` is undefined when nothing was accepted, and
    // JSON.stringify drops undefined fields, so the document is unchanged
    // for runs without the flag.
    console.log(JSON.stringify({ ...data, status: "dry_run" }, null, 2));
  }

  handlers(
    options?: ExtensionPushHandlerOptions,
  ): EventHandlers<ExtensionPushEvent> {
    return {
      pushing: () => {},
      completed: (e) => {
        const summary = options?.acceptedWarnings
          ? { ...e.data, acceptedWarnings: options.acceptedWarnings }
          : e.data;
        console.log(JSON.stringify(summary, null, 2));
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

function renderRequestedVisibility(
  visibility: ExtensionPushResolvedData["visibility"],
): void {
  const label = visibility === "default"
    ? "default (registry decides)"
    : visibility === "public"
    ? "public (registry default; existing visibility preserved)"
    : visibility;
  writeOutput(`Requested visibility: ${label}`);
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
