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

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  AGENT_SESSION_LIMITS,
  AGENT_SESSION_QUERY_PREDICATE,
  AGENT_SESSION_SCHEMA_VERSION,
  agentSessionDataName,
  AgentSessionRecordV1Schema,
  readAgentSessionRecord,
} from "./session_record.ts";

/** A hand-built v1 session: two turns, a swamp call with spans, a bypass. */
function sampleSession(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "3b1c9e2a-0f4d-4c1e-9a7b-2d5e8f6a1c30",
    repo: "demo-repo",
    harness: "claude-code",
    harnessVersion: "2.1.0",
    model: "claude-opus-5-5",
    startedAt: "2026-10-29T15:58:12.000Z",
    swampUserId: "u_01HXAMPLE",
    swampUsername: "alice",
    importerVersion: "0.1.0",
    turns: [
      {
        n: 1,
        start: 0,
        end: 4200,
        tokens: { input: 90, output: 1200, cacheRead: 30000, cacheWrite: 1500 },
        calls: [
          {
            id: "call-1",
            tool: "Bash",
            toolKind: "shell",
            start: 100,
            end: 900,
            ok: true,
            exitCode: 0,
            text: "swamp behavior type search",
            label: "swamp",
            category: "swamp",
            rule: "runs swamp",
            swampSpans: [{
              offset: 20,
              spans: [
                {
                  name: "swamp.cli",
                  start: 0,
                  duration: 310,
                  depth: 0,
                  error: false,
                },
                {
                  name: "swamp.type.search",
                  start: 54,
                  duration: 1,
                  depth: 1,
                  error: false,
                },
              ],
            }],
          },
        ],
      },
      {
        n: 2,
        start: 9000,
        end: 12000,
        tokens: { input: 40, output: 300, cacheRead: 31000, cacheWrite: 200 },
        calls: [
          {
            id: "call-2",
            tool: "Edit",
            toolKind: "file-edit",
            start: 9100,
            end: 9150,
            ok: false,
            text: "models/status-page.yaml",
            label: "bypass",
            category: "hand-edited definition",
            rule: "edits a swamp-managed path",
          },
        ],
      },
    ],
    findings: [
      {
        severity: "medium",
        title: "Edited a definition by hand",
        detail: "models/status-page.yaml was edited directly.",
        tune: "Point agents at swamp behavior validate after edits.",
        callIds: ["call-2"],
      },
    ],
  };
}

function turns(session: Record<string, unknown>): Record<string, unknown>[] {
  return session.turns as Record<string, unknown>[];
}

function firstCall(session: Record<string, unknown>): Record<string, unknown> {
  return (turns(session)[0].calls as Record<string, unknown>[])[0];
}

Deno.test("readAgentSessionRecord: reads a valid v1 session", () => {
  const reading = readAgentSessionRecord(sampleSession());
  assertEquals(reading.kind, "record");
  if (reading.kind !== "record") return;
  assertEquals(reading.record.schemaVersion, AGENT_SESSION_SCHEMA_VERSION);
  assertEquals(
    reading.record.turns[0].calls[0].swampSpans?.[0].spans.length,
    2,
  );
});

Deno.test("readAgentSessionRecord: identity fields are optional and independent", () => {
  const noUser = sampleSession();
  delete noUser.swampUserId;
  delete noUser.swampUsername;
  assertEquals(readAgentSessionRecord(noUser).kind, "record");

  const idOnly = sampleSession();
  delete idOnly.swampUsername;
  assertEquals(readAgentSessionRecord(idOnly).kind, "record");
});

Deno.test("readAgentSessionRecord: skips content with no schemaVersion as invalid", () => {
  for (const content of [null, "text", [], 3, {}, { schemaVersion: "1" }]) {
    const reading = readAgentSessionRecord(content);
    assertEquals(reading.kind, "skipped");
    if (reading.kind === "skipped") assertEquals(reading.reason, "invalid");
  }
  const missing = sampleSession();
  delete missing.schemaVersion;
  const reading = readAgentSessionRecord(missing);
  assert(reading.kind === "skipped" && reading.reason === "invalid");
});

