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

import type { EventHandlers, TrustListEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { writeOutput } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { bold, cyan, dim } from "@std/fmt/colors";

class LogTrustListRenderer implements Renderer<TrustListEvent> {
  handlers(): EventHandlers<TrustListEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        const lines: string[] = [];

        lines.push(bold(cyan("Trusted Collectives")));
        lines.push("");

        lines.push(bold("Explicit:"));
        if (e.data.explicit.length > 0) {
          for (const c of e.data.explicit) {
            lines.push(`  ${c}`);
          }
        } else {
          lines.push(`  ${dim("(none)")}`);
        }

        lines.push("");
        lines.push(
          `${bold("Auto-trust membership collectives:")} ${
            e.data.trustMemberCollectives ? "enabled" : "disabled"
          }`,
        );

        if (e.data.trustMemberCollectives) {
          lines.push("");
          lines.push(bold("Membership:"));
          if (e.data.membership.length > 0) {
            for (const c of e.data.membership) {
              lines.push(`  ${c}`);
            }
          } else {
            lines.push(`  ${dim("(none)")}`);
          }
        }

        lines.push("");
        lines.push(bold("Resolved (effective):"));
        if (e.data.resolved.length > 0) {
          for (const c of e.data.resolved) {
            lines.push(`  ${c}`);
          }
        } else {
          lines.push(`  ${dim("(none)")}`);
        }

        writeOutput(lines.join("\n"));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonTrustListRenderer implements Renderer<TrustListEvent> {
  handlers(): EventHandlers<TrustListEvent> {
    return {
      resolving: () => {},
      completed: (e) => {
        console.log(JSON.stringify(e.data, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createTrustListRenderer(
  mode: OutputMode,
): Renderer<TrustListEvent> {
  switch (mode) {
    case "json":
      return new JsonTrustListRenderer();
    case "log":
      return new LogTrustListRenderer();
  }
}
