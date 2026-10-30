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

import { bold, dim, green, red, yellow } from "@std/fmt/colors";
import { join } from "@std/path";
import type {
  DoctorDatastoresEvent,
  RepairCatalogDuplicateLatestEvent,
  RepairCatalogIndexEvent,
  RepairDatastoreFormatMarkerEvent,
  RepairDatastoresEvent,
  RepairPreV3RecordsEvent,
  RepairUnmigratedDataEvent,
  RepairUnpushedFilesEvent,
  RepairUnreadableVersionsEvent,
  UnreadableRecordRepair,
  UnreadableVersionsSummary,
  V3ContentSummary,
} from "../../libswamp/datastores/doctor_datastores.ts";
import { describeUnreadableVersionReason } from "../../domain/data/unreadable_data_version.ts";
import {
  escapeControlCharacters,
  escapeControlCharactersInMessage,
} from "../../domain/control_characters.ts";

import type { UnpushedFilesSummary } from "../../domain/datastore/datastore_sync_service.ts";
import type { EventHandlers } from "../../libswamp/stream.ts";
import type { RetentionCheckSummary } from "../../libswamp/datastores/retention_check.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "../output/output.ts";

/** What a list of unpushed files can hold that must not be uploaded. */
const PEER_DELETED_LOOKS_UNPUSHED =
  "A file a peer deleted before your datastore extension recorded such deletes looks the same, and uploading it restores it for everyone";

/** What to do with files a real repair left unpushed. */
const UNINDEXABLE_ADVICE =
  "The datastore could not index the files still listed, so repeating the repair does not clear them. Copy them out of the datastore cache and remove them.";

// ============================================================================
// Doctor datastores renderer (detection)
// ============================================================================

/** The per-kind lines of `doctor datastores --retention` in log mode. */
export function retentionDetailLines(summary: RetentionCheckSummary): string[] {
  const lines: string[] = [
    "",
    `${bold("Retention:")} ${
      summary.configured
        ? `automatic ${summary.automatic ? green("on") : yellow("off")}`
        : dim("not configured")
    }`,
  ];
  if (!summary.configured) return lines;
  for (const kind of summary.kinds) {
    const head = `  ${bold(kind.kind)}`;
    if (kind.retention === null) {
      lines.push(`${head} ${dim("no retention")}`);
    } else if (!kind.scanned) {
      lines.push(
        `${head} ${kind.retention} ${
          dim(
            kind.kind === "bookkeeping"
              ? "(serve bookkeeping, reaped by serve; not scanned)"
              : "(not scanned)",
          )
        }`,
      );
    } else {
      const status = kind.overdue > 0
        ? red(`✗ ${kind.overdue.toLocaleString()} older than cutoff`)
        : green("✓ none older than cutoff");
      const kept = kind.kept > 0
        ? dim(` (${kind.kept.toLocaleString()} kept by design)`)
        : "";
      lines.push(
        `${head} ${kind.retention} ${
          dim(`cutoff ${kind.cutoff}`)
        } ${status}${kept}`,
      );
    }
    if (kind.watermark) {
      lines.push(
        dim(
          `    last pass ${kind.watermark.lastPassAt}, cutoff ${kind.watermark.cutoff}, ${
            kind.watermark.complete ? "complete" : "incomplete"
          }`,
        ),
      );
    }
    for (const item of kind.items) {
      lines.push(`    ${red("•")} ${item.id} ${dim(item.at)}`);
    }
    if (kind.overdue > kind.items.length) {
      lines.push(
        dim(
          `    … and ${
            (kind.overdue - kind.items.length).toLocaleString()
          } more`,
        ),
      );
    }
  }
  const history = summary.v3History;
  if (history) {
    const oldest = history.oldestCommitAt ?? "none stored";
    lines.push(
      `  ${bold("v3 history")} oldest commit ${oldest} ${
        history.overdue ? red("✗ older than the bound") : green("✓")
      }`,
    );
    lines.push(
      dim(
        `    Content retention removed stays in v3 history until its removal is folded: ` +
          `each pass folds only commits written before ${history.compactionBound} ` +
          `(a day before the pass), so removed content leaves history about a day ` +
          `after it was removed, and its chunks about a day after that. ` +
          `This check fails only for history older than ${history.failBefore}.`,
      ),
    );
  }
  return lines;
}

/**
 * The entries of a failed v3 content check in log mode, each with how to
 * repair it (swamp-club#3617).
 */
export function v3ContentDetailLines(summary: V3ContentSummary): string[] {
  const lines: string[] = [];
  const more = (total: number, shown: number) => {
    if (total > shown) lines.push(dim(`    … and ${total - shown} more`));
  };
  if (summary.unreadableRecords > 0) {
    lines.push(`\n${red("Unreadable records:")}`);
    for (const record of summary.unreadable) {
      lines.push(
        `  ${bold(record.recordKey)}${
          record.namespace === "" ? "" : dim(` [${record.namespace}]`)
        }: ${
          record.chunk === undefined
            ? "a chunk of its content"
            : `chunk ${record.chunk}`
        } is ${record.reason}`,
      );
      lines.push(dim(`    ${record.advice}`));
    }
    more(summary.unreadableRecords, summary.unreadable.length);
  }
  if (summary.atRiskCopies > 0) {
    lines.push(`\n${red("Checkout files held aside:")}`);
    for (const copy of summary.atRisk) {
      lines.push(
        `  ${bold(copy.recordKey || copy.sha256)}${
          copy.namespace === "" ? "" : dim(` [${copy.namespace}]`)
        }: ${copy.size.toLocaleString()} bytes`,
      );
    }
    more(summary.atRiskCopies, summary.atRisk.length);
    lines.push(dim(`  ${summary.atRiskAdvice}`));
  }
  if (summary.tornChunks > 0) {
    lines.push(`\n${red("Torn chunks:")}`);
    for (const chunk of summary.torn) {
      lines.push(
        `  ${bold(chunk.sha256)}${
          chunk.namespace === "" ? "" : dim(` [${chunk.namespace}]`)
        }: ${chunk.size.toLocaleString()} of ${chunk.expectedSize.toLocaleString()} bytes, named by ${chunk.recordKey}`,
      );
      lines.push(dim(`    ${chunk.advice}`));
    }
    more(summary.tornChunks, summary.torn.length);
  }
  return lines;
}

