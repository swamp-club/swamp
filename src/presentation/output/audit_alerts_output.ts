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
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { AuditAlertsResponse } from "../../serve/protocol.ts";
import type { OutputMode } from "./output.ts";

function stateColor(state: string): string {
  switch (state) {
    case "armed":
      return green(state);
    case "triggered":
      return red(state);
    case "cooldown":
      return yellow(state);
    default:
      return state;
  }
}

export function renderAuditAlerts(
  data: AuditAlertsResponse,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data.rules.length === 0) {
    writeOutput(dim("No alert rules configured"));
    return;
  }

  writeOutput(bold(`Alert Rules (${data.rules.length})`));
  writeOutput("");

  for (const rule of data.rules) {
    const desc = rule.description ? dim(` — ${rule.description}`) : "";
    writeOutput(`  ${bold(rule.name)}${desc}`);
    writeOutput(
      `    State: ${stateColor(rule.state)}  Window: ${rule.windowCount}${
        rule.lastFiredAt ? `  Last fired: ${dim(rule.lastFiredAt)}` : ""
      }`,
    );
  }
}
