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
 * canonical fixtures of what each upstream tool emits; a round-trip test
 * through the normalizers makes them a contract, so an upstream breaking change
 * surfaces here
 */

import { DIAGNOSTIC_COMMAND_PREFIX } from "../audit_service.ts";

export const DOCTOR_SMOKE_TEST_COMMAND_PREFIX = DIAGNOSTIC_COMMAND_PREFIX;

/**
 * Kiro and Cursor normalizers discard session ids, so sessionId filtering
 * cannot work across all tools; the command-prefix sentinel is the cross-tool
 * marker
 */
export const DOCTOR_SMOKE_TEST_SESSION_ID = "swamp-doctor-smoke-test";

export interface SyntheticPayload {
  stdin: string;
  env: Record<string, string>;
  expectedCommand: string;
}

/**
 * the nonce becomes part of the command string the smoke test greps for, so
 * concurrent doctor runs do not observe each other's rows
 */
export function syntheticPayloadFor(
  tool: string,
  nonce: string,
): SyntheticPayload | null {
  const expectedCommand = `${DOCTOR_SMOKE_TEST_COMMAND_PREFIX} ${nonce}`;
  const cwd = ".";

  switch (tool) {
    case "claude": {
      const raw = {
        session_id: DOCTOR_SMOKE_TEST_SESSION_ID,
        cwd,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: expectedCommand },
      };
      return { stdin: JSON.stringify(raw), env: {}, expectedCommand };
    }
    case "cursor": {
      const raw = {
        cwd,
        tool_name: "Shell",
        tool_input: { command: expectedCommand },
      };
      return { stdin: JSON.stringify(raw), env: {}, expectedCommand };
    }
    case "kiro": {
      const raw = {
        tool_name: "shell",
        tool_input: { command: expectedCommand },
        cwd,
      };
      const stdin = JSON.stringify(raw);
      return {
        stdin,
        env: { USER_PROMPT: stdin },
        expectedCommand,
      };
    }
    case "opencode": {
      const raw = {
        tool_name: "bash",
        tool_input: { command: expectedCommand },
        session_id: DOCTOR_SMOKE_TEST_SESSION_ID,
        cwd,
      };
      return { stdin: JSON.stringify(raw), env: {}, expectedCommand };
    }
    case "copilot": {
      const raw = {
        sessionId: DOCTOR_SMOKE_TEST_SESSION_ID,
        cwd,
        toolName: "bash",
        toolArgs: { command: expectedCommand },
      };
      return { stdin: JSON.stringify(raw), env: {}, expectedCommand };
    }
    case "pi": {
      const raw = {
        tool_name: "bash",
        tool_input: { command: expectedCommand },
        session_id: DOCTOR_SMOKE_TEST_SESSION_ID,
        cwd,
      };
      return { stdin: JSON.stringify(raw), env: {}, expectedCommand };
    }
    case "antigravity": {
      const raw = {
        toolCall: {
          name: "run_command",
          args: { CommandLine: expectedCommand, Cwd: cwd },
        },
        conversationId: DOCTOR_SMOKE_TEST_SESSION_ID,
      };
      return { stdin: JSON.stringify(raw), env: {}, expectedCommand };
    }
    case "amp":
    case "codex":
    case "none":
    default:
      return null;
  }
}
