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

/**
 * Supported AI coding tools that can provide hook input.
 */
export type HookTool = "claude" | "cursor" | "kiro" | "opencode" | "copilot";

/**
 * Normalized hook input from any supported tool.
 * Returned by normalizeHookInput() after tool-specific parsing.
 */
export interface NormalizedHookInput {
  command: string;
  cwd: string;
  sessionId?: string;
  isFailure: boolean;
  errorMessage?: string;
  exitCode?: number;
}

/**
 * Extracts an exit code from a Claude Code error string.
 * Handles formats like:
 *   "Exit code 254\n\nAn error occurred..."
 *   "Command exited with non-zero status code 1"
 */
export function parseExitCode(errorMessage: string): number | undefined {
  const exitCodeMatch = errorMessage.match(/Exit code (\d+)/i);
  if (exitCodeMatch) return parseInt(exitCodeMatch[1], 10);
  const statusCodeMatch = errorMessage.match(/status code (\d+)/);
  if (statusCodeMatch) return parseInt(statusCodeMatch[1], 10);
  return undefined;
}

/**
 * Cleans up a Claude Code error string for display.
 * Strips the "Exit code N" prefix and collapses to a single line.
 */
export function cleanErrorMessage(errorMessage: string): string {
  return errorMessage
    .replace(/^Exit code \d+\s*/i, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ");
}

/**
 * Normalizes hook input JSON from different AI coding tools into a
 * common format. Returns null if the tool invocation is not a shell/bash
 * command and should be skipped.
 */
export function normalizeHookInput(
  tool: HookTool,
  raw: Record<string, unknown>,
): NormalizedHookInput | null {
  switch (tool) {
    case "claude":
      return normalizeClaude(raw);
    case "cursor":
      return normalizeCursor(raw);
    case "kiro":
      return normalizeKiro(raw);
    case "opencode":
      return normalizeOpenCode(raw);
    case "copilot":
      return normalizeCopilot(raw);
  }
}

/**
 * Claude Code: PostToolUse / PostToolUseFailure hooks.
 * tool_name === "Bash", command from tool_input.command,
 * failure when hook_event_name === "PostToolUseFailure".
 */
function normalizeClaude(
  raw: Record<string, unknown>,
): NormalizedHookInput | null {
  if (raw.tool_name !== "Bash") return null;

  const toolInput = raw.tool_input as { command?: string } | undefined;
  const command = toolInput?.command;
  if (!command) return null;

  const isFailure = raw.hook_event_name === "PostToolUseFailure";
  const errorStr = raw.error as string | undefined;

  return {
    command,
    cwd: (raw.cwd as string) || ".",
    sessionId: raw.session_id as string | undefined,
    isFailure,
    ...(isFailure && errorStr
      ? {
        exitCode: parseExitCode(errorStr),
        errorMessage: cleanErrorMessage(errorStr),
      }
      : {}),
  };
}

/**
 * Cursor: postToolUse / postToolUseFailure hooks.
 * tool_name === "Shell", command from tool_input.command,
 * failure when error_message is present.
 */
function normalizeCursor(
  raw: Record<string, unknown>,
): NormalizedHookInput | null {
  if (raw.tool_name !== "Shell") return null;

  const toolInput = raw.tool_input as { command?: string } | undefined;
  const command = toolInput?.command;
  if (!command) return null;

  const errorMessage = raw.error_message as string | undefined;
  const isFailure = !!errorMessage;

  return {
    command,
    cwd: (raw.cwd as string) || ".",
    isFailure,
    ...(isFailure && errorMessage ? { errorMessage } : {}),
  };
}

/**
 * Kiro shell tool aliases. kiro-cli emits "shell" at runtime even though agent
 * configs accept "executeBash" / "execute_bash" / "execute_cmd" as aliases.
 */
const KIRO_SHELL_TOOL_NAMES = new Set([
  "execute_bash",
  "shell",
  "execute_cmd",
]);

/**
 * Kiro: postToolUse hook (fires for both success and failure).
 *
 * Supports two input formats:
 * - kiro-cli (stdin, snake_case): tool_name, tool_input, tool_response
 * - Kiro IDE (USER_PROMPT env var, camelCase): toolName, toolArgs, toolResult, toolSuccess
 *
 * tool_name/toolName is one of KIRO_SHELL_TOOL_NAMES, command from
 * tool_input/toolArgs, failure when tool_response.success === false or
 * toolSuccess === false.
 */
function normalizeKiro(
  raw: Record<string, unknown>,
): NormalizedHookInput | null {
  // Support both kiro-cli (snake_case) and Kiro IDE (camelCase) field names
  const toolName = (raw.tool_name ?? raw.toolName) as string | undefined;
  if (!KIRO_SHELL_TOOL_NAMES.has(toolName ?? "")) return null;

  const toolInput = (raw.tool_input ?? raw.toolArgs) as
    | { command?: string }
    | undefined;
  const command = toolInput?.command;
  if (!command) return null;

  // kiro-cli format: tool_response.success / tool_response.error
  const toolResponse = raw.tool_response as
    | { success?: boolean; error?: string }
    | undefined;
  // Kiro IDE format: toolSuccess boolean, toolResult string
  const toolSuccess = raw.toolSuccess as boolean | undefined;

  const isFailure = toolResponse !== undefined
    ? toolResponse.success === false
    : toolSuccess !== undefined
    ? !toolSuccess
    : false;

  const errorMessage = toolResponse?.error ??
    (isFailure ? (raw.toolResult as string | undefined) : undefined);

  return {
    command,
    cwd: (raw.cwd as string) || ".",
    isFailure,
    ...(isFailure && errorMessage ? { errorMessage } : {}),
  };
}

/**
 * OpenCode: Plugin sends normalized JSON.
 * tool_name === "bash", command from tool_input.command,
 * session_id and error fields present when applicable.
 */
function normalizeOpenCode(
  raw: Record<string, unknown>,
): NormalizedHookInput | null {
  if (raw.tool_name !== "bash") return null;

  const toolInput = raw.tool_input as { command?: string } | undefined;
  const command = toolInput?.command;
  if (!command) return null;

  const errorStr = raw.error as string | undefined;
  const isFailure = !!errorStr;

  return {
    command,
    cwd: (raw.cwd as string) || ".",
    sessionId: raw.session_id as string | undefined,
    isFailure,
    ...(isFailure && errorStr ? { errorMessage: errorStr } : {}),
  };
}

/**
 * Copilot: postToolUse / postToolUseFailure hooks.
 * Upstream contract: https://docs.github.com/en/copilot/reference/hooks-reference
 *
 * Supports two input formats:
 * - camelCase (CLI): toolName, toolArgs, sessionId, timestamp (number)
 * - snake_case (VS Code compatible): tool_name, tool_input, session_id,
 *   hook_event_name, timestamp (ISO string)
 *
 * toolName/tool_name is "bash" for shell commands. Failure when
 * hook_event_name === "PostToolUseFailure" or error field is present.
 */
function normalizeCopilot(
  raw: Record<string, unknown>,
): NormalizedHookInput | null {
  const toolName = (raw.toolName ?? raw.tool_name) as string | undefined;
  if (toolName !== "bash") return null;

  const toolInput = (raw.toolArgs ?? raw.tool_input) as
    | { command?: string }
    | undefined;
  const command = toolInput?.command;
  if (!command) return null;

  const errorStr = raw.error as string | undefined;
  const isFailure = raw.hook_event_name === "PostToolUseFailure" ||
    raw.hookEventName === "PostToolUseFailure" || !!errorStr;

  return {
    command,
    cwd: (raw.cwd as string) || ".",
    sessionId: (raw.sessionId ?? raw.session_id) as string | undefined,
    isFailure,
    ...(isFailure && errorStr ? { errorMessage: errorStr } : {}),
  };
}
