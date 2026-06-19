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

export interface CanIDecision {
  action: string;
  resource: string;
  effect: string;
  grantId: string;
  via: string;
  condition?: string;
}

export interface AccessCanIResult {
  principal: string;
  decisions: CanIDecision[];
  query?: { action: string; resource: string };
}

export interface AccessCanIRenderer {
  render(result: AccessCanIResult): void;
}

class LogAccessCanIRenderer implements AccessCanIRenderer {
  render(result: AccessCanIResult): void {
    if (result.query) {
      this.#renderSpecificCheck(result);
    } else {
      this.#renderEnumeration(result);
    }
  }

  #renderSpecificCheck(result: AccessCanIResult): void {
    if (result.decisions.length === 0) {
      writeOutput(
        `DENY (implicit) — no matching grants for ${result.principal} ${
          result.query!.action
        } ${result.query!.resource}`,
      );
      return;
    }

    const first = result.decisions[0];
    const effect = first.effect.toUpperCase();
    const via = `grant ${first.grantId.slice(0, 8)}…`;
    writeOutput(
      `${effect} via ${via} (${first.via} → ${result.query!.action} → ${
        result.query!.resource
      })`,
    );

    if (result.decisions.length > 1) {
      writeOutput("");
      writeOutput("All matching grants:");
      for (const d of result.decisions) {
        const e = d.effect.toUpperCase().padEnd(5);
        const g = d.grantId.slice(0, 8);
        const cond = d.condition ? ` [when: ${d.condition}]` : "";
        writeOutput(`  ${e}  ${g}…  via ${d.via}${cond}`);
      }
    }
  }

  #renderEnumeration(result: AccessCanIResult): void {
    if (result.decisions.length === 0) {
      writeOutput(`No matching grants for ${result.principal}`);
      return;
    }

    const resourceWidth = Math.max(
      ...result.decisions.map((d) => d.resource.length),
    );

    writeOutput(`Permissions for ${result.principal}:`);
    for (const decision of result.decisions) {
      const marker = decision.effect === "allow" ? "✓" : "✗";
      const via = `(via ${decision.via})`;
      const cond = decision.condition ? ` [when: ${decision.condition}]` : "";
      writeOutput(
        `${decision.resource.padEnd(resourceWidth + 2)} ${
          decision.action.padEnd(6)
        } ${marker} ${via}${cond}`,
      );
    }
  }
}

class JsonAccessCanIRenderer implements AccessCanIRenderer {
  render(result: AccessCanIResult): void {
    if (result.query) {
      const effect = result.decisions.length > 0
        ? result.decisions[0].effect
        : "deny";
      writeOutput(
        JSON.stringify(
          {
            principal: result.principal,
            action: result.query.action,
            resource: result.query.resource,
            effect,
            decisions: result.decisions,
          },
          null,
          2,
        ),
      );
    } else {
      writeOutput(
        JSON.stringify(
          { principal: result.principal, decisions: result.decisions },
          null,
          2,
        ),
      );
    }
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
