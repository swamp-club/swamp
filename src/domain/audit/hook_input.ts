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

export type HookTool =
  | "claude"
  | "cursor"
  | "kiro"
  | "opencode"
  | "copilot"
  | "pi"
  | "antigravity";

export interface NormalizedHookInput {
  command: string;
  cwd: string;
  sessionId?: string;
  isFailure: boolean;
  errorMessage?: string;
  exitCode?: number;
}

export function parseExitCode(errorMessage: string): number | undefined {
  const exitCodeMatch = errorMessage.match(/Exit code (\d+)/i);
  if (exitCodeMatch) return parseInt(exitCodeMatch[1], 10);
  const statusCodeMatch = errorMessage.match(/status code (\d+)/);
  if (statusCodeMatch) return parseInt(statusCodeMatch[1], 10);
  return undefined;
}

export function cleanErrorMessage(errorMessage: string): string {
  return errorMessage
    .replace(/^Exit code \d+\s*/i, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" ");
}

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
    case "pi":
      return normalizePi(raw);
    case "antigravity":
      return normalizeAntiGravity(raw);
    case "copilot":
      return normalizeCopilot(raw);
  }
}

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
 * kiro-cli emits shell at runtime though agent configs accept other aliases;
 * Kiro IDE 1.0 uses execute_bash and execute_pwsh
 */
const KIRO_SHELL_TOOL_NAMES = new Set([
  "execute_bash",
  "execute_pwsh",
  "shell",
  "execute_cmd",
]);

/**
 * fires for success and failure; accepts kiro-cli and IDE 1.0 snake_case stdin,
 * and IDE 0.x camelCase via the USER_PROMPT env var
 */
function normalizeKiro(
  raw: Record<string, unknown>,
): NormalizedHookInput | null {
  const toolName = (raw.tool_name ?? raw.toolName) as string | undefined;
  if (!KIRO_SHELL_TOOL_NAMES.has(toolName ?? "")) return null;

  const toolInput = (raw.tool_input ?? raw.toolArgs) as
    | { command?: string }
    | undefined;
  const command = toolInput?.command;
  if (!command) return null;

  const toolResponse = raw.tool_response as
    | { success?: boolean; error?: string }
    | undefined;
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

function normalizePi(
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

function normalizeAntiGravity(
  raw: Record<string, unknown>,
): NormalizedHookInput | null {
  const toolCall = raw.toolCall as
    | { name?: string; args?: { CommandLine?: string; Cwd?: string } }
    | undefined;
  if (toolCall?.name !== "run_command") return null;

  const command = toolCall.args?.CommandLine;
  if (!command) return null;

  const errorStr = raw.error as string | undefined;
  const isFailure = !!errorStr;

  return {
    command,
    cwd: toolCall.args?.Cwd || (raw.cwd as string) || ".",
    sessionId: raw.conversationId as string | undefined,
    isFailure,
    ...(isFailure && errorStr ? { errorMessage: errorStr } : {}),
  };
}

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