/**
 * The entries of a failed unreadable_versions check in log mode
 * (swamp-club#3955).
 */
export function unreadableVersionsDetailLines(
  summary: UnreadableVersionsSummary,
): string[] {
  const lines: string[] = [`\n${red("Unreadable data versions:")}`];
  for (const finding of summary.findings) {
    const record = `${
      finding.modelName || finding.modelId
    }/${finding.dataName}`;
    const which = finding.version === null
      ? "latest marker"
      : `version ${finding.version}`;
    lines.push(
      `  ${bold(record)} ${which}${finding.latest ? red(" (latest)") : ""}: ${
        describeUnreadableVersionReason(finding.reason)
      }`,
    );
  }
  if (summary.unreadableVersions > summary.findings.length) {
    lines.push(
      dim(
        `    … and ${
          summary.unreadableVersions - summary.findings.length
        } more`,
      ),
    );
  }
  lines.push(
    dim(
      "\n  Run 'swamp doctor datastores --repair' to preview rolling each record back to its last readable version.",
    ),
  );
  return lines;
}

/**
 * Up to `shown.length` paths, indented, and how many more there are. The
 * extension builds these from file names on disk, so control characters (an
 * escape sequence among them) are escaped (swamp-club#4112).
 */
function pathLines(
  shown: readonly string[],
  total: number,
  indent: string,
): string[] {
  const lines = shown.map((path) =>
    `${indent}${escapeControlCharacters(path)}`
  );
  if (total > shown.length) {
    lines.push(dim(`${indent}… and ${total - shown.length} more`));
  }
  return lines;
}

/**
 * The lines of a `repairUnpushedFiles` summary in log mode: files still to
 * upload, then local versions the remote does not hold, which are never
 * uploaded.
 */
export function unpushedFilesDetailLines(
  summary: UnpushedFilesSummary,
): string[] {
  const lines: string[] = [];
  if (summary.unpushed > 0) {
    lines.push(
      `  ${summary.unpushed.toLocaleString()} file(s) the remote never received:`,
    );
    for (
      const line of pathLines(summary.samplePaths, summary.unpushed, "    ")
    ) lines.push(line);
  }
  const localOnly: Array<[string, readonly string[], number]> = [
    [
      "already on the remote with other content",
      summary.sampleAlreadyPresent,
      summary.alreadyPresent,
    ],
    [
      "changed locally since the last sync",
      summary.sampleModified,
      summary.locallyModified,
    ],
    [
      "possibly changed locally (no hash to compare)",
      summary.sampleUnknown,
      summary.unknown,
    ],
  ];
  for (const [what, shown, total] of localOnly) {
    if (total === 0) continue;
    lines.push(
      `  ${
        yellow("⚠")
      } ${total.toLocaleString()} file(s) ${what}, left as they are:`,
    );
    for (const line of pathLines(shown, total, "    ")) lines.push(line);
  }
  if (
    summary.alreadyPresent + summary.locallyModified + summary.unknown > 0
  ) {
    lines.push(
      dim(
        "  The remote does not hold these versions. Copy out any you want to keep before a pull, which overwrites them.",
      ),
    );
  }
  if (summary.peerDeleted > 0) {
    lines.push(
      `  ${
        yellow("⚠")
      } ${summary.peerDeleted.toLocaleString()} file(s) a peer deleted and this cache kept, never uploaded. A namespace contamination repair's wipe removes them:`,
    );
    for (
      const line of pathLines(
        summary.samplePeerDeleted,
        summary.peerDeleted,
        "    ",
      )
    ) lines.push(line);
  }
  return lines;
}

export type DoctorDatastoresStatus = "pass" | "fail";

export interface DoctorDatastoresRenderer {
  handlers(): EventHandlers<DoctorDatastoresEvent>;
  readonly overallStatus: DoctorDatastoresStatus;
}

class LogDoctorDatastoresRenderer implements DoctorDatastoresRenderer {
  overallStatus: DoctorDatastoresStatus = "pass";

