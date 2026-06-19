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

import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import type { AccessCanIDecision } from "../../serve/protocol.ts";

export interface AccessCanIResult {
  principal: string;
  decisions: AccessCanIDecision[];
}

export interface AccessCanIRenderer {
  render(result: AccessCanIResult): void;
}

class LogAccessCanIRenderer implements AccessCanIRenderer {
  render(result: AccessCanIResult): void {
    if (result.decisions.length === 0) {
      writeOutput(`No matching grants for ${result.principal}`);
      return;
    }

    for (const decision of result.decisions) {
      const marker = decision.effect === "allow" ? "✓" : "✗";
      const via = `(via ${decision.via})`;
      const cond = decision.condition ? ` [when: ${decision.condition}]` : "";
      writeOutput(
        `${decision.resource.padEnd(30)} ${
          decision.action.padEnd(6)
        } ${marker} ${via}${cond}`,
      );
    }
  }
}

class JsonAccessCanIRenderer implements AccessCanIRenderer {
  render(result: AccessCanIResult): void {
    writeOutput(JSON.stringify(result, null, 2));
  }
}

export function createAccessCanIRenderer(
  mode: OutputMode,
): AccessCanIRenderer {
  switch (mode) {
    case "json":
      return new JsonAccessCanIRenderer();
    case "log":
      return new LogAccessCanIRenderer();
  }
}
