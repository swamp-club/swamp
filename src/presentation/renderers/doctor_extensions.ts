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

import { bold, cyan, dim, green, red, yellow } from "@std/fmt/colors";
import {
  DOCTOR_REGISTRY_ORDER,
  type DoctorAggregateReport,
  type DoctorExtensionsEvent,
  type DoctorOverallStatus,
  type DoctorRegistryName,
  type DoctorRegistryResult,
  type EventHandlers,
  type RepairReport,
  ROW_STATE_TAGS,
} from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "../output/output.ts";

/**
 * Renderer for `swamp doctor extensions`. Receives exactly five
 * `kind-completed` events (one per registry) and renders each row
 * verbatim — the model/extension fold has already happened in the
 * service. The renderer never imports the infrastructure-layer
 * `ExtensionKind` enum.
 *
 * Exposes `overallStatus` so the CLI can exit non-zero on a failing
 * report.
 */
export interface DoctorExtensionsRenderer {
  handlers(): EventHandlers<DoctorExtensionsEvent>;
  readonly overallStatus: DoctorOverallStatus;
}

export interface DoctorExtensionsRendererOptions {
  verbose?: boolean;
}

function iconFor(status: DoctorRegistryResult["status"]): string {
  switch (status) {
    case "pass":
      return green("✓");
    case "fail":
      return red("✗");
  }
}

function summaryLine(status: DoctorOverallStatus): string {
  switch (status) {
    case "pass":
      return green(bold("OVERALL: PASS"));
    case "fail":
      return red(bold("OVERALL: FAIL"));
  }
}

function stateColor(tag: string): (s: string) => string {
  switch (tag) {
    case "Indexed":
      return green;
    case "Bundled":
      return cyan;
    case "Tombstoned":
      return dim;
    case "BundleBuildFailed":
    case "ValidationFailed":
    case "EntryPointUnreadable":
      return red;
    case "OrphanedBundleOnly":
      return yellow;
    default:
      return dim;
  }
}

function renderAggregateStateLog(
  report: DoctorAggregateReport,
  verbose: boolean,
): void {
  writeOutput(`\n${bold(cyan("Extension Catalog State"))}`);
  writeOutput(
    dim(
      `  ${report.totalSources} total source(s) across ${report.aggregates.length} extension(s), ` +
        `${report.healthySources} healthy (Indexed)`,
    ),
  );
  if (report.orphanRowCount > 0 || report.orphanBundleFileCount > 0) {
    writeOutput(
      yellow(
        `  ${report.orphanRowCount} orphan row(s), ${report.orphanBundleFileCount} orphan bundle file(s)`,
      ),
    );
  }

  writeOutput("");
  for (const agg of report.aggregates) {
    const originTag = dim(`[${agg.origin}]`);
    writeOutput(
      `  ${bold(agg.name)}${dim("@")}${agg.version} ${originTag}  ${
        dim(`${agg.sourceCount} source(s)`)
      }`,
    );

    // State distribution — only show non-zero counts.
    const parts: string[] = [];
    for (const tag of ROW_STATE_TAGS) {
      const count = agg.stateDistribution[tag];
      if (count > 0) {
        parts.push(stateColor(tag)(`${tag}: ${count}`));
      }
    }
    if (parts.length > 0) {
      writeOutput(`    ${parts.join(dim(" | "))}`);
    }
  }

  if (verbose && report.sourceDetails.length > 0) {
    writeOutput(`\n${bold(cyan("Per-Source Detail"))}`);
    for (const detail of report.sourceDetails) {
      const colorFn = stateColor(detail.stateTag);
      const fp = detail.fingerprint
        ? dim(` fp:${detail.fingerprint.slice(0, 12)}`)
        : "";
      const bp = detail.bundlePath ? dim(` bundle:${detail.bundlePath}`) : "";
      const le = detail.lastError ? dim(`: ${detail.lastError}`) : "";
      writeOutput(
        `  ${dim(detail.kind)} ${detail.sourcePath}  ${
          colorFn(detail.stateTag)
        }${le}${fp}${bp}`,
      );
    }
  }

  if (report.catalogOrphans.length > 0) {
    writeOutput(
      `\n${yellow("⚠")} ${bold("Catalog orphans")} ${
        dim("(source missing on disk)")
      }`,
    );
    for (const orphan of report.catalogOrphans) {
      writeOutput(
        `  ${yellow("•")} ${orphan.sourcePath}  ${
          dim(`[${orphan.extensionName}]`)
        } ${red(orphan.stateTag)}`,
      );
    }
  }

  if (report.bundleOrphans.length > 0) {
    writeOutput(
      `\n${yellow("⚠")} ${bold("Bundle orphans")} ${
        dim("(not referenced by catalog)")
      }`,
    );
    for (const orphan of report.bundleOrphans) {
      writeOutput(
        `  ${yellow("•")} ${orphan.repoRelativePath}  ${
          dim(`[${orphan.bundleDir}]`)
        }`,
      );
    }
  }
}

