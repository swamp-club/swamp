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

/**
 * Per-tool synthetic hook payload fixtures for the `recording-smoke-test`
 * preflight check.
 *
 * These fixtures are the canonical source of truth for what we believe each
 * upstream tool emits at runtime. The corresponding normalizer in
 * `../hook_input.ts` accepts them today — when an upstream tool ships a
 * breaking change, this file is where the delta surfaces.
 *
 * The `synthetic_payloads_test.ts` companion test round-trips every fixture
 * through the normalizer and asserts a well-formed `NormalizedHookInput`,
 * turning these fixtures into a compile-time contract against the
 * normalizers.
 *
 * Upstream contract references:
 * - Claude Code:
 *   https://docs.anthropic.com/en/docs/claude-code/hooks#posttooluse
 * - Cursor:
 *   https://docs.cursor.com/en/agent/hooks
 * - Kiro CLI:
 *   https://docs.kiro.ai/cli/hooks (kiro-cli emits snake_case on stdin)
 * - Kiro IDE:
 *   https://docs.kiro.ai/ide/hooks (Kiro IDE emits camelCase via USER_PROMPT)
 * - OpenCode:
 *   https://opencode.ai/docs/plugins (plugin emits normalized JSON on stdin)
 */

import type { AiTool } from "../../repo/repo_service.ts";
import { DIAGNOSTIC_COMMAND_PREFIX } from "../audit_service.ts";

/**
 * Sentinel command prefix used to identify rows written by the doctor
 * smoke-test. Imported from `audit_service.ts` — the same constant the
 * audit timeline filters on, so writer and reader can never drift.
 */
export const DOCTOR_SMOKE_TEST_COMMAND_PREFIX = DIAGNOSTIC_COMMAND_PREFIX;

/**
 * Sentinel sessionId used by the smoke-test fixtures where the normalizer
 * propagates `session_id` (Claude, OpenCode). Kiro and Cursor normalizers
 * discard session IDs, so we cannot rely on sessionId filtering across all
 * tools — the command-prefix sentinel is the cross-tool marker.
 */
export const DOCTOR_SMOKE_TEST_SESSION_ID = "swamp-doctor-smoke-test";

/** A synthetic payload ready to feed `swamp audit record --from-hook`. */
export interface SyntheticPayload {
  /** Serialized JSON body to pipe to stdin of `swamp audit record`. */
  stdin: string;
  /** Environment variables to set on the subprocess (Kiro IDE only). */
  env: Record<string, string>;
  /** Expected command string the normalizer will extract and persist. */
  expectedCommand: string;
}

/**
 * Builds a synthetic payload for the given tool. Caller supplies a `nonce`
 * so concurrent doctor invocations don't observe each other's rows — the
 * nonce becomes part of the command string the smoke-test greps for.
 */
export function syntheticPayloadFor(
  tool: AiTool,
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
    case "codex":
    case "copilot":
    case "none":
      return null;
  }
}
