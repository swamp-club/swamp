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
import type { CheckContext, CheckResult, PreflightCheck } from "../check.ts";

/**
 * Verifies the per-tool configuration swamp wrote at init time is still
 * present and well-formed. Each tool has its own file layout and shape;
 * this check dispatches to the right parser.
 */

const CONFIG_FILES: Record<string, string[]> = {
  kiro: [".kiro/agents/swamp.json"],
  claude: [".claude/settings.local.json"],
  cursor: [".cursor/hooks.json"],
  opencode: [".opencode/plugins/swamp-audit.ts"],
  copilot: [".github/hooks/swamp-audit.json"],
};

async function readJsonFile(path: string): Promise<unknown> {
  const content = await Deno.readTextFile(path);
  return JSON.parse(content);
}

async function checkKiro(ctx: CheckContext): Promise<CheckResult> {
  const configPath = join(ctx.repoPath, ".kiro/agents/swamp.json");
  let parsed: Record<string, unknown>;
  try {
    parsed = (await readJsonFile(configPath)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        name: "agent-config-loadable",
        status: "fail",
        message: `${configPath} is missing`,
        hint:
          "Run `swamp init --tool kiro --force` to regenerate the agent config.",
      };
    }
    return {
      name: "agent-config-loadable",
      status: "fail",
      message: `${configPath} could not be parsed as JSON`,
      hint:
        "The file is corrupt; run `swamp init --tool kiro --force` to overwrite it.",
      details: { error: String(error) },
    };
  }
  const tools = parsed.tools;
  if (!Array.isArray(tools)) {
    return {
      name: "agent-config-loadable",
      status: "fail",
      message: "`tools` field is missing or not an array",
      hint:
        "Run `swamp init --tool kiro --force` to regenerate the agent config.",
    };
  }
  if (tools.includes("*")) {
    return {
      name: "agent-config-loadable",
      status: "fail",
      message: '`tools` contains "*" which kiro-cli 2.0+ rejects',
      hint:
        "The `tools` list must name explicit tools. Run `swamp init --tool kiro --force` to regenerate.",
      details: { tools },
    };
  }
  const hooks = parsed.hooks as { postToolUse?: unknown[] } | undefined;
  if (!hooks?.postToolUse || hooks.postToolUse.length === 0) {
    return {
      name: "agent-config-loadable",
      status: "fail",
      message: "no `hooks.postToolUse` configured in the agent config",
      hint: "Run `swamp init --tool kiro --force` to regenerate.",
    };
  }
  return {
    name: "agent-config-loadable",
    status: "pass",
    message: `${configPath} is present and well-formed`,
  };
}

async function checkClaude(ctx: CheckContext): Promise<CheckResult> {
  const configPath = join(ctx.repoPath, ".claude/settings.local.json");
  let parsed: Record<string, unknown>;
  try {
    parsed = (await readJsonFile(configPath)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        name: "agent-config-loadable",
        status: "fail",
        message: `${configPath} is missing`,
        hint: "Run `swamp init --tool claude --force` to regenerate.",
      };
    }
    return {
      name: "agent-config-loadable",
      status: "fail",
      message: `${configPath} could not be parsed as JSON`,
      hint: "The file is corrupt; run `swamp init --tool claude --force`.",
      details: { error: String(error) },
    };
  }
  const hooks = parsed.hooks as
    | { PostToolUse?: unknown[]; PostToolUseFailure?: unknown[] }
    | undefined;
  if (!hooks?.PostToolUse || !hooks.PostToolUseFailure) {
    return {
      name: "agent-config-loadable",
      status: "fail",
      message:
        "Claude hooks (PostToolUse/PostToolUseFailure) are not configured",
      hint: "Run `swamp init --tool claude --force` to install the hooks.",
    };
  }
  if (!JSON.stringify(hooks).includes("swamp audit record --from-hook")) {
    return {
      name: "agent-config-loadable",
      status: "fail",
      message: "Claude hooks do not reference `swamp audit record --from-hook`",
      hint: "Run `swamp init --tool claude --force` to rewrite the hooks.",
    };
  }
  return {
    name: "agent-config-loadable",
    status: "pass",
    message: `${configPath} is present with both PostToolUse hooks wired`,
  };
}