function renderRepairLog(report: RepairReport): void {
  const modeLabel = report.mode === "dry-run"
    ? yellow(bold("DRY RUN"))
    : green(bold("APPLIED"));
  writeOutput(`\n${bold(cyan("Repair"))} ${modeLabel}`);

  if (report.operations.length === 0) {
    writeOutput(dim("  Nothing to clean up — catalog is healthy."));
    return;
  }

  const pastTense = report.mode === "applied";
  const parts = [
    `${report.prunedRowCount} catalog row(s) ${
      pastTense ? "pruned" : "to prune"
    }`,
    `${report.evictedFileCount} bundle file(s) ${
      pastTense ? "evicted" : "to evict"
    }`,
  ];
  if (report.repulledExtensionCount > 0) {
    parts.push(
      `${report.repulledExtensionCount} extension(s) ${
        pastTense ? "re-pulled" : "to re-pull"
      }`,
    );
  }
  writeOutput(`  ${parts.join(", ")}`);
  writeOutput("");

  for (const op of report.operations) {
    const icon =
      op.kind === "catalog-row-pruned" || op.kind === "unreachable-row-pruned"
        ? "x"
        : op.kind === "pulled-extension-repulled"
        ? "+"
        : "-";
    const label =
      op.kind === "catalog-row-pruned" || op.kind === "unreachable-row-pruned"
        ? dim("[row]")
        : op.kind === "pulled-extension-repulled"
        ? dim("[pull]")
        : dim("[file]");
    writeOutput(`  ${icon} ${label} ${op.path}`);
    writeOutput(`     ${dim(op.reason)}`);
  }

  if (report.mode === "dry-run") {
    writeOutput(
      dim(
        "\n  Run with --repair (without --dry-run) to perform these operations.",
      ),
    );
  }
}

class LogDoctorExtensionsRenderer implements DoctorExtensionsRenderer {
  overallStatus: DoctorOverallStatus = "pass";
  private readonly verbose: boolean;

  constructor(options: DoctorExtensionsRendererOptions) {
    this.verbose = options.verbose ?? false;
  }

