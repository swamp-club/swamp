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

import { join } from "@std/path";
import type { PreflightCheck } from "../check.ts";

/**
 * Kiro-only: verifies the workspace-level CLI settings point
 * `chat.defaultAgent` at `"swamp"`. Without this, plain `kiro-cli chat`
 * loads the built-in default agent and the swamp audit hook never fires.
 */
export const defaultAgentSetCheck: PreflightCheck = {
  name: "default-agent-set",
  description: "Kiro workspace default agent is set to `swamp` (Kiro only)",
  appliesTo: (tool) => tool === "kiro",
  async run(ctx) {
    if (ctx.tool !== "kiro") {
      return {
        name: "default-agent-set",
        status: "skip",
        message: "only applies to kiro",
      };
    }
    const configPath = join(ctx.repoPath, ".kiro/settings/cli.json");
    let parsed: Record<string, unknown>;
    try {
      const content = await Deno.readTextFile(configPath);
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return {
          name: "default-agent-set",
          status: "fail",
          message: `${configPath} is missing`,
          hint:
            "Run `swamp init --tool kiro --force` to write the workspace default-agent setting.",
        };
      }
      return {
        name: "default-agent-set",
        status: "fail",
        message: `${configPath} could not be parsed`,
        hint: "The file is corrupt; run `swamp init --tool kiro --force`.",
        details: { error: String(error) },
      };
    }
    const defaultAgent = parsed["chat.defaultAgent"];
    if (defaultAgent === "swamp") {
      return {
        name: "default-agent-set",
        status: "pass",
        message: "`chat.defaultAgent` is set to `swamp`",
      };
    }
    return {
      name: "default-agent-set",
      status: "fail",
      message: `\`chat.defaultAgent\` is \`${
        defaultAgent ?? "unset"
      }\`, not \`swamp\``,
      hint:
        "Run `swamp init --tool kiro --force` to set the workspace default agent to swamp.",
      details: { defaultAgent },
    };
  },
};
