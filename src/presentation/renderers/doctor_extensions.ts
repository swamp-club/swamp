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

import { bold, dim, green, red, yellow } from "@std/fmt/colors";
import {
  DOCTOR_REGISTRY_ORDER,
  type DoctorExtensionsEvent,
  type DoctorOverallStatus,
  type DoctorRegistryName,
  type DoctorRegistryResult,
  type EventHandlers,
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

class LogDoctorExtensionsRenderer implements DoctorExtensionsRenderer {
  overallStatus: DoctorOverallStatus = "pass";

  handlers(): EventHandlers<DoctorExtensionsEvent> {
    return {
      "kind-started": () => {
        // No-op. ensureLoaded() runs fast enough that an in-progress
        // line is visual noise — users see the ✓/✗ on kind-completed.
      },
      "kind-completed": (e) => {
        const r = e.result;
        const failureSuffix = r.failures.length > 0
          ? dim(` (${r.failures.length} failure(s))`)
          : "";
        writeOutput(`${iconFor(r.status)} ${bold(r.registry)}${failureSuffix}`);
        for (const failure of r.failures) {
          writeOutput(`    ${yellow("•")} ${failure.file}: ${failure.error}`);
        }
      },
      completed: (e) => {
        this.overallStatus = e.report.overallStatus;
        // Filesystem orphan warnings are independent of pass/fail — if
        // anything is found, surface it before the summary so users see
        // both halves of the diagnostic.
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
        console.log(
          JSON.stringify(
            {
              overallStatus: e.report.overallStatus,
              registries,
              orphanFiles: e.report.orphanFiles,
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

export function createDoctorExtensionsRenderer(
  mode: OutputMode,
): DoctorExtensionsRenderer {
  switch (mode) {
    case "json":
      return new JsonDoctorExtensionsRenderer();
    case "log":
      return new LogDoctorExtensionsRenderer();
  }
}
