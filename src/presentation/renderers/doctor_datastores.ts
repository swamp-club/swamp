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
import type {
  DoctorDatastoresEvent,
  EventHandlers,
  RepairCatalogIndexEvent,
  RepairDatastoresEvent,
  RepairUnmigratedDataEvent,
} from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "../output/output.ts";

// ============================================================================
// Doctor datastores renderer (detection)
// ============================================================================

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
              catalogCompletenessFinding: data.catalogCompletenessFinding ??
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
  #steps: Array<{ step: number; total: number; description: string }> = [];

  handlers(): EventHandlers<RepairDatastoresEvent> {
    return {
      scanning: () => {},
      preview: (e) => {
        this.overallStatus = "preview";
        console.log(
          JSON.stringify(
            {
              status: "preview",
              namespace: e.namespace,
              contamination: e.contamination,
            },
            null,
            2,
          ),
        );
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
        console.log(
          JSON.stringify(
            {
              status: "completed",
              namespace: e.namespace,
              result: e.result,
              steps: this.#steps,
            },
            null,
            2,
          ),
        );
      },
      not_needed: () => {
        this.overallStatus = "pass";
        console.log(
          JSON.stringify({ status: "not_needed" }, null, 2),
        );
      },
      error: (e) => {
        this.overallStatus = "fail";
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createRepairDatastoresRenderer(
  mode: OutputMode,
): RepairDatastoresRenderer {
  switch (mode) {
    case "json":
      return new JsonRepairDatastoresRenderer();
    case "log":
      return new LogRepairDatastoresRenderer();
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

  handlers(): EventHandlers<RepairUnmigratedDataEvent> {
    return {
      scanning: () => {},
      preview: (e) => {
        this.overallStatus = "preview";
        console.log(
          JSON.stringify(
            {
              status: "unmigrated_preview",
              namespace: e.namespace,
              directories: e.directories,
            },
            null,
            2,
          ),
        );
      },
      step: () => {},
      completed: (e) => {
        this.overallStatus = "pass";
        console.log(
          JSON.stringify(
            {
              status: "unmigrated_completed",
              namespace: e.namespace,
              result: e.result,
            },
            null,
            2,
          ),
        );
      },
      not_needed: () => {
        this.overallStatus = "pass";
        console.log(
          JSON.stringify({ status: "unmigrated_not_needed" }, null, 2),
        );
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
): UnmigratedDataRepairRenderer {
  switch (mode) {
    case "json":
      return new JsonUnmigratedDataRepairRenderer();
    case "log":
      return new LogUnmigratedDataRepairRenderer();
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
          `  ${e.result.missingRecords.toLocaleString()} missing record(s) across ${e.result.shortfalls.length} model type(s) will be re-indexed on the next data query`,
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

  handlers(): EventHandlers<RepairCatalogIndexEvent> {
    return {
      scanning: () => {},
      preview: (e) => {
        this.overallStatus = "preview";
        console.log(
          JSON.stringify(
            {
              status: "catalog_preview",
              completeness: e.completeness,
              foreignRowsNotice: FOREIGN_ROWS_NOTICE,
            },
            null,
            2,
          ),
        );
      },
      step: () => {},
      completed: (e) => {
        this.overallStatus = "pass";
        console.log(
          JSON.stringify(
            {
              status: "catalog_completed",
              result: e.result,
              foreignRowsNotice: FOREIGN_ROWS_NOTICE,
            },
            null,
            2,
          ),
        );
      },
      not_needed: () => {
        this.overallStatus = "pass";
        console.log(
          JSON.stringify({ status: "catalog_not_needed" }, null, 2),
        );
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
): CatalogIndexRepairRenderer {
  switch (mode) {
    case "json":
      return new JsonCatalogIndexRepairRenderer();
    case "log":
      return new LogCatalogIndexRepairRenderer();
  }
}
