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

import type { CheckResult, PreflightCheck } from "../check.ts";
import type { ResolveBinary } from "./resolve_binary.ts";

/**
 * Verifies swamp itself is invocable from the hook. All supported tools
 * embed the string `swamp audit record --from-hook` in their hook configs
 * and rely on PATH lookup at hook-fire time; without swamp on PATH, every
 * hook silently fails on every tool.
 */

function appliesTo(tool: string): boolean {
  return tool === "claude" || tool === "cursor" || tool === "kiro" ||
    tool === "opencode" || tool === "copilot" || tool === "pi" ||
    tool === "antigravity";
}

/**
 * `resolveBinary` is injected — domain owns the port, the CLI passes in
 * `defaultCommandResolver()` from `infrastructure/process` at wiring time.
 */
export function makeSwampBinaryOnPathCheck(
  opts: { resolveBinary: ResolveBinary },
): PreflightCheck {
  const { resolveBinary } = opts;
  return {
    name: "swamp-binary-on-path",
    description: "swamp binary is invokable from the hook (PATH lookup)",
    appliesTo,
    async run(_ctx): Promise<CheckResult> {
      const pathResolved = await resolveBinary("swamp");
      if (!pathResolved) {
        return {
          name: "swamp-binary-on-path",
          status: "fail",
          message: "swamp is not on PATH",
          hint:
            "The audit hooks invoke `swamp audit record` — without swamp on PATH, every hook silently fails. Install swamp or add it to PATH.",
        };
      }

      return {
        name: "swamp-binary-on-path",
        status: "pass",
        message: `swamp is on PATH at ${pathResolved}`,
        details: { pathResolved },
      };
    },
  };
}