  handlers(): EventHandlers<DoctorExtensionsEvent> {
    return {
      "kind-started": () => {
        // No-op. ensureLoaded() runs fast enough that an in-progress
        // line is visual noise — users see the ✓/✗ on kind-completed.
      },
      "kind-completed": (e) => {
        // Don't render status icon during scan — the per-registry result
        // always reports "pass" at this point because loader errors are
        // only folded into the final results. Instead, just show the
        // registry name; the completed handler re-renders each row with
        // its correct icon from e.report.registries.
        writeOutput(`  ${dim("•")} ${e.result.registry}`);
      },
      completed: (e) => {
        this.overallStatus = e.report.overallStatus;

        // Re-render each registry row with its correct status icon.
        writeOutput("");
        for (const name of DOCTOR_REGISTRY_ORDER) {
          const reg = e.report.registries[name];
          writeOutput(`${iconFor(reg.status)} ${bold(reg.registry)}`);
        }

        if (e.report.loaderErrors && e.report.loaderErrors.size > 0) {
          writeOutput("");
          for (const [registry, message] of e.report.loaderErrors) {
            writeOutput(
              `    ${red("•")} ${registry} loader error: ${message}`,
            );
          }
        }

        if (e.report.aggregateState) {
          const failureDetails = e.report.aggregateState.sourceDetails.filter(
            (d) =>
              d.stateTag === "ValidationFailed" ||
              d.stateTag === "BundleBuildFailed" ||
              d.stateTag === "EntryPointUnreadable",
          );
          if (failureDetails.length > 0) {
            writeOutput("");
            for (const detail of failureDetails) {
              const errorSuffix = detail.lastError
                ? `: ${detail.lastError}`
                : "";
              writeOutput(
                `    ${yellow("•")} ${dim(detail.kind)} ${detail.sourcePath} ${
                  red(detail.stateTag)
                }${errorSuffix}`,
              );
            }
          }
        }

        if (e.report.orphanFiles.length > 0) {
          writeOutput(
            `\n${yellow("⚠")} ${
              bold(
                `Found ${e.report.orphanFiles.length} orphan file(s) (warnings, not failures):`,
              )
            }`,
          );
          // Group by extensionName so the user sees which extension
          // each orphan belongs to.
          const byExt = new Map<string, string[]>();
          for (const orphan of e.report.orphanFiles) {
            const list = byExt.get(orphan.extensionName) ?? [];
            list.push(orphan.path);
            byExt.set(orphan.extensionName, list);
          }
          for (const [extName, paths] of byExt) {
            writeOutput(`    ${dim(extName)}`);
            for (const p of paths) {
              writeOutput(`      ${yellow("•")} ${p}`);
            }
          }
          writeOutput(
            dim(
              "    These will be removed on the next " +
                "`swamp extension pull <name> --force` or " +
                "`swamp extension update`.",
            ),
          );
        }

        if (e.report.warnings.length > 0) {
          writeOutput(
            `\n${yellow("⚠")} ${
              bold(
                `${e.report.warnings.length} warning(s) (advisory, not failures):`,
              )
            }`,
          );
          for (const w of e.report.warnings) {
            writeOutput(
              `    ${yellow("•")} ${w.sourcePath}`,
            );
            writeOutput(
              `      ${dim(w.message)}`,
            );
          }
        }

        // W6: Aggregate state rendering.
        if (e.report.aggregateState) {
          renderAggregateStateLog(e.report.aggregateState, this.verbose);
        }

        if (this.verbose && e.report.recentTransitions.length > 0) {
          writeOutput(`\n${bold(cyan("Recent Transitions"))}`);
          for (const t of e.report.recentTransitions) {
            const from = t.fromState
              ? stateColor(t.fromState)(t.fromState)
              : dim("(new)");
            const to = stateColor(t.toState)(t.toState);
            writeOutput(
              `  ${t.source.canonicalPath}  ${from} ${dim("→")} ${to}`,
            );
            writeOutput(`    ${dim(t.reason)}`);
          }
        }

        // W6: Repair report rendering.
        if (e.report.repairReport) {
          renderRepairLog(e.report.repairReport);
        }

        const passCount = Object.values(e.report.registries)
          .filter((r) => r.status === "pass").length;
        const failCount = Object.values(e.report.registries)
          .filter((r) => r.status === "fail").length;
        writeOutput(
          `\n${passCount} passed, ${failCount} failed — ${
            summaryLine(e.report.overallStatus)
          }`,
        );
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonDoctorExtensionsRenderer implements DoctorExtensionsRenderer {
  overallStatus: DoctorOverallStatus = "pass";

  handlers(): EventHandlers<DoctorExtensionsEvent> {
    return {
      "kind-started": () => {
        // No-op — JSON consumers get a single final emit.
      },
      "kind-completed": () => {
        // No-op — per-kind progress is swallowed in JSON mode.
      },
      completed: (e) => {
        this.overallStatus = e.report.overallStatus;
        // Re-build the registries object in DOCTOR_REGISTRY_ORDER so the
        // JSON output has stable key ordering. All five keys are always
        // present even on pass — that's a stability promise to consumers.
        const registries: Record<DoctorRegistryName, DoctorRegistryResult> =
          {} as Record<DoctorRegistryName, DoctorRegistryResult>;
        for (const name of DOCTOR_REGISTRY_ORDER) {
          registries[name] = e.report.registries[name];
        }
        // Build the output object with existing fields first (backward
        // compatible), then W6 additive fields.
        const output: Record<string, unknown> = {
          overallStatus: e.report.overallStatus,
          registries,
          orphanFiles: e.report.orphanFiles,
        };
        if (e.report.aggregateState) {
          output.aggregateState = e.report.aggregateState;
        }
        if (e.report.repairReport) {
          output.repairReport = e.report.repairReport;
        }
        output.loaderErrors = e.report.loaderErrors
          ? Object.fromEntries(e.report.loaderErrors)
          : {};
        output.warnings = e.report.warnings;
        output.recentTransitions = e.report.recentTransitions.map((t) => ({
          sourcePath: t.source.canonicalPath,
          fromState: t.fromState,
          toState: t.toState,
          reason: t.reason,
        }));
        console.log(JSON.stringify(output, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createDoctorExtensionsRenderer(
  mode: OutputMode,
  options?: DoctorExtensionsRendererOptions,
): DoctorExtensionsRenderer {
  const opts = options ?? {};
  switch (mode) {
    case "json":
      return new JsonDoctorExtensionsRenderer();
    case "log":
      return new LogDoctorExtensionsRenderer(opts);
  }
}
