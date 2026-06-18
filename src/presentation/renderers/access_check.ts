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

import type { AccessDecision } from "../../domain/access/access_decision_service.ts";
import type { OutputMode } from "../output/output.ts";

export interface AccessCheckResult {
  subject: string;
  action: string;
  resource: string;
  collectives: string[];
  decisions: AccessDecision[];
}

export interface AccessCheckRenderer {
  render(result: AccessCheckResult): void;
}

function formatSubject(subject: AccessDecision["subject"]): string {
  return `${subject.kind}:${subject.name}`;
}

class LogAccessCheckRenderer implements AccessCheckRenderer {
  render(result: AccessCheckResult): void {
    if (result.decisions.length === 0) {
      console.log(
        `DENY (implicit) — no matching grants for ${result.subject} ${result.action} ${result.resource}`,
      );
      return;
    }

    const firstDecision = result.decisions[0];
    const effect = firstDecision.effect.toUpperCase();
    const via = `grant ${firstDecision.grantId.slice(0, 8)}…`;
    const subject = formatSubject(firstDecision.subject);
    console.log(
      `${effect} via ${via} (${subject} → ${result.action} → ${result.resource})`,
    );

    if (result.decisions.length > 1) {
      console.log();
      console.log("All matching grants:");
      for (const decision of result.decisions) {
        const e = decision.effect.toUpperCase().padEnd(5);
        const g = decision.grantId.slice(0, 8);
        const s = formatSubject(decision.subject);
        const cond = decision.condition ? ` [when: ${decision.condition}]` : "";
        console.log(`  ${e}  ${g}…  via ${s}${cond}`);
      }
    }
  }
}

class JsonAccessCheckRenderer implements AccessCheckRenderer {
  render(result: AccessCheckResult): void {
    const finalEffect = result.decisions.length > 0
      ? result.decisions[0].effect
      : "deny";
    console.log(
      JSON.stringify(
        {
          subject: result.subject,
          action: result.action,
          resource: result.resource,
          collectives: result.collectives,
          effect: finalEffect,
          matchingGrants: result.decisions,
        },
        null,
        2,
      ),
    );
  }
}

export function createAccessCheckRenderer(
  mode: OutputMode,
): AccessCheckRenderer {
  switch (mode) {
    case "json":
      return new JsonAccessCheckRenderer();
    case "log":
      return new LogAccessCheckRenderer();
  }
}