Deno.test("readAgentSessionRecord: skips a newer version and says to upgrade", () => {
  const reading = readAgentSessionRecord({
    ...sampleSession(),
    schemaVersion: 2,
  });
  assert(reading.kind === "skipped");
  assertEquals(reading.reason, "newer");
  assertEquals(reading.schemaVersion, 2);
  assertStringIncludes(reading.note, "Upgrade swamp");
});

Deno.test("readAgentSessionRecord: refuses prompt and reply fields at any level", () => {
  const atSession = { ...sampleSession(), prompt: "do the thing" };
  const atTurn = sampleSession();
  turns(atTurn)[0].reply = "done";
  const atCall = sampleSession();
  firstCall(atCall).output = "secret output";
  for (const content of [atSession, atTurn, atCall]) {
    const reading = readAgentSessionRecord(content);
    assert(reading.kind === "skipped" && reading.reason === "invalid");
  }
});

Deno.test("readAgentSessionRecord: an invalid note names the path, never the value", () => {
  const session = sampleSession();
  firstCall(session).label = "sneaky-value-123";
  const reading = readAgentSessionRecord(session);
  assert(reading.kind === "skipped" && reading.reason === "invalid");
  assertStringIncludes(reading.note, "turns.0.calls.0.label");
  assert(!reading.note.includes("sneaky-value-123"));
});

Deno.test("readAgentSessionRecord: refuses over-long text and over-long lists", () => {
  const longText = sampleSession();
  firstCall(longText).text = "x".repeat(AGENT_SESSION_LIMITS.textLength + 1);
  const tooManyFindings = sampleSession();
  tooManyFindings.findings = Array.from(
    { length: AGENT_SESSION_LIMITS.findings + 1 },
    () => ({ severity: "low", title: "t", detail: "", tune: "", callIds: [] }),
  );
  for (const content of [longText, tooManyFindings]) {
    const reading = readAgentSessionRecord(content);
    assert(reading.kind === "skipped" && reading.reason === "invalid");
  }
});

Deno.test("AgentSessionRecordV1Schema: findings point only at calls in the session", () => {
  const dangling = sampleSession();
  (dangling.findings as Record<string, unknown>[])[0].callIds = ["nope"];
  assertEquals(AgentSessionRecordV1Schema.safeParse(dangling).success, false);

  const duplicate = sampleSession();
  (turns(duplicate)[1].calls as Record<string, unknown>[])[0].id = "call-1";
  assertEquals(AgentSessionRecordV1Schema.safeParse(duplicate).success, false);
});

Deno.test("AgentSessionRecordV1Schema: startedAt must be an ISO 8601 UTC time", () => {
  const local = { ...sampleSession(), startedAt: "2026-10-29T15:58" };
  assertEquals(AgentSessionRecordV1Schema.safeParse(local).success, false);
});

Deno.test("agentSessionDataName: one name per harness session", () => {
  assertEquals(
    agentSessionDataName("codex", "abc-123"),
    "agent-session-codex_abc-123",
  );
});

Deno.test("agentSessionDataName: a harness that prefixes another never shares a name", () => {
  assertNotEquals(
    agentSessionDataName("claude", "code-x"),
    agentSessionDataName("claude-code", "x"),
  );
});

Deno.test("agentSessionDataName: refuses a harness or session id the schema refuses", () => {
  for (
    const [harness, sessionId] of [
      ["Claude Code", "abc"],
      ["claude_code", "abc"],
      ["", "abc"],
      ["codex", "../etc"],
      ["codex", ""],
      ["codex", "a".repeat(AGENT_SESSION_LIMITS.idLength + 1)],
    ]
  ) {
    assertThrows(() => agentSessionDataName(harness, sessionId));
  }
});

Deno.test("AGENT_SESSION_QUERY_PREDICATE: lists by the type tag", () => {
  assertEquals(AGENT_SESSION_QUERY_PREDICATE, 'tags.type == "agent-session"');
});
