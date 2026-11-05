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

import { cyan, dim, green } from "@std/fmt/colors";
import type { EventHandlers } from "../../libswamp/stream.ts";
import { userErrorFromSwampError } from "../../libswamp/errors.ts";
import type {
  AuditUserHookData,
  AuditUserHookEvent,
} from "../../libswamp/audit/install.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

export function auditUserHookLines(d: AuditUserHookData): string[] {
  const path = cyan(d.settingsPath);
  if (d.action === "uninstall") {
    return [
      d.changed
        ? `${green("✓")} Removed swamp's audit hook from ${path}`
        : `${dim("•")} ${path} has no audit hook that swamp added`,
    ];
  }
  return [
    d.changed
      ? `${green("✓")} Added swamp's audit hook to ${path}`
      : `${dim("•")} ${path} already runs swamp's audit hook`,
    "Claude Code now records Bash and PowerShell calls whose working directory is",
    "inside a swamp repo, wherever the session started. The hook runs on every",
    "such call in every project; calls run from outside a swamp repo are not",
    "recorded.",
  ];
}

export function createAuditUserHookHandlers(
  mode: OutputMode,
): EventHandlers<AuditUserHookEvent> {
  return {
    completed: (e) => {
      if (mode === "json") {
        console.log(JSON.stringify(e.data, null, 2));
      } else {
        writeOutput(auditUserHookLines(e.data).join("\n"));
      }
    },
    error: (e) => {
      throw userErrorFromSwampError(e.error);
    },
  };
}
