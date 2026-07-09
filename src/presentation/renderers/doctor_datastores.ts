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
} from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "../output/output.ts";

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