  handlers(): EventHandlers<DoctorDatastoresEvent> {
    return {
      scanning: () => {
        writeOutput(dim("Checking datastore health…"));
      },
      completed: (e) => {
        const { data } = e;

        writeOutput(`\nDatastore type: ${bold(data.datastoreType)}`);

        // Render health findings
        for (const finding of data.healthFindings) {
          if (finding.passed) {
            writeOutput(`${green("✓")} ${finding.message}`);
          } else {
            this.overallStatus = "fail";
            writeOutput(`${red("✗")} ${finding.message}`);
          }
        }

        // Render contamination details when present
        if (data.contaminationFinding) {
          const cf = data.contaminationFinding;
          writeOutput(
            `\n${red("Namespace contamination detected:")}`,
          );
          for (const ns of cf.foreignNamespaces) {
            writeOutput(
              `  Foreign ${
                bold(`"${ns.namespace}"`)
              }: ${ns.objectCount.toLocaleString()} objects`,
            );
          }
          writeOutput(
            `  Total: ${cf.totalForeignObjects.toLocaleString()} foreign objects (originals intact at their own namespaces)`,
          );
          writeOutput(
            dim(
              "\n  Run 'swamp doctor datastores --repair' to preview cleanup.",
            ),
          );
        }

        // Advisory: never fails the scan (swamp-club#4112).
        if (data.unpushedFilesFinding) {
          const uf = data.unpushedFilesFinding;
          if (uf.error !== undefined) {
            writeOutput(
              `\n${yellow("⚠")} Could not check for unpushed cache files: ${
                escapeControlCharactersInMessage(uf.error)
              }`,
            );
          } else {
            writeOutput(
              `\n${yellow("⚠")} ${
                bold(
                  `${uf.unpushed.toLocaleString()} cache file(s) the remote never received`,
                )
              }`,
            );
            writeOutput(
              pathLines(uf.samplePaths, uf.unpushed, "    ").join("\n"),
            );
            writeOutput(
              dim(
                `\n  No push sends these. Run 'swamp doctor datastores --repair' to preview uploading them. ${PEER_DELETED_LOOKS_UNPUSHED}.`,
              ),
            );
          }
        }

        // Render catalog shortfall details when present
        if (data.catalogCompletenessFinding) {
          const cc = data.catalogCompletenessFinding;
          writeOutput(`\n${red("Catalog index incomplete:")}`);
          for (const s of cc.shortfalls) {
            writeOutput(
              `  ${
                bold(s.typeNormalized)
              }: ${s.catalogRecords.toLocaleString()} indexed of ${s.diskRecords.toLocaleString()} on disk`,
            );
          }
          writeOutput(
            dim(
              "\n  Data on disk is intact — only the query index is short.\n" +
                "  Run 'swamp doctor datastores --repair' to preview a rebuild.",
            ),
          );
        }

        if (data.unreadableVersionsFinding) {
          writeOutput(
            unreadableVersionsDetailLines(data.unreadableVersionsFinding)
              .join("\n"),
          );
        }

        if (data.retentionFinding) {
          writeOutput(retentionDetailLines(data.retentionFinding).join("\n"));
        }

        if (data.v3ContentFinding) {
          writeOutput(v3ContentDetailLines(data.v3ContentFinding).join("\n"));
        }

        // Render vault mismatch advisory (yellow, does not cause failure)
        if (data.vaultMismatchFindings.length > 0) {
          writeOutput(
            `\n${yellow("⚠")} ${
              bold(
                `${data.vaultMismatchFindings.length} vault(s) use local_encryption with a remote datastore`,
              )
            }`,
          );
          for (const finding of data.vaultMismatchFindings) {
            writeOutput(
              `    ${yellow("•")} ${finding.vaultName} ${
                dim(`[${finding.vaultType}]`)
              }`,
            );
          }
          writeOutput(
            dim(
              "\n  Local encryption keys are tied to this machine and won't work " +
                "from other hosts sharing the remote datastore. " +
                "Migrate with: swamp vault migrate <name>",
            ),
          );
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonDoctorDatastoresRenderer implements DoctorDatastoresRenderer {
  overallStatus: DoctorDatastoresStatus = "pass";

  handlers(): EventHandlers<DoctorDatastoresEvent> {
    return {
      scanning: () => {},
      completed: (e) => {
        const { data } = e;
        const anyFailed = data.healthFindings.some((f) => !f.passed);
        this.overallStatus = anyFailed ? "fail" : "pass";
        console.log(
          JSON.stringify(
            {
              overallStatus: this.overallStatus,
              datastoreType: data.datastoreType,
              isCustom: data.isCustom,
              healthFindings: data.healthFindings,
              vaultMismatchFindings: data.vaultMismatchFindings,
              contaminationFinding: data.contaminationFinding ?? null,
              unpushedFilesFinding: data.unpushedFilesFinding
                ? {
                  ...data.unpushedFilesFinding,
                  ...(data.unpushedFilesFinding.unpushed > 0
                    ? { warning: `${PEER_DELETED_LOOKS_UNPUSHED}.` }
                    : {}),
                }
                : null,
              catalogCompletenessFinding: data.catalogCompletenessFinding ??
                null,
              unreadableVersionsFinding: data.unreadableVersionsFinding ??
                null,
              retentionFinding: data.retentionFinding ?? null,
              v3ContentFinding: data.v3ContentFinding ?? null,
              v3KeptLineagesFinding: data.v3KeptLineagesFinding ?? null,
              v3ReplicaRestorableFinding: data.v3ReplicaRestorableFinding ??
                null,
            },
            null,
            2,
          ),
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createDoctorDatastoresRenderer(
  mode: OutputMode,
): DoctorDatastoresRenderer {
  switch (mode) {
    case "json":
      return new JsonDoctorDatastoresRenderer();
    case "log":
      return new LogDoctorDatastoresRenderer();
  }
}

// ============================================================================
// Repair --json document (swamp-club#4011)
// ============================================================================

/** A v2 repair stage's key in the `--repair --json` document. */
export type DatastoreRepairStage =
  | "unmigrated"
  | "unreadableVersions"
  | "catalog"
  | "duplicateLatest"
  | "unpushed"
  | "contamination";

/**
 * The one JSON document `doctor datastores --repair --json` prints. Each v2
 * repair stage's json renderer records its result object under the stage's
 * key, and the command prints the report once; a stage that did not run is
 * null. Printing per stage gave several documents back to back
 * (swamp-club#4011).
 */
export class DatastoreRepairJsonReport {
  readonly #stages: Record<
    DatastoreRepairStage,
    Record<string, unknown> | null
  > = {
    unmigrated: null,
    unreadableVersions: null,
    catalog: null,
    duplicateLatest: null,
    unpushed: null,
    contamination: null,
  };

  readonly #warnings: string[] = [];

  record(stage: DatastoreRepairStage, result: Record<string, unknown>): void {
    this.#stages[stage] = result;
  }

  /**
   * A warning about the run rather than a stage. The logger is silent under
   * --json, so this is the only place such a warning reaches a script.
   */
  warn(message: string): void {
    this.#warnings.push(message);
  }

  print(): void {
    console.log(JSON.stringify(
      {
        ...this.#stages,
        ...(this.#warnings.length > 0 ? { warnings: this.#warnings } : {}),
      },
      null,
      2,
    ));
  }
}

// ============================================================================
// Repair renderer
// ============================================================================

export type RepairDatastoresStatus = "pass" | "fail" | "preview";

export interface RepairDatastoresRenderer {
  handlers(): EventHandlers<RepairDatastoresEvent>;
  readonly overallStatus: RepairDatastoresStatus;
}

class LogRepairDatastoresRenderer implements RepairDatastoresRenderer {
  overallStatus: RepairDatastoresStatus = "pass";

  handlers(): EventHandlers<RepairDatastoresEvent> {
    return {
      scanning: () => {
        writeOutput(dim("Scanning for namespace contamination…"));
      },
      preview: (e) => {
        this.overallStatus = "preview";
        writeOutput(`\n${bold("Namespace contamination cleanup:")}`);
        for (const ns of e.contamination.foreignNamespaces) {
          writeOutput(
            `  Delete ${ns.objectCount.toLocaleString()} objects under ${e.namespace}/${ns.namespace}/`,
          );
        }
        writeOutput(
          `  Rebuild ${e.namespace}/.datastore-index.json from remaining objects`,
        );
        writeOutput(
          `  Wipe local cache and re-pull (scoped to ${e.namespace}/)`,
        );
        writeOutput(
          `  Invalidate workflow run indexes (forces rebuild from YAML files)`,
        );
        writeOutput(
          `  Invalidate data catalog (will rebuild on next access)`,
        );
        writeOutput(
          dim("\n  Run with -y to proceed."),
        );
      },
      step: (e) => {
        writeOutput(
          `  ${dim(`[${e.step}/${e.total}]`)} ${e.description}`,
        );
      },
      completed: (e) => {
        this.overallStatus = "pass";
        const { result } = e;
        writeOutput(
          `\n${green("✓")} ${bold("Namespace repair complete:")}`,
        );
        writeOutput(
          `  Deleted ${result.deletedObjects.toLocaleString()} foreign objects`,
        );
        writeOutput(
          `  Re-pulled ${result.filesPulled.toLocaleString()} files (scoped to ${e.namespace}/)`,
        );
        if (result.workflowRunIndexesInvalidated > 0) {
          writeOutput(
            `  Workflow run indexes invalidated (will rebuild on next query)`,
          );
        }
        if (result.catalogInvalidated) {
          writeOutput(
            `  Data catalog invalidated (will rebuild on next access)`,
          );
        }
        writeOutput(
          dim(
            "\n  Verify: swamp workflow run search --since 30d\n" +
              "  Verify: swamp workflow approvals",
          ),
        );
      },
      not_needed: () => {
        this.overallStatus = "pass";
        writeOutput(
          `${green("✓")} No namespace contamination found — nothing to repair.`,
        );
      },
      error: (e) => {
        this.overallStatus = "fail";
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonRepairDatastoresRenderer implements RepairDatastoresRenderer {
  overallStatus: RepairDatastoresStatus = "pass";

  readonly #report: DatastoreRepairJsonReport;

  constructor(report: DatastoreRepairJsonReport) {
    this.#report = report;
  }
  #steps: Array<{ step: number; total: number; description: string }> = [];

  handlers(): EventHandlers<RepairDatastoresEvent> {
    return {
      scanning: () => {},
      preview: (e) => {
        this.overallStatus = "preview";
        this.#report.record("contamination", {
          status: "preview",
          namespace: e.namespace,
          contamination: e.contamination,
        });
      },
      step: (e) => {
        this.#steps.push({
          step: e.step,
          total: e.total,
          description: e.description,
        });
      },
      completed: (e) => {
        this.overallStatus = "pass";
        this.#report.record("contamination", {
          status: "completed",
          namespace: e.namespace,
          result: e.result,
          steps: this.#steps,
        });
      },
      not_needed: () => {
        this.overallStatus = "pass";
        this.#report.record("contamination", { status: "not_needed" });
      },
      error: (e) => {
        this.overallStatus = "fail";
        this.#report.record("contamination", {
          status: e.error.code,
          message: e.error.message,
        });
        throw new UserError(e.error.message, e.error.code);
      },
    };
  }
}

export function createRepairDatastoresRenderer(
  mode: OutputMode,
  report: DatastoreRepairJsonReport,
): RepairDatastoresRenderer {
  switch (mode) {
    case "json":
      return new JsonRepairDatastoresRenderer(report);
    case "log":
      return new LogRepairDatastoresRenderer();
  }
}

// ============================================================================
// Unpushed cache files repair renderer (swamp-club#4112)
// ============================================================================

export type UnpushedFilesRepairStatus =
  | "pass"
  | "fail"
  | "preview"
  | "not_supported";

export interface UnpushedFilesRepairRenderer {
  handlers(): EventHandlers<RepairUnpushedFilesEvent>;
  readonly overallStatus: UnpushedFilesRepairStatus;
}

/** A repair that left files it should have uploaded failed. */
function repairedStatus(
  summary: UnpushedFilesSummary,
): UnpushedFilesRepairStatus {
  return summary.unpushed > 0 ? "fail" : "pass";
}

class LogUnpushedFilesRepairRenderer implements UnpushedFilesRepairRenderer {
  overallStatus: UnpushedFilesRepairStatus = "pass";

  handlers(): EventHandlers<RepairUnpushedFilesEvent> {
    return {
      scanning: () => {
        writeOutput(dim("Scanning for cache files the remote never received…"));
      },
      preview: (e) => {
        this.overallStatus = "preview";
        writeOutput(`\n${bold("Unpushed cache files:")}`);
        writeOutput(unpushedFilesDetailLines(e.summary).join("\n"));
        if (e.summary.unpushed > 0) {
          writeOutput(
            dim(
              `\n  Run with -y to upload them. Uploads only create files the remote lacks; nothing is deleted. ${PEER_DELETED_LOOKS_UNPUSHED}, so check these first.`,
            ),
          );
        }
      },
      step: (e) => {
        writeOutput(`  ${e.description}`);
      },
      completed: (e) => {
        this.overallStatus = repairedStatus(e.summary);
        writeOutput(
          this.overallStatus === "pass"
            ? `\n${green("✓")} ${bold("Unpushed cache files repair complete:")}`
            : `\n${red("✗")} ${
              bold("Unpushed cache files repair incomplete:")
            }`,
        );
        writeOutput(
          `  Uploaded ${e.summary.uploaded.toLocaleString()} file(s)`,
        );
        const details = unpushedFilesDetailLines(e.summary);
        if (details.length > 0) writeOutput(details.join("\n"));
        if (e.summary.uploaded > 0) {
          writeOutput(dim(`\n  ${PEER_DELETED_LOOKS_UNPUSHED}.`));
        }
        if (e.summary.unpushed > 0) {
          writeOutput(
            dim(
              `\n  ${UNINDEXABLE_ADVICE}`,
            ),
          );
        }
      },
      not_needed: () => {
        this.overallStatus = "pass";
        writeOutput(dim("No cache files the remote never received."));
      },
      not_supported: (e) => {
        this.overallStatus = "not_supported";
        writeOutput(`${yellow("⚠")} ${e.message}`);
      },
      error: (e) => {
        this.overallStatus = "fail";
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonUnpushedFilesRepairRenderer implements UnpushedFilesRepairRenderer {
  overallStatus: UnpushedFilesRepairStatus = "pass";

  readonly #report: DatastoreRepairJsonReport;

  constructor(report: DatastoreRepairJsonReport) {
    this.#report = report;
  }

  handlers(): EventHandlers<RepairUnpushedFilesEvent> {
    return {
      scanning: () => {},
      preview: (e) => {
        this.overallStatus = "preview";
        this.#report.record("unpushed", {
          status: "unpushed_preview",
          summary: e.summary,
          ...(e.summary.unpushed > 0
            ? { warning: `${PEER_DELETED_LOOKS_UNPUSHED}.` }
            : {}),
        });
      },
      step: () => {},
      completed: (e) => {
        this.overallStatus = repairedStatus(e.summary);
        this.#report.record("unpushed", {
          status: this.overallStatus === "pass"
            ? "unpushed_completed"
            : "unpushed_incomplete",
          summary: e.summary,
          ...(this.overallStatus === "fail"
            ? { advice: UNINDEXABLE_ADVICE }
            : {}),
          ...(e.summary.uploaded > 0
            ? { warning: `${PEER_DELETED_LOOKS_UNPUSHED}.` }
            : {}),
        });
      },
      not_needed: () => {
        this.overallStatus = "pass";
        this.#report.record("unpushed", { status: "unpushed_not_needed" });
      },
      not_supported: (e) => {
        this.overallStatus = "not_supported";
        this.#report.record("unpushed", {
          status: "unpushed_not_supported",
          message: e.message,
        });
      },
      error: (e) => {
        this.overallStatus = "fail";
        this.#report.record("unpushed", {
          status: "unpushed_failed",
          message: e.error.message,
        });
        throw new UserError(e.error.message, e.error.code);
      },
    };
  }
}

/**
 * Shows a preview's failed unpushed files check in log mode. The json report
 * records it already, and the contamination preview follows it.
 */
export function renderUnpushedFilesCheckFailure(
  mode: OutputMode,
  message: string,
): void {
  if (mode === "log") writeOutput(`${red("✗")} ${message}`);
}

export function createUnpushedFilesRepairRenderer(
  mode: OutputMode,
  report: DatastoreRepairJsonReport,
): UnpushedFilesRepairRenderer {
  switch (mode) {
    case "json":
      return new JsonUnpushedFilesRepairRenderer(report);
    case "log":
      return new LogUnpushedFilesRepairRenderer();
  }
}

// ============================================================================
// Unmigrated data repair renderer
// ============================================================================

export type UnmigratedDataRepairStatus = "pass" | "fail" | "preview";

export interface UnmigratedDataRepairRenderer {
  handlers(): EventHandlers<RepairUnmigratedDataEvent>;
  readonly overallStatus: UnmigratedDataRepairStatus;
}

class LogUnmigratedDataRepairRenderer implements UnmigratedDataRepairRenderer {
  overallStatus: UnmigratedDataRepairStatus = "pass";

  handlers(): EventHandlers<RepairUnmigratedDataEvent> {
    return {
      scanning: () => {
        writeOutput(dim("Scanning for root-level unmigrated data…"));
      },
      preview: (e) => {
        this.overallStatus = "preview";
        writeOutput(`\n${bold("Root-level unmigrated data cleanup:")}`);
        for (const dir of e.directories) {
          writeOutput(
            `  Remove ${dir}/ (duplicate of ${e.namespace}/${dir}/)`,
          );
        }
        writeOutput(dim("\n  Run with -y to proceed."));
      },
      step: (e) => {
        writeOutput(`  ${e.description}`);
      },
      completed: (e) => {
        this.overallStatus = "pass";
        const { result } = e;
        writeOutput(
          `\n${green("✓")} ${bold("Unmigrated data cleanup complete:")}`,
        );
        writeOutput(
          `  Removed ${result.removedFiles} duplicate file(s) from ${
            result.removedDirectories.join(", ")
          }`,
        );
      },
      not_needed: () => {
        this.overallStatus = "pass";
        writeOutput(
          dim("No root-level unmigrated data found."),
        );
      },
      error: (e) => {
        this.overallStatus = "fail";
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonUnmigratedDataRepairRenderer implements UnmigratedDataRepairRenderer {
  overallStatus: UnmigratedDataRepairStatus = "pass";

  readonly #report: DatastoreRepairJsonReport;

  constructor(report: DatastoreRepairJsonReport) {
    this.#report = report;
  }

  handlers(): EventHandlers<RepairUnmigratedDataEvent> {
    return {
      scanning: () => {},
      preview: (e) => {
        this.overallStatus = "preview";
        this.#report.record("unmigrated", {
          status: "unmigrated_preview",
          namespace: e.namespace,
          directories: e.directories,
        });
      },
      step: () => {},
      completed: (e) => {
        this.overallStatus = "pass";
        this.#report.record("unmigrated", {
          status: "unmigrated_completed",
          namespace: e.namespace,
          result: e.result,
        });
      },
      not_needed: () => {
        this.overallStatus = "pass";
        this.#report.record("unmigrated", { status: "unmigrated_not_needed" });
      },
      error: (e) => {
        this.overallStatus = "fail";
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createUnmigratedDataRepairRenderer(
  mode: OutputMode,
  report: DatastoreRepairJsonReport,
): UnmigratedDataRepairRenderer {
  switch (mode) {
    case "json":
      return new JsonUnmigratedDataRepairRenderer(report);
    case "log":
      return new LogUnmigratedDataRepairRenderer();
  }
}

// ============================================================================
// Unreadable data versions repair renderer (swamp-club#3955)
// ============================================================================

export type UnreadableVersionsRepairStatus = "pass" | "fail" | "preview";

export interface UnreadableVersionsRepairRenderer {
  handlers(): EventHandlers<RepairUnreadableVersionsEvent>;
  readonly overallStatus: UnreadableVersionsRepairStatus;
}

/** One record's line: what goes, and what is latest after. */
function unreadableRecordLine(
  record: UnreadableRecordRepair,
  verb: { remove: string; reset: string },
): string {
  const name = bold(`${record.modelName || record.modelId}/${record.dataName}`);
  const parts: string[] = [];
  if (record.removeVersions.length > 0) {
    parts.push(
      `${verb.remove} version(s) ${record.removeVersions.join(", ")}`,
    );
  }
  if (record.becomesLatest !== null) {
    parts.push(`version ${record.becomesLatest} is latest`);
  } else if (record.removeVersions.length > 0 && record.removed === false) {
    parts.push(
      "no readable version is left, so the record reads as absent",
    );
  } else if (record.removeVersions.length > 0) {
    parts.push("no readable version is left, so the record is removed");
  } else {
    parts.push("no readable version, so its marker is left as it is");
  }
  if (
    record.markerUnreadable && record.removeVersions.length === 0 &&
    record.becomesLatest !== null
  ) {
    parts.unshift(verb.reset);
  }
  return `  ${name}: ${parts.join("; ")}`;
}

class LogUnreadableVersionsRepairRenderer
  implements UnreadableVersionsRepairRenderer {
  overallStatus: UnreadableVersionsRepairStatus = "pass";

  handlers(): EventHandlers<RepairUnreadableVersionsEvent> {
    return {
      scanning: () => {
        writeOutput(dim("Scanning for unreadable data versions…"));
      },
      preview: (e) => {
        this.overallStatus = "preview";
        writeOutput(`\n${bold("Unreadable data versions rollback:")}`);
        for (const record of e.records) {
          writeOutput(
            unreadableRecordLine(record, {
              remove: "remove",
              reset: "rewrite its latest marker",
            }),
          );
        }
        writeOutput(
          dim(
            "\n  Only versions whose content is already unreadable are removed.",
          ),
        );
        writeOutput(dim("\n  Run with -y to proceed."));
      },
      step: (e) => {
        writeOutput(`  ${e.description}`);
      },
      completed: (e) => {
        this.overallStatus = "pass";
        const { result } = e;
        writeOutput(
          `\n${green("✓")} ${bold("Unreadable data versions rolled back:")}`,
        );
        for (const record of result.records) {
          writeOutput(
            unreadableRecordLine(record, {
              remove: "removed",
              reset: "rewrote its latest marker",
            }),
          );
        }
        writeOutput(
          `  Removed ${result.versionsRemoved} version(s); ${result.recordsRemoved} record(s) had no readable version left`,
        );
        if (result.versionsKept > 0) {
          writeOutput(
            dim(
              `  Kept ${result.versionsKept} version(s) that were readable again by the time the repair ran`,
            ),
          );
        }
      },
      not_needed: () => {
        this.overallStatus = "pass";
        writeOutput(dim("Every published data version is readable."));
      },
      error: (e) => {
        this.overallStatus = "fail";
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonUnreadableVersionsRepairRenderer
  implements UnreadableVersionsRepairRenderer {
  overallStatus: UnreadableVersionsRepairStatus = "pass";

  readonly #report: DatastoreRepairJsonReport;

  constructor(report: DatastoreRepairJsonReport) {
    this.#report = report;
  }

  handlers(): EventHandlers<RepairUnreadableVersionsEvent> {
    return {
      scanning: () => {},
      preview: (e) => {
        this.overallStatus = "preview";
        this.#report.record("unreadableVersions", {
          status: "unreadable_versions_preview",
          records: e.records,
        });
      },
      step: () => {},
      completed: (e) => {
        this.overallStatus = "pass";
        this.#report.record("unreadableVersions", {
          status: "unreadable_versions_completed",
          result: e.result,
        });
      },
      not_needed: () => {
        this.overallStatus = "pass";
        this.#report.record("unreadableVersions", {
          status: "unreadable_versions_not_needed",
        });
      },
      error: (e) => {
        this.overallStatus = "fail";
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createUnreadableVersionsRepairRenderer(
  mode: OutputMode,
  report: DatastoreRepairJsonReport,
): UnreadableVersionsRepairRenderer {
  switch (mode) {
    case "json":
      return new JsonUnreadableVersionsRepairRenderer(report);
    case "log":
      return new LogUnreadableVersionsRepairRenderer();
  }
}

// ============================================================================
// Catalog index repair renderer
// ============================================================================

export type CatalogIndexRepairStatus = "pass" | "fail" | "preview";

export interface CatalogIndexRepairRenderer {
  handlers(): EventHandlers<RepairCatalogIndexEvent>;
  readonly overallStatus: CatalogIndexRepairStatus;
}

/** Shown after any repair that drops the catalog database. */
const FOREIGN_ROWS_NOTICE =
  "Rebuilding the index also clears rows pulled from other namespaces " +
  "(they describe data that is not on local disk, so the rebuild cannot " +
  "recreate them). Restore them with: swamp datastore catalog pull";

class LogCatalogIndexRepairRenderer implements CatalogIndexRepairRenderer {
  overallStatus: CatalogIndexRepairStatus = "pass";

  handlers(): EventHandlers<RepairCatalogIndexEvent> {
    return {
      scanning: () => {
        writeOutput(dim("Comparing the catalog index against data on disk…"));
      },
      preview: (e) => {
        this.overallStatus = "preview";
        const { completeness } = e;
        writeOutput(`\n${bold("Catalog index rebuild:")}`);
        for (const s of completeness.shortfalls) {
          writeOutput(
            `  ${s.typeNormalized}: index ${s.catalogRecords.toLocaleString()} of ${s.diskRecords.toLocaleString()} record(s) on disk`,
          );
        }
        writeOutput(
          `  Remove the catalog index (rebuilds on the next data query)`,
        );
        writeOutput(dim(`\n  ${FOREIGN_ROWS_NOTICE}`));
        writeOutput(dim("\n  Run with -y to proceed."));
      },
      step: (e) => {
        writeOutput(`  ${e.description}`);
      },
      completed: (e) => {
        this.overallStatus = "pass";
        writeOutput(
          `\n${green("✓")} ${
            bold("Catalog index invalidated — will rebuild on next query:")
          }`,
        );
        writeOutput(
          `  ${e.result.missingRecords.toLocaleString()} missing record(s) across ${e.result.shortfalls.length} behavior type(s) will be re-indexed on the next data query`,
        );
        writeOutput(dim(`\n  ${FOREIGN_ROWS_NOTICE}`));
      },
      not_needed: () => {
        this.overallStatus = "pass";
        writeOutput(dim("Catalog index matches data on disk."));
      },
      error: (e) => {
        this.overallStatus = "fail";
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonCatalogIndexRepairRenderer implements CatalogIndexRepairRenderer {
  overallStatus: CatalogIndexRepairStatus = "pass";

  readonly #report: DatastoreRepairJsonReport;

  constructor(report: DatastoreRepairJsonReport) {
    this.#report = report;
  }

  handlers(): EventHandlers<RepairCatalogIndexEvent> {
    return {
      scanning: () => {},
      preview: (e) => {
        this.overallStatus = "preview";
        this.#report.record("catalog", {
          status: "catalog_preview",
          completeness: e.completeness,
          foreignRowsNotice: FOREIGN_ROWS_NOTICE,
        });
      },
      step: () => {},
      completed: (e) => {
        this.overallStatus = "pass";
        this.#report.record("catalog", {
          status: "catalog_completed",
          result: e.result,
          foreignRowsNotice: FOREIGN_ROWS_NOTICE,
        });
      },
      not_needed: () => {
        this.overallStatus = "pass";
        this.#report.record("catalog", { status: "catalog_not_needed" });
      },
      error: (e) => {
        this.overallStatus = "fail";
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createCatalogIndexRepairRenderer(
  mode: OutputMode,
  report: DatastoreRepairJsonReport,
): CatalogIndexRepairRenderer {
  switch (mode) {
    case "json":
      return new JsonCatalogIndexRepairRenderer(report);
    case "log":
      return new LogCatalogIndexRepairRenderer();
  }
}

// ============================================================================
// Catalog duplicate is_latest repair
// ============================================================================

export type CatalogDuplicateLatestRepairStatus = "pass" | "fail" | "preview";

export interface CatalogDuplicateLatestRepairRenderer {
  handlers(): EventHandlers<RepairCatalogDuplicateLatestEvent>;
  readonly overallStatus: CatalogDuplicateLatestRepairStatus;
}

class LogCatalogDuplicateLatestRepairRenderer
  implements CatalogDuplicateLatestRepairRenderer {
  overallStatus: CatalogDuplicateLatestRepairStatus = "pass";

  handlers(): EventHandlers<RepairCatalogDuplicateLatestEvent> {
    return {
      scanning: () => {
        writeOutput(
          dim("Checking catalog for duplicate is_latest flags…"),
        );
      },
      preview: (e) => {
        this.overallStatus = "preview";
        writeOutput(`\n${bold("Duplicate is_latest flags:")}`);
        writeOutput(
          `  ${e.duplicateCount} record group(s) have conflicting latest-version flags`,
        );
        writeOutput(dim("\n  Run with -y to repair."));
      },
      step: (e) => {
        writeOutput(`  ${e.description}`);
      },
      completed: (e) => {
        this.overallStatus = "pass";
        writeOutput(
          `\n${green("✓")} ${bold("Duplicate is_latest flags repaired:")}`,
        );
        writeOutput(
          `  Corrected the latest flags on ${e.result.demotedRows} row(s)`,
        );
      },
      not_needed: () => {
        this.overallStatus = "pass";
        writeOutput(dim("No duplicate is_latest flags found."));
      },
      error: (e) => {
        this.overallStatus = "fail";
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonCatalogDuplicateLatestRepairRenderer
  implements CatalogDuplicateLatestRepairRenderer {
  overallStatus: CatalogDuplicateLatestRepairStatus = "pass";

  readonly #report: DatastoreRepairJsonReport;

  constructor(report: DatastoreRepairJsonReport) {
    this.#report = report;
  }

  handlers(): EventHandlers<RepairCatalogDuplicateLatestEvent> {
    return {
      scanning: () => {},
      preview: (e) => {
        this.overallStatus = "preview";
        this.#report.record("duplicateLatest", {
          status: "duplicate_latest_preview",
          duplicateCount: e.duplicateCount,
        });
      },
      step: () => {},
      completed: (e) => {
        this.overallStatus = "pass";
        this.#report.record("duplicateLatest", {
          status: "duplicate_latest_completed",
          result: e.result,
        });
      },
      not_needed: () => {
        this.overallStatus = "pass";
        this.#report.record("duplicateLatest", {
          status: "duplicate_latest_not_needed",
        });
      },
      error: (e) => {
        this.overallStatus = "fail";
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createCatalogDuplicateLatestRepairRenderer(
  mode: OutputMode,
  report: DatastoreRepairJsonReport,
): CatalogDuplicateLatestRepairRenderer {
  switch (mode) {
    case "json":
      return new JsonCatalogDuplicateLatestRepairRenderer(report);
    case "log":
      return new LogCatalogDuplicateLatestRepairRenderer();
  }
}

// ============================================================================
// Repair: a v3 datastore's lost format marker (swamp-club#3617)
// ============================================================================

export type DatastoreFormatMarkerRepairStatus = "pass" | "fail" | "preview";

export interface DatastoreFormatMarkerRepairRenderer {
  handlers(): EventHandlers<RepairDatastoreFormatMarkerEvent>;
  readonly overallStatus: DatastoreFormatMarkerRepairStatus;
}

function lostMarkerDescription(marker: "absent" | "blank"): string {
  return marker === "absent" ? "is missing" : "is blank";
}

class LogDatastoreFormatMarkerRepairRenderer
  implements DatastoreFormatMarkerRepairRenderer {
  overallStatus: DatastoreFormatMarkerRepairStatus = "pass";

  handlers(): EventHandlers<RepairDatastoreFormatMarkerEvent> {
    return {
      inspecting: () => {
        writeOutput(dim("Checking the v3 datastore's format marker…"));
      },
      preview: (e) => {
        this.overallStatus = "preview";
        writeOutput(`\n${bold("Lost datastore format marker:")}`);
        writeOutput(
          `  ${e.data.markerPath} ${
            lostMarkerDescription(e.data.marker)
          }, beside the v3 commit log of ${e.data.datastorePath}`,
        );
        writeOutput(dim("\n  Run with -y to restore it."));
      },
      completed: (e) => {
        this.overallStatus = "pass";
        writeOutput(
          `\n${green("✓")} ${bold("Datastore format marker restored:")}`,
        );
        writeOutput(`  Wrote ${e.data.markerPath} (format 3)`);
        writeOutput(
          dim("\n  Run `swamp doctor datastores` to check the datastore."),
        );
      },
      not_needed: (e) => {
        this.overallStatus = "pass";
        writeOutput(
          dim(`The format marker of ${e.datastorePath} is not lost.`),
        );
      },
      error: (e) => {
        this.overallStatus = "fail";
        throw new UserError(e.error.message, e.error.code);
      },
    };
  }
}

class JsonDatastoreFormatMarkerRepairRenderer
  implements DatastoreFormatMarkerRepairRenderer {
  overallStatus: DatastoreFormatMarkerRepairStatus = "pass";

  handlers(): EventHandlers<RepairDatastoreFormatMarkerEvent> {
    return {
      inspecting: () => {},
      preview: (e) => {
        this.overallStatus = "preview";
        console.log(
          JSON.stringify(
            { status: "format_marker_preview", ...e.data },
            null,
            2,
          ),
        );
      },
      completed: (e) => {
        this.overallStatus = "pass";
        console.log(
          JSON.stringify(
            { status: "format_marker_restored", ...e.data },
            null,
            2,
          ),
        );
      },
      not_needed: (e) => {
        this.overallStatus = "pass";
        console.log(
          JSON.stringify(
            {
              status: "format_marker_not_needed",
              datastorePath: e.datastorePath,
            },
            null,
            2,
          ),
        );
      },
      error: (e) => {
        this.overallStatus = "fail";
        throw new UserError(e.error.message, e.error.code);
      },
    };
  }
}

export function createDatastoreFormatMarkerRepairRenderer(
  mode: OutputMode,
): DatastoreFormatMarkerRepairRenderer {
  switch (mode) {
    case "json":
      return new JsonDatastoreFormatMarkerRepairRenderer();
    case "log":
      return new LogDatastoreFormatMarkerRepairRenderer();
  }
}

export type PreV3RecordsRepairStatus = "pass" | "fail" | "preview";

export interface PreV3RecordsRepairRenderer {
  handlers(): EventHandlers<RepairPreV3RecordsEvent>;
  readonly overallStatus: PreV3RecordsRepairStatus;
}

class LogPreV3RecordsRepairRenderer implements PreV3RecordsRepairRenderer {
  overallStatus: PreV3RecordsRepairStatus = "pass";

  handlers(): EventHandlers<RepairPreV3RecordsEvent> {
    return {
      inspecting: () => {
        writeOutput(dim("Checking this checkout for records from before v3…"));
      },
      preview: (e) => {
        this.overallStatus = "preview";
        writeOutput(`\n${bold("Records from before v3 in this checkout:")}`);
        for (const dir of e.data.recordDirs) {
          writeOutput(`  ${join(e.data.swampDir, dir)}`);
        }
        writeOutput(
          `\n  A v3 datastore starts empty, so this checkout cannot join it while it holds them. They would be moved into a new directory under ${e.data.preV3RecordsDir}. Moved records are not in the v3 datastore.`,
        );
        writeOutput(dim("\n  Run with -y to move them aside."));
      },
      completed: (e) => {
        this.overallStatus = "pass";
        writeOutput(
          `\n${green("✓")} ${bold("Records from before v3 moved aside:")}`,
        );
        for (const dir of e.data.recordDirs) {
          writeOutput(`  ${dir}`);
        }
        writeOutput(`  into ${e.data.destination}`);
        writeOutput(
          dim(
            "\n  They are not in the v3 datastore. The next command catches this checkout up from it.",
          ),
        );
      },
      not_needed: (e) => {
        this.overallStatus = "pass";
        writeOutput(
          dim(`${e.swampDir} holds no records from before v3.`),
        );
      },
      error: (e) => {
        this.overallStatus = "fail";
        throw new UserError(e.error.message, e.error.code);
      },
    };
  }
}

class JsonPreV3RecordsRepairRenderer implements PreV3RecordsRepairRenderer {
  overallStatus: PreV3RecordsRepairStatus = "pass";

  handlers(): EventHandlers<RepairPreV3RecordsEvent> {
    return {
      inspecting: () => {},
      preview: (e) => {
        this.overallStatus = "preview";
        console.log(
          JSON.stringify(
            { status: "pre_v3_records_preview", ...e.data },
            null,
            2,
          ),
        );
      },
      completed: (e) => {
        this.overallStatus = "pass";
        console.log(
          JSON.stringify(
            { status: "pre_v3_records_moved", ...e.data },
            null,
            2,
          ),
        );
      },
      not_needed: (e) => {
        this.overallStatus = "pass";
        console.log(
          JSON.stringify(
            { status: "pre_v3_records_not_needed", swampDir: e.swampDir },
            null,
            2,
          ),
        );
      },
      error: (e) => {
        this.overallStatus = "fail";
        throw new UserError(e.error.message, e.error.code);
      },
    };
  }
}

export function createPreV3RecordsRepairRenderer(
  mode: OutputMode,
): PreV3RecordsRepairRenderer {
  switch (mode) {
    case "json":
      return new JsonPreV3RecordsRepairRenderer();
    case "log":
      return new LogPreV3RecordsRepairRenderer();
  }
}
