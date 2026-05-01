// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import type { AiTool } from "../../../repo/repo_service.ts";
import type { PreflightCheck } from "../check.ts";
import { binaryNameFor, type ResolveBinary } from "./resolve_binary.ts";

const INSTALL_HINTS: Record<string, string> = {
  claude:
    "Install Claude Code: https://docs.anthropic.com/en/docs/claude-code/quickstart",
  cursor: "Install Cursor: https://cursor.com",
  kiro: "Install Kiro CLI: https://docs.kiro.ai/cli",
  opencode: "Install OpenCode: https://opencode.ai",
};

function appliesTo(tool: AiTool): boolean {
  return tool === "claude" || tool === "cursor" || tool === "kiro" ||
    tool === "opencode";
}

/**
 * Verifies the AI tool's own binary is on PATH. Without it, the tool can't
 * run at all — no commands, no hooks, no audit rows.
 *
 * `resolveBinary` is injected — domain owns the port, the CLI passes in
 * `defaultCommandResolver()` from `infrastructure/process` at wiring time.
 */
export function makeBinaryOnPathCheck(
  opts: { resolveBinary: ResolveBinary },
): PreflightCheck {
  const { resolveBinary } = opts;
  return {
    name: "binary-on-path",
    description: "AI tool binary is resolvable on PATH",
    appliesTo,
    async run(ctx) {
      const binary = binaryNameFor(ctx.tool);
      const path = await resolveBinary(binary);
      if (path) {
        return {
          name: "binary-on-path",
          status: "pass",
          message: `${binary} found at ${path}`,
          details: { binary, path },
        };
      }
      return {
        name: "binary-on-path",
        status: "fail",
        message: `${binary} is not on PATH`,
        hint: INSTALL_HINTS[ctx.tool] ?? `Install ${ctx.tool}.`,
        details: { binary },
      };
    },
  };
}
