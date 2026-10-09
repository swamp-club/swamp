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

import {
  type ApiCallRecord,
  REGISTRY_CHECK_LABELS,
  type RegistryCheckResult,
} from "../../domain/extensions/extension_publish_checks.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import type {
  ExtensionPushEvent,
  ExtensionPushResolvedData,
} from "../../libswamp/extensions/push.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { resolve } from "@std/path";
import {
  escapeLogTemplate,
  getSwampLogger,
} from "../../infrastructure/logging/logger.ts";
import { displayPath } from "../output/display_path.ts";
import { logTextBlock } from "./log_text_block.ts";
import type { SafetyIssue } from "../../domain/extensions/extension_safety_analyzer.ts";
import {
  qualityCheckLabel,
  type QualityIssue,
} from "../../domain/extensions/extension_quality_checker.ts";
import type { DependencyTrustIssue } from "../../domain/extensions/extension_dependency_trust_checker.ts";
import type { ReviewFinding } from "../../domain/extensions/extension_review_rules.ts";
import type { CollectiveMismatch } from "../../domain/extensions/extension_collective_validator.ts";
import type { CompilationError } from "../../libswamp/extensions/push.ts";
import {
  type FindingsReport,
  type FindingsReportPaths,
  renderFindingsReport,
} from "./extension_findings_report.ts";

/**
 * A review warning as it appears in the accepted-warnings record: the
 * finding without its report skeleton or remediation, which
 * `warnings.review` already carries in full.
 */
export type AcceptedReviewWarning = Omit<
  ReviewFinding,
  "skeleton" | "remediation"
>;

/**
 * A safety warning as it appears in the accepted-warnings record: the issue
 * without its remediation, which the `warnings` document already carries.
 */
export type AcceptedSafetyWarning = Omit<SafetyIssue, "remediation">;

/**
 * The safety and review warnings the pusher waived with `--yes` or `--force`.
 * Recorded in the dry-run and push summaries so a reviewer can see exactly
 * what was accepted. Advisory warnings (dependency trust, version drift,
 * upgrade entries) never gate a push and are not part of the record.
 */
export interface AcceptedWarnings {
  safety: AcceptedSafetyWarning[];
  review: AcceptedReviewWarning[];
}

/** The flag that waived safety and review warnings on a run. */
export type WarningsWaiver = "--yes" | "--force";

/**
 * What a run waived and with which flag. The log summary names the flag in
 * its header; the JSON summary carries only the record, under
 * `acceptedWarnings`.
 */
export interface WarningsAcceptance {
  warnings: AcceptedWarnings;
  waivedBy: WarningsWaiver;
}

/** Summary data for a completed dry run. */
export interface ExtensionPushDryRunData {
  name: string;
  version: string;
  archiveSize: number;
  visibility: ExtensionPushResolvedData["visibility"];
  /** The content hash the review report is keyed by. */
  contentHash: string | undefined;
  /** Each registry check's verdict, in the order the push runs them. */
  registryChecks: RegistryCheckResult[];
  /** Every HTTP call the run made; empty when none was made. */
  apiCalls: ApiCallRecord[];
  /** Present only when a flag waived at least one warning. */
  accepted?: WarningsAcceptance;
  /** The declared acceptances and the unresolved warnings. */
  report?: FindingsReport;
}

/** Per-run inputs for the stream handlers. */
export interface ExtensionPushHandlerOptions {
  /** Present only when a flag waived at least one warning. */
  accepted?: WarningsAcceptance;
  /** The declared acceptances and the unresolved warnings. */
  report?: FindingsReport;
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
  renderDryRun(data: ExtensionPushDryRunData): void;
  /**
   * Called when the run throws. In `--json` mode it writes the run's
   * document with status `failed` unless a render already wrote one, so
   * stdout always carries exactly one document; log mode has nothing to add.
   */
  renderUnfinished(): void;
  handlers(
    options?: ExtensionPushHandlerOptions,
  ): EventHandlers<ExtensionPushEvent>;
}

/**
 * Where the renderer prints paths from: the directory the author ran the
 * command in, the repo directory the resolved file names are relative to,
 * and the directory holding the manifest. Files under the repo or the
 * manifest's directory are the pushed content, which prints relative to
 * `cwd` (see {@link displayPath}).
 */
