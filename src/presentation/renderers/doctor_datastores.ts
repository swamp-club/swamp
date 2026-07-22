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
  RepairDatastoresEvent,
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
          dim("\n  Run with --confirm to proceed."),
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
