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

import { assertEquals, assertNotEquals } from "@std/assert";
import { type HookTool, normalizeHookInput } from "../hook_input.ts";
import {
  DOCTOR_SMOKE_TEST_COMMAND_PREFIX,
  syntheticPayloadFor,
} from "./synthetic_payloads.ts";

/**
 * Round-trip every per-tool synthetic payload through the corresponding
 * normalizer in `hook_input.ts`. If a future upstream-tool change renders
 * a fixture incompatible with its normalizer — or vice versa — these
 * tests break, surfacing the drift at CI time rather than silently at
 * runtime.
 */
const SUPPORTED_TOOLS: HookTool[] = ["claude", "cursor", "kiro", "opencode"];

for (const tool of SUPPORTED_TOOLS) {
  Deno.test(
    `syntheticPayloadFor(${tool}): normalizes to the expected command`,
    () => {
      const payload = syntheticPayloadFor(tool, "test-nonce-123");
      if (!payload) {
        throw new Error(`no payload returned for supported tool ${tool}`);
      }
      const raw = JSON.parse(payload.stdin) as Record<string, unknown>;
      const normalized = normalizeHookInput(tool, raw);
      assertNotEquals(
        normalized,
        null,
        `normalizer rejected fixture for ${tool}`,
      );
      assertEquals(normalized?.command, payload.expectedCommand);
    },
  );
}

Deno.test("syntheticPayloadFor: command carries the sentinel prefix and the nonce", () => {
  const payload = syntheticPayloadFor("kiro", "abc123");
  assertEquals(
    payload?.expectedCommand,
    `${DOCTOR_SMOKE_TEST_COMMAND_PREFIX} abc123`,
  );
});

Deno.test("syntheticPayloadFor: sets USER_PROMPT env var for kiro only", () => {
  for (const tool of SUPPORTED_TOOLS) {
    const payload = syntheticPayloadFor(tool, "nonce");
    if (tool === "kiro") {
      assertEquals(payload?.env.USER_PROMPT, payload?.stdin);
    } else {
      assertEquals(payload?.env, {});
    }
  }
});

Deno.test("syntheticPayloadFor: returns null for tools without audit hooks", () => {
  assertEquals(syntheticPayloadFor("codex", "nonce"), null);
  assertEquals(syntheticPayloadFor("copilot", "nonce"), null);
  assertEquals(syntheticPayloadFor("none", "nonce"), null);
});