export interface ExtensionPushRenderPaths {
  cwd: string;
  repoDir: string;
  manifestDir: string;
}

type LogLevelName = "info" | "warn" | "error";

function acceptedWarningsHeader(accepted: WarningsAcceptance): string {
  const count = accepted.warnings.safety.length +
    accepted.warnings.review.length;
  const noun = count === 1 ? "warning" : "warnings";
  return `Accepted ${count} ${noun} with ${accepted.waivedBy}:`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** `name@version`, interpolated as one value so it prints as one quoted token. */
function nameAtVersion(data: { name: string; version: string }): string {
  return `${data.name}@${data.version}`;
}

function requestedVisibilityLabel(
  visibility: ExtensionPushResolvedData["visibility"],
): string {
  return visibility === "default"
    ? "default (registry decides)"
    : visibility === "public"
    ? "public (registry default; existing visibility preserved)"
    : visibility;
}

class LogExtensionPushRenderer implements ExtensionPushRenderer {
  private logger = getSwampLogger(["extension", "push"]);

  constructor(private readonly paths: ExtensionPushRenderPaths) {}

  /** An absolute path as the author can open it from where they ran push. */
  private display(path: string): string {
    return displayPath(path, this.paths.cwd, [
      this.paths.repoDir,
      this.paths.manifestDir,
    ]);
  }

  /** How the findings report prints its paths. */
  private reportPaths(): FindingsReportPaths {
    return {
      manifestDir: this.paths.manifestDir,
      display: (path) => this.display(path),
    };
  }

  /** A resolved file name (repo-relative) as the author can open it. */
  private resolvedFile(fileName: string): string {
    return this.display(resolve(this.paths.repoDir, fileName));
  }

  /** A finding's `file:line`, its file as the author can open it. */
  private where(finding: { file: string; line?: number }): string {
    const file = this.display(finding.file);
    return finding.line !== undefined ? `${file}:${finding.line}` : file;
  }

  /** Prints free text one line per log line, verbatim. */
  private textBlock(level: LogLevelName, text: string, indent: string): void {
    logTextBlock(this.logger, level, text, indent);
  }

  /**
   * A multi-line value prints as its label, then its lines; `single` prints
   * a one-line value on the label's own line.
   */
  private labelled(label: string, value: string, single: () => void): void {
    if (value.includes("\n")) {
      this.logger.info(escapeLogTemplate(`${label}:`));
      this.textBlock("info", value, "  ");
    } else {
      single();
    }
  }

  private fieldLine(field: { name: string; type: string; required: boolean }) {
    if (field.required) {
      this.logger.info`      ${field.name}: ${field.type}`;
    } else {
      this.logger.info`      ${field.name}: ${field.type} (optional)`;
    }
  }

  private namedLine(entry: { type: string; name?: string; fileName: string }) {
    const file = this.resolvedFile(entry.fileName);
    if (entry.name) {
      this.logger.info`  ${entry.type} - ${entry.name} (${file})`;
    } else {
      this.logger.info`  ${entry.type} (${file})`;
    }
  }

  renderResolved(data: ExtensionPushResolvedData): void {
    this.logger.info`Extension: ${nameAtVersion(data)}`;
    this.logger.info(
      escapeLogTemplate(
        `Requested visibility: ${requestedVisibilityLabel(data.visibility)}`,
      ),
    );
    if (data.description) {
      const description = data.description;
      this.labelled(
        "Description",
        description,
        () => this.logger.info`Description: ${description}`,
      );
    }
    if (data.repository) {
      this.logger.info`Repository: ${data.repository}`;
    }
    if (data.releaseNotes) {
      const releaseNotes = data.releaseNotes;
      this.labelled(
        "Release Notes",
        releaseNotes,
        () => this.logger.info`Release Notes: ${releaseNotes}`,
      );
    }
    if (data.models.length > 0) {
      this.logger.info`Models (${data.models.length}):`;
      for (const m of data.models) {
        this.logger.info`  ${m.type} (${this.resolvedFile(m.fileName)})`;
        if (m.globalArguments && m.globalArguments.length > 0) {
          this.logger.info`    Global Arguments:`;
          for (const arg of m.globalArguments) {
            this.fieldLine(arg);
          }
        }
      }
    }
    if (data.workflowFiles.length > 0) {
      this.logger.info`Workflows (${data.workflowFiles.length}):`;
      for (const f of data.workflowFiles) {
        this.logger.info`  ${this.resolvedFile(f)}`;
      }
    }
    if (data.vaults.length > 0) {
      this.logger.info`Vaults (${data.vaults.length}):`;
      for (const v of data.vaults) {
        this.namedLine(v);
        if (v.configFields && v.configFields.length > 0) {
          this.logger.info`    Config Fields:`;
          for (const field of v.configFields) {
            this.fieldLine(field);
          }
        }
      }
    }
    if (data.datastores.length > 0) {
      this.logger.info`Datastores (${data.datastores.length}):`;
      for (const d of data.datastores) {
        this.namedLine(d);
        if (d.configFields && d.configFields.length > 0) {
          this.logger.info`    Config Fields:`;
          for (const field of d.configFields) {
            this.fieldLine(field);
          }
        }
      }
    }
    if (data.reports.length > 0) {
      this.logger.info`Reports (${data.reports.length}):`;
      for (const r of data.reports) {
        const file = this.resolvedFile(r.fileName);
        if (r.scope) {
          this.logger.info`  ${r.name} [${r.scope}] (${file})`;
        } else {
          this.logger.info`  ${r.name} (${file})`;
        }
      }
    }
    if (data.webhooks.length > 0) {
      this.logger.info`Webhooks (${data.webhooks.length}):`;
      for (const w of data.webhooks) {
        this.namedLine(w);
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
        this.logger.info`  ${this.resolvedFile(f)}`;
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
        .warn`  [${w.severity}] ${w.dimension} — ${this.where(w)}: ${summary}`;
    }
  }

  renderReviewRuleErrors(errors: ReviewFinding[]): void {
    this.logger.error`Extension review rule errors (push blocked):`;
    for (const e of errors) {
      const summary = e.message.split("\n")[0];
      this.logger
        .error`  [${e.severity}] ${e.dimension} — ${this.where(e)}: ${summary}`;
    }
  }

  renderSafetyWarnings(warnings: SafetyIssue[]): void {
    this.logger.warn`Safety warnings:`;
    for (const w of warnings) {
      this.logger.warn`  ${this.where(w)}: ${w.message}`;
    }
  }

  renderSafetyErrors(errors: SafetyIssue[]): void {
    this.logger.error`Safety errors (push blocked):`;
    for (const e of errors) {
      this.logger.error`  ${this.where(e)}: ${e.message}`;
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
      this.textBlock("error", issue.output, "    ");
    }
    this.logger
      .error`Run 'swamp extension fmt <manifest-path>' to fix these issues.`;
  }

  renderUpgradeChainErrors(issues: QualityIssue[]): void {
    this.logger.error`Upgrade chain validation failed (push blocked):`;
    for (const issue of issues) {
      this.textBlock("error", issue.output, "  ");
    }
  }

  renderVersionDriftWarnings(warnings: QualityIssue[]): void {
    this.logger.warn`Version drift warnings (non-blocking):`;
    for (const w of warnings) {
      this.textBlock("warn", w.output, "  ");
    }
  }

  renderVersionBumpUpgradeWarnings(warnings: QualityIssue[]): void {
    this.logger.warn`Version bump without upgrade entry (non-blocking):`;
    for (const w of warnings) {
      this.textBlock("warn", w.output, "  ");
    }
  }

  renderCompilationErrors(errors: CompilationError[]): void {
    this.logger.error`Bundle compilation failed:`;
    for (const r of errors) {
      const file = this.display(r.file);
      if (r.error.includes("\n")) {
        this.logger.error`  ${file}:`;
        this.textBlock("error", r.error, "    ");
      } else {
        this.logger.error`  ${file}: ${r.error}`;
      }
    }
  }

  private renderAcceptedWarnings(accepted: WarningsAcceptance): void {
    this.logger.warn(acceptedWarningsHeader(accepted));
    for (const w of accepted.warnings.safety) {
      this.logger.warn`  ${this.where(w)}: ${w.message}`;
    }
    for (const w of accepted.warnings.review) {
      const summary = w.message.split("\n")[0];
      this.logger
        .warn`  [${w.severity}] ${w.dimension} — ${this.where(w)}: ${summary}`;
    }
  }

  renderDryRun(data: ExtensionPushDryRunData): void {
    this.logger.info`Dry run complete for ${nameAtVersion(data)}`;
    this.logger.info`Archive size: ${formatBytes(data.archiveSize)}`;
    if (data.contentHash) {
      this.logger.info`Content hash: ${data.contentHash}`;
    }
    if (data.registryChecks.length > 0) {
      this.logger.info("Registry checks:");
      for (const check of data.registryChecks) {
        const label = REGISTRY_CHECK_LABELS[check.name];
        const line = `  ${label}: ${
          check.status === "not-run" ? "not run" : check.status
        } — ${check.message}`;
        if (check.status === "failed") {
          this.logger.error(line);
        } else if (check.status === "not-run") {
          this.logger.warn(line);
        } else {
          this.logger.info(line);
        }
      }
    }
    if (data.apiCalls.length === 0) {
      this.logger.info("No API calls were made.");
    } else {
      this.logger.info`API calls made (${data.apiCalls.length}):`;
      for (const call of data.apiCalls) {
        const outcome = call.status !== undefined
          ? `${call.outcome} (${call.status})`
          : call.outcome;
        this.logger.info(
          `  ${call.service}: ${call.method} ${call.url} ${outcome}`,
        );
      }
    }
    if (data.accepted) {
      this.renderAcceptedWarnings(data.accepted);
    }
    if (data.report) {
      renderFindingsReport(this.logger, data.report, this.reportPaths());
    }
  }

  renderUnfinished(): void {}

  handlers(
    options?: ExtensionPushHandlerOptions,
  ): EventHandlers<ExtensionPushEvent> {
    return {
      pushing: () => {},
      completed: (e) => {
        this.logger.info`Pushed ${nameAtVersion(e.data)}`;
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
        if (e.data.registryWarnings) {
          const { messages, omitted } = e.data.registryWarnings;
          this.logger.warn`Registry warnings:`;
          for (const message of messages) {
            this.textBlock("warn", message, "  ");
          }
          if (omitted > 0) {
            const noun = omitted === 1 ? "warning" : "warnings";
            this.logger.warn(`  ${omitted} more registry ${noun} omitted`);
          }
        }
        if (options?.accepted) {
          this.renderAcceptedWarnings(options.accepted);
        }
        if (options?.report) {
          renderFindingsReport(this.logger, options.report, this.reportPaths());
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

/** How a `--json` run ended, carried as the document's `status`. */
export type ExtensionPushJsonStatus =
  | "dry_run"
  | "pushed"
  | "failed"
  | "blocked"
  | "cancelled";

/**
 * The `--json` renderer writes one document per run. Every render call
 * before the end of the run records its part (the resolved extension, each
 * warning family); the call that ends the run (dry run, push completed or
 * failed, a blocked prepare) writes the document with those parts as fields.
 */
class JsonExtensionPushRenderer implements ExtensionPushRenderer {
  private resolved: ExtensionPushResolvedData | undefined;
  private warnings: Record<string, unknown[]> = {};
  private emitted = false;

  constructor(private readonly paths: ExtensionPushRenderPaths) {}

  private emit(
    status: ExtensionPushJsonStatus,
    fields: Record<string, unknown>,
  ): void {
    this.emitted = true;
    const hasWarnings = Object.keys(this.warnings).length > 0;
    console.log(
      JSON.stringify(
        {
          status,
          ...(this.resolved ? { resolved: this.resolved } : {}),
          ...(hasWarnings ? { warnings: this.warnings } : {}),
          ...fields,
        },
        null,
        2,
      ),
    );
  }

  private warn(family: string, entries: unknown[]): void {
    if (entries.length > 0) this.warnings[family] = entries;
  }

  private blocked(family: string, errors: unknown): void {
    this.emit("blocked", { errors: { [family]: errors } });
  }

  /** The resolved extension with every file name absolute. */
  renderResolved(data: ExtensionPushResolvedData): void {
    const abs = (fileName: string) => resolve(this.paths.repoDir, fileName);
    this.resolved = {
      ...data,
      models: data.models.map((m) => ({ ...m, fileName: abs(m.fileName) })),
      workflowFiles: data.workflowFiles.map(abs),
      vaults: data.vaults.map((v) => ({ ...v, fileName: abs(v.fileName) })),
      datastores: data.datastores.map((d) => ({
        ...d,
        fileName: abs(d.fileName),
      })),
      reports: data.reports.map((r) => ({ ...r, fileName: abs(r.fileName) })),
      webhooks: data.webhooks.map((w) => ({ ...w, fileName: abs(w.fileName) })),
      additionalFiles: data.additionalFiles.map(abs),
    };
  }

  renderDependencyTrustWarnings(warnings: DependencyTrustIssue[]): void {
    this.warn("dependencyTrust", warnings);
  }

  renderDependencyTrustErrors(errors: DependencyTrustIssue[]): void {
    this.blocked("dependencyTrust", errors);
  }

  renderReviewRuleWarnings(warnings: ReviewFinding[]): void {
    this.warn("review", warnings);
  }

  renderReviewRuleErrors(errors: ReviewFinding[]): void {
    this.blocked("review", errors);
  }

  renderSafetyWarnings(warnings: SafetyIssue[]): void {
    this.warn("safety", warnings);
  }

  renderSafetyErrors(errors: SafetyIssue[]): void {
    this.blocked("safety", errors);
  }

  renderCollectiveErrors(
    expectedCollective: string,
    mismatches: CollectiveMismatch[],
  ): void {
    this.blocked("collective", { expectedCollective, mismatches });
  }

  renderQualityErrors(issues: QualityIssue[]): void {
    this.blocked("quality", issues);
  }

  renderUpgradeChainErrors(issues: QualityIssue[]): void {
    this.blocked("upgradeChain", issues);
  }

  renderVersionDriftWarnings(warnings: QualityIssue[]): void {
    this.warn("versionDrift", warnings);
  }

  renderVersionBumpUpgradeWarnings(warnings: QualityIssue[]): void {
    this.warn("versionBumpUpgrade", warnings);
  }

  renderCompilationErrors(errors: CompilationError[]): void {
    this.blocked("compilation", errors);
  }

  renderDryRun(data: ExtensionPushDryRunData): void {
    // The document carries the record alone, under `acceptedWarnings`, and
    // only when something was waived; the waiving flag is a log-mode detail.
    const {
      accepted,
      report,
      contentHash,
      registryChecks,
      apiCalls,
      ...summary
    } = data;
    this.emit("dry_run", {
      ...summary,
      ...(contentHash ? { contentHash } : {}),
      registryChecks,
      apiCalls,
      ...(accepted ? { acceptedWarnings: accepted.warnings } : {}),
      ...(report ?? {}),
    });
  }

  renderUnfinished(): void {
    if (!this.emitted) this.emit("failed", {});
  }

  handlers(
    options?: ExtensionPushHandlerOptions,
  ): EventHandlers<ExtensionPushEvent> {
    return {
      pushing: () => {},
      completed: (e) => {
        // Registry warnings join the other families under `warnings`, one
        // object per warning like theirs; the count of any the client left
        // out stays beside the summary.
        const { registryWarnings, ...data } = e.data;
        this.warn(
          "registry",
          (registryWarnings?.messages ?? []).map((message) => ({ message })),
        );
        this.emit("pushed", {
          ...data,
          ...(registryWarnings && registryWarnings.omitted > 0
            ? { registryWarningsOmitted: registryWarnings.omitted }
            : {}),
          ...(options?.accepted
            ? { acceptedWarnings: options.accepted.warnings }
            : {}),
          ...(options?.report ?? {}),
        });
      },
      error: (e) => {
        // The run's document still reaches stdout; the error itself goes to
        // stderr with every other command's.
        this.emit("failed", {});
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createExtensionPushRenderer(
  mode: OutputMode,
  paths: ExtensionPushRenderPaths = {
    cwd: Deno.cwd(),
    repoDir: Deno.cwd(),
    manifestDir: Deno.cwd(),
  },
): ExtensionPushRenderer {
  switch (mode) {
    case "json":
      return new JsonExtensionPushRenderer(paths);
    case "log":
      return new LogExtensionPushRenderer(paths);
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