async function checkCursor(ctx: CheckContext): Promise<CheckResult> {
  const configPath = join(ctx.repoPath, ".cursor/hooks.json");
  let parsed: Record<string, unknown>;
  try {
    parsed = (await readJsonFile(configPath)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        name: "agent-config-loadable",
        status: "fail",
        message: `${configPath} is missing`,
        hint: "Run `swamp init --tool cursor --force` to regenerate.",
      };
    }
    return {
      name: "agent-config-loadable",
      status: "fail",
      message: `${configPath} could not be parsed as JSON`,
      hint: "The file is corrupt; run `swamp init --tool cursor --force`.",
      details: { error: String(error) },
    };
  }
  const hooks = parsed.hooks as
    | { postToolUse?: unknown[]; postToolUseFailure?: unknown[] }
    | undefined;
  if (!hooks?.postToolUse || !hooks.postToolUseFailure) {
    return {
      name: "agent-config-loadable",
      status: "fail",
      message:
        "Cursor hooks (postToolUse/postToolUseFailure) are not configured",
      hint: "Run `swamp init --tool cursor --force` to install the hooks.",
    };
  }
  if (
    !JSON.stringify(hooks).includes(
      "swamp audit record --from-hook --tool cursor",
    )
  ) {
    return {
      name: "agent-config-loadable",
      status: "fail",
      message: "Cursor hooks do not reference `swamp audit record`",
      hint: "Run `swamp init --tool cursor --force` to rewrite the hooks.",
    };
  }
  return {
    name: "agent-config-loadable",
    status: "pass",
    message: `${configPath} is present with both hooks wired`,
  };
}

async function checkOpenCode(ctx: CheckContext): Promise<CheckResult> {
  const pluginPath = join(ctx.repoPath, ".opencode/plugins/swamp-audit.ts");
  let content: string;
  try {
    content = await Deno.readTextFile(pluginPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        name: "agent-config-loadable",
        status: "fail",
        message: `${pluginPath} is missing`,
        hint: "Run `swamp init --tool opencode --force` to install the plugin.",
      };
    }
    throw error;
  }
  if (
    !(content.includes("swamp") && content.includes("audit") &&
      content.includes("record"))
  ) {
    return {
      name: "agent-config-loadable",
      status: "fail",
      message: "OpenCode plugin does not reference `swamp audit record`",
      hint: "Run `swamp init --tool opencode --force` to rewrite the plugin.",
    };
  }
  return {
    name: "agent-config-loadable",
    status: "pass",
    message: `${pluginPath} is present and references \`swamp audit record\``,
  };
}

async function checkCopilot(ctx: CheckContext): Promise<CheckResult> {
  const configPath = join(ctx.repoPath, ".github/hooks/swamp-audit.json");
  let parsed: Record<string, unknown>;
  try {
    parsed = (await readJsonFile(configPath)) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        name: "agent-config-loadable",
        status: "fail",
        message: `${configPath} is missing`,
        hint: "Run `swamp init --tool copilot --force` to regenerate.",
      };
    }
    return {
      name: "agent-config-loadable",
      status: "fail",
      message: `${configPath} could not be parsed as JSON`,
      hint: "The file is corrupt; run `swamp init --tool copilot --force`.",
      details: { error: String(error) },
    };
  }
  const hooks = parsed.hooks as
    | { postToolUse?: unknown[]; postToolUseFailure?: unknown[] }
    | undefined;
  if (!hooks?.postToolUse || !hooks.postToolUseFailure) {
    return {
      name: "agent-config-loadable",
      status: "fail",
      message:
        "Copilot hooks (postToolUse/postToolUseFailure) are not configured",
      hint: "Run `swamp init --tool copilot --force` to install the hooks.",
    };
  }
  if (
    !JSON.stringify(hooks).includes(
      "swamp audit record --from-hook --tool copilot",
    )
  ) {
    return {
      name: "agent-config-loadable",
      status: "fail",
      message: "Copilot hooks do not reference `swamp audit record`",
      hint: "Run `swamp init --tool copilot --force` to rewrite the hooks.",
    };
  }
  return {
    name: "agent-config-loadable",
    status: "pass",
    message: `${configPath} is present with both hooks wired`,
  };
}

function appliesTo(tool: string): boolean {
  return tool in CONFIG_FILES;
}

export const agentConfigLoadableCheck: PreflightCheck = {
  name: "agent-config-loadable",
  description: "Per-tool audit hook configuration is present and well-formed",
  appliesTo,
  async run(ctx) {
    switch (ctx.tool) {
      case "kiro":
        return await checkKiro(ctx);
      case "claude":
        return await checkClaude(ctx);
      case "cursor":
        return await checkCursor(ctx);
      case "opencode":
        return await checkOpenCode(ctx);
      case "copilot":
        return await checkCopilot(ctx);
      default:
        return {
          name: "agent-config-loadable",
          status: "skip",
          message: `tool ${ctx.tool} has no audit config to validate`,
        };
    }
  },
};
