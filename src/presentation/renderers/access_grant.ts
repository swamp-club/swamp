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

import type { Grant } from "../../domain/models/access/grant_model.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";

export interface AccessGrantListRenderer {
  render(grants: Grant[]): void;
}

function formatSubject(subject: Grant["subject"]): string {
  return `${subject.kind}:${subject.name}`;
}

function formatResource(resource: Grant["resource"]): string {
  return `${resource.kind}:${resource.pattern}`;
}

class LogAccessGrantListRenderer implements AccessGrantListRenderer {
  render(grants: Grant[]): void {
    if (grants.length === 0) {
      writeOutput("No active grants found.");
      return;
    }

    const idDisplay = 9;
    const header = `${"ID".padEnd(idDisplay)}  ${"SUBJECT".padEnd(28)}  ${
      "EFFECT".padEnd(6)
    }  ${"ACTIONS".padEnd(20)}  ${"RESOURCE".padEnd(28)}  ${
      "CONDITION".padEnd(20)
    }  SOURCE`;
    writeOutput(header);

    for (const grant of grants) {
      const id = (grant.id.slice(0, 8) + "…").padEnd(idDisplay);
      const subject = formatSubject(grant.subject).padEnd(28);
      const effect = grant.effect.padEnd(6);
      const actions = grant.actions.join(",").padEnd(20);
      const resource = formatResource(grant.resource).padEnd(28);
      const condition = (grant.condition ?? "").padEnd(20);
      const source = grant.source;
      writeOutput(
        `${id}  ${subject}  ${effect}  ${actions}  ${resource}  ${condition}  ${source}`,
      );
    }
  }
}

class JsonAccessGrantListRenderer implements AccessGrantListRenderer {
  render(grants: Grant[]): void {
    writeOutput(JSON.stringify(grants, null, 2));
  }
}

export function createAccessGrantListRenderer(
  mode: OutputMode,
): AccessGrantListRenderer {
  switch (mode) {
    case "json":
      return new JsonAccessGrantListRenderer();
    case "log":
      return new LogAccessGrantListRenderer();
  }
}
