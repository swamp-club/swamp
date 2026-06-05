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
  DoctorVaultsData,
  DoctorVaultsEvent,
  EventHandlers,
} from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "../output/output.ts";

export type DoctorVaultsStatus = "pass" | "fail";

export interface DoctorVaultsRenderer {
  handlers(): EventHandlers<DoctorVaultsEvent>;
  readonly overallStatus: DoctorVaultsStatus;
}

function renderUnresolvedLog(data: DoctorVaultsData): void {
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

class LogDoctorVaultsRenderer implements DoctorVaultsRenderer {
  overallStatus: DoctorVaultsStatus = "pass";

  handlers(): EventHandlers<DoctorVaultsEvent> {
    return {
      scanning: () => {
        writeOutput(
          dim(
            "Scanning definitions for sensitive resource outputs without a vault…",
          ),
        );
      },
      completed: (e) => {
        const { data } = e;

        if (data.findings.length === 0) {
          writeOutput(
            `\n${green("✓")} ${
              bold("All models with sensitive outputs have a vault configured")
            } ${dim(`(${data.scanned} definition(s) scanned)`)}`,
          );
          renderUnresolvedLog(data);
          return;
        }

        this.overallStatus = "fail";
        writeOutput(
          `\n${red("✗")} ${
            bold(
              `${data.findings.length} definition(s) have sensitive resource outputs but no vault is configured`,
            )
          } ${dim(`(${data.scanned} definition(s) scanned)`)}`,
        );

        for (const finding of data.findings) {
          writeOutput(
            `    ${red("•")} ${bold(finding.definitionName)} ${
              dim(`[${finding.type}]`)
            }`,
          );
        }

        writeOutput(
          dim(
            "\n  These models will fail at runtime when writing sensitive data. " +
              "Create a vault: swamp vault create <type> <name>",
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

class JsonDoctorVaultsRenderer implements DoctorVaultsRenderer {
  overallStatus: DoctorVaultsStatus = "pass";

  handlers(): EventHandlers<DoctorVaultsEvent> {
    return {
      scanning: () => {},
      completed: (e) => {
        const { data } = e;
        this.overallStatus = data.findings.length > 0 ? "fail" : "pass";
        console.log(
          JSON.stringify(
            {
              overallStatus: this.overallStatus,
              scanned: data.scanned,
              hasVault: data.hasVault,
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

export function createDoctorVaultsRenderer(
  mode: OutputMode,
): DoctorVaultsRenderer {
  switch (mode) {
    case "json":
      return new JsonDoctorVaultsRenderer();
    case "log":
      return new LogDoctorVaultsRenderer();
  }
}
