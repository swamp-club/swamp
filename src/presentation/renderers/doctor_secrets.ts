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
import type {
  DoctorSecretsData,
  DoctorSecretsEvent,
  EventHandlers,
} from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "../output/output.ts";

/**
 * A clean scan passes; any cleartext leak fails so the command can gate CI.
 * Unresolved definitions are advisory warnings — they do not fail the scan.
 */
export type DoctorSecretsStatus = "pass" | "fail";

/**
 * Renderer for `swamp doctor secrets`. Reports definitions holding cleartext
 * sensitive global arguments with value-free remediation guidance. Never
 * renders the offending secret value in any mode.
 *
 * Exposes `overallStatus` so the CLI can exit non-zero when a leak is found.
 */
export interface DoctorSecretsRenderer {
  handlers(): EventHandlers<DoctorSecretsEvent>;
  readonly overallStatus: DoctorSecretsStatus;
}

function renderUnresolvedLog(data: DoctorSecretsData): void {
  if (data.unresolved.length === 0) {
    return;
  }
  writeOutput(
    `\n${yellow("⚠")} ${
      bold(
        `${data.unresolved.length} definition(s) could not be assessed`,
      )
    } ${dim("(type schema unavailable — install the extension to scan them)")}`,
  );
  for (const u of data.unresolved) {
    writeOutput(`    ${yellow("•")} ${u.definitionName} ${dim(`[${u.type}]`)}`);
  }
}

class LogDoctorSecretsRenderer implements DoctorSecretsRenderer {
  overallStatus: DoctorSecretsStatus = "pass";

  handlers(): EventHandlers<DoctorSecretsEvent> {
    return {
      scanning: () => {
        writeOutput(
          dim("Scanning definitions for cleartext sensitive global arguments…"),
        );
      },
      completed: (e) => {
        const { data } = e;

        if (data.findings.length === 0) {
          writeOutput(
            `\n${green("✓")} ${
              bold("No cleartext sensitive global arguments found")
            } ${dim(`(${data.scanned} definition(s) scanned)`)}`,
          );
          renderUnresolvedLog(data);
          return;
        }

        this.overallStatus = "fail";
        writeOutput(
          `\n${red("✗")} ${
            bold(
              `${data.findings.length} definition(s) hold a cleartext sensitive global argument`,
            )
          } ${dim(`(${data.scanned} definition(s) scanned)`)}`,
        );

        for (const finding of data.findings) {
          writeOutput(
            `\n  ${bold(finding.definitionName)} ${dim(`[${finding.type}]`)}`,
          );
          for (const r of finding.remediations) {
            writeOutput(`    ${red("•")} ${bold(r.path)}`);
            writeOutput(
              `        ${
                dim("1. Store the secret:")
              } swamp vault put ${r.vaultName} ${r.vaultKey} <value>`,
            );
            writeOutput(
              `        ${dim("2. Reference it:")}     ${r.expression}`,
            );
          }
        }

        writeOutput(
          dim(
            "\n  Each secret above sits in cleartext in its definition YAML. " +
              "Migrate it to a vault, then re-save the definition.",
          ),
        );

        renderUnresolvedLog(data);
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonDoctorSecretsRenderer implements DoctorSecretsRenderer {
  overallStatus: DoctorSecretsStatus = "pass";

  handlers(): EventHandlers<DoctorSecretsEvent> {
    return {
      scanning: () => {
        // No-op — JSON consumers get a single final emit.
      },
      completed: (e) => {
        const { data } = e;
        this.overallStatus = data.findings.length > 0 ? "fail" : "pass";
        console.log(
          JSON.stringify(
            {
              overallStatus: this.overallStatus,
              scanned: data.scanned,
              findings: data.findings,
              unresolved: data.unresolved,
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

export function createDoctorSecretsRenderer(
  mode: OutputMode,
): DoctorSecretsRenderer {
  switch (mode) {
    case "json":
      return new JsonDoctorSecretsRenderer();
    case "log":
      return new LogDoctorSecretsRenderer();
  }
}
