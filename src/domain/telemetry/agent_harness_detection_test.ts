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

import { assert, assertEquals } from "@std/assert";
import {
  detectAgentHarness,
  RELEVANT_ENV_VARS,
} from "./agent_harness_detection.ts";

Deno.test("detectAgentHarness: empty env yields no detection", () => {
  const result = detectAgentHarness({});
  assertEquals(result.detectedAiTool, undefined);
  assertEquals(result.agentSessionDetected, false);
});

Deno.test("detectAgentHarness: claude via CLAUDECODE=1", () => {
  const result = detectAgentHarness({ CLAUDECODE: "1" });
  assertEquals(result.detectedAiTool, "claude");
  assertEquals(result.agentSessionDetected, true);
});

Deno.test("detectAgentHarness: claude via CLAUDE_CODE_ENTRYPOINT", () => {
  const result = detectAgentHarness({ CLAUDE_CODE_ENTRYPOINT: "cli" });
  assertEquals(result.detectedAiTool, "claude");
  assertEquals(result.agentSessionDetected, true);
});

Deno.test("detectAgentHarness: cursor via TERM_PROGRAM=cursor", () => {
  const result = detectAgentHarness({ TERM_PROGRAM: "cursor" });
  assertEquals(result.detectedAiTool, "cursor");
  assertEquals(result.agentSessionDetected, true);
});

Deno.test("detectAgentHarness: cursor via CURSOR_TRACE_ID", () => {
  const result = detectAgentHarness({ CURSOR_TRACE_ID: "abc-123" });
  assertEquals(result.detectedAiTool, "cursor");
  assertEquals(result.agentSessionDetected, true);
});

Deno.test("detectAgentHarness: kiro via TERM_PROGRAM=kiro", () => {
  const result = detectAgentHarness({ TERM_PROGRAM: "kiro" });
  assertEquals(result.detectedAiTool, "kiro");
  assertEquals(result.agentSessionDetected, true);
});

Deno.test("detectAgentHarness: kiro via AGENT_CONTEXT_OUT FIFO path", () => {
  const result = detectAgentHarness({
    AGENT_CONTEXT_OUT: "/tmp/kiro-agent-ctx.fifo",
  });
  assertEquals(result.detectedAiTool, "kiro");
  assertEquals(result.agentSessionDetected, true);
});

Deno.test(
  "detectAgentHarness: empty AGENT_CONTEXT_OUT does not match kiro",
  () => {
    const result = detectAgentHarness({ AGENT_CONTEXT_OUT: "" });
    assertEquals(result.detectedAiTool, undefined);
    assertEquals(result.agentSessionDetected, false);
  },
);

Deno.test("detectAgentHarness: opencode via OPENCODE=1", () => {
  const result = detectAgentHarness({ OPENCODE: "1" });
  assertEquals(result.detectedAiTool, "opencode");
  assertEquals(result.agentSessionDetected, true);
});

Deno.test("detectAgentHarness: OPENCODE=0 does not match opencode", () => {
  const result = detectAgentHarness({ OPENCODE: "0" });
  assertEquals(result.detectedAiTool, undefined);
  assertEquals(result.agentSessionDetected, false);
});

Deno.test(
  "detectAgentHarness: codex via CODEX_SANDBOX_NETWORK_DISABLED=1",
  () => {
    const result = detectAgentHarness({ CODEX_SANDBOX_NETWORK_DISABLED: "1" });
    assertEquals(result.detectedAiTool, "codex");
    assertEquals(result.agentSessionDetected, true);
  },
);

Deno.test("detectAgentHarness: codex via CODEX_SANDBOX=seatbelt", () => {
  const result = detectAgentHarness({ CODEX_SANDBOX: "seatbelt" });
  assertEquals(result.detectedAiTool, "codex");
  assertEquals(result.agentSessionDetected, true);
});

// Codex env_clear()s before each shell-tool spawn and only re-adds sandbox
// markers. When a user disables sandboxing entirely, no codex-identifying
// env var survives — this test codifies that blind spot so future
// contributors don't try to invent more signals without upstream cooperation.
Deno.test(
  "detectAgentHarness: codex without sandbox is undetectable",
  () => {
    const result = detectAgentHarness({});
    assertEquals(result.detectedAiTool, undefined);
    assertEquals(result.agentSessionDetected, false);
  },
);

Deno.test("detectAgentHarness: generic AGENT fallback fires without specific match", () => {
  const result = detectAgentHarness({ AGENT: "1" });
  assertEquals(result.detectedAiTool, undefined);
  assertEquals(result.agentSessionDetected, true);
});

Deno.test("detectAgentHarness: generic AI_AGENT fallback fires without specific match", () => {
  const result = detectAgentHarness({ AI_AGENT: "1" });
  assertEquals(result.detectedAiTool, undefined);
  assertEquals(result.agentSessionDetected, true);
});

Deno.test("detectAgentHarness: generic IS_AGENT fallback fires without specific match", () => {
  const result = detectAgentHarness({ IS_AGENT: "true" });
  assertEquals(result.detectedAiTool, undefined);
  assertEquals(result.agentSessionDetected, true);
});

Deno.test("detectAgentHarness: AGENT=0 does not trip the fallback", () => {
  const result = detectAgentHarness({ AGENT: "0" });
  assertEquals(result.agentSessionDetected, false);
});

Deno.test("detectAgentHarness: AGENT=false does not trip the fallback", () => {
  const result = detectAgentHarness({ AGENT: "false" });
  assertEquals(result.agentSessionDetected, false);
});

Deno.test("detectAgentHarness: specific signal beats generic fallback", () => {
  const result = detectAgentHarness({ CLAUDECODE: "1", AGENT: "1" });
  assertEquals(result.detectedAiTool, "claude");
  assertEquals(result.agentSessionDetected, true);
});

Deno.test("detectAgentHarness: ignores keys outside the whitelist", () => {
  const result = detectAgentHarness({
    AWS_SECRET_ACCESS_KEY: "AKIA...",
    GITHUB_TOKEN: "ghp_...",
    HOME: "/home/keeb",
  });
  assertEquals(result.detectedAiTool, undefined);
  assertEquals(result.agentSessionDetected, false);
});

Deno.test("RELEVANT_ENV_VARS contains every key any signal references", () => {
  // Cross-checks the contract that callers can trust the export to project
  // Deno.env safely. If a future PR adds a signal but forgets to update the
  // whitelist, this test catches the drift.
  const expected = new Set([
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "TERM_PROGRAM",
    "CURSOR_TRACE_ID",
    "AGENT_CONTEXT_OUT",
    "OPENCODE",
    "CODEX_SANDBOX_NETWORK_DISABLED",
    "CODEX_SANDBOX",
    "AGENT",
    "AI_AGENT",
    "IS_AGENT",
  ]);
  for (const key of expected) {
    assert(
      RELEVANT_ENV_VARS.includes(key),
      `RELEVANT_ENV_VARS missing ${key}`,
    );
  }
  assertEquals(RELEVANT_ENV_VARS.length, expected.size);
});
