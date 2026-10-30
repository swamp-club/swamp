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
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  AGENT_SESSION_HEADLESS_TAG,
  AGENT_SESSION_LIMITS,
  AGENT_SESSION_PARENT_TAG,
  AGENT_SESSION_QUERY_PREDICATE,
  AGENT_SESSION_SCHEMA_VERSION,
  AGENT_SESSION_STARTED_AT_TAG,
  AGENT_SESSION_SUMMARY_TAG,
  AGENT_SESSION_TOP_LEVEL_PREDICATE,
  agentSessionChildId,
  agentSessionChildrenPredicate,
  agentSessionDataName,
  type AgentSessionRecord,
  AgentSessionRecordV2Schema,
  agentSessionSummary,
  agentSessionTags,
  readAgentSessionRecord,
  readAgentSessionSummary,
} from "./session_record.ts";

/** A hand-built v2 session: two turns, a swamp call with spans, a bypass. */
function sampleSession(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: "3b1c9e2a-0f4d-4c1e-9a7b-2d5e8f6a1c30",
    repo: "demo-repo",
    harness: "claude-code",
    harnessVersion: "2.1.0",
    model: "claude-opus-5-5",
    startedAt: "2026-10-29T15:58:12.000Z",
    invocation: "interactive",
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

Deno.test("readAgentSessionRecord: reads a valid v2 session", () => {
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
    schemaVersion: 3,
  });
  assert(reading.kind === "skipped");
  assertEquals(reading.reason, "newer");
  assertEquals(reading.schemaVersion, 3);
  assertStringIncludes(reading.note, "Upgrade swamp");
});

Deno.test("readAgentSessionRecord: skips a v1 session as older and says to re-import", () => {
  const reading = readAgentSessionRecord({
    ...sampleSession(),
    schemaVersion: 1,
  });
  assert(reading.kind === "skipped");
  assertEquals(reading.reason, "older");
  assertEquals(reading.schemaVersion, 1);
  assertStringIncludes(reading.note, "Re-import the session");
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

Deno.test("AgentSessionRecordV2Schema: findings point only at calls in the session", () => {
  const dangling = sampleSession();
  (dangling.findings as Record<string, unknown>[])[0].callIds = ["nope"];
  assertEquals(AgentSessionRecordV2Schema.safeParse(dangling).success, false);

  const duplicate = sampleSession();
  (turns(duplicate)[1].calls as Record<string, unknown>[])[0].id = "call-1";
  assertEquals(AgentSessionRecordV2Schema.safeParse(duplicate).success, false);
});

Deno.test("AgentSessionRecordV2Schema: startedAt must be an ISO 8601 UTC time", () => {
  const local = { ...sampleSession(), startedAt: "2026-10-29T15:58" };
  assertEquals(AgentSessionRecordV2Schema.safeParse(local).success, false);
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
      ["codex", "a".repeat(AGENT_SESSION_LIMITS.sessionIdLength + 1)],
      ["codex", "AbC"],
      ["a".repeat(AGENT_SESSION_LIMITS.harnessLength + 1), "abc"],
    ]
  ) {
    assertThrows(() => agentSessionDataName(harness, sessionId));
  }
});

Deno.test("agentSessionDataName: the longest accepted name fits a directory name", () => {
  const name = agentSessionDataName(
    "a".repeat(AGENT_SESSION_LIMITS.harnessLength),
    "b".repeat(AGENT_SESSION_LIMITS.sessionIdLength),
  );
  assertEquals(name.length, 175);
});

Deno.test("AgentSessionRecordV2Schema: refuses a mixed-case session id", () => {
  const mixed = { ...sampleSession(), id: "AbC-123" };
  assertEquals(AgentSessionRecordV2Schema.safeParse(mixed).success, false);
});

function oversizedSession(): Record<string, unknown> {
  const session = sampleSession();
  const call = firstCall(session);
  const perTurn = AGENT_SESSION_LIMITS.callsPerTurn;
  const turnCount = Math.ceil(
    (AGENT_SESSION_LIMITS.callsPerSession + 1) / perTurn,
  );
  let next = 0;
  session.turns = Array.from({ length: turnCount }, (_, t) => ({
    ...turns(session)[0],
    n: t + 1,
    calls: Array.from({ length: perTurn }, () => ({
      ...call,
      id: `call-${next++}`,
      swampSpans: undefined,
    })),
  }));
  session.findings = [];
  return session;
}

Deno.test("readAgentSessionRecord: refuses a session with more calls than the session limit", () => {
  const reading = readAgentSessionRecord(oversizedSession());
  assert(reading.kind === "skipped" && reading.reason === "invalid");
  assertStringIncludes(reading.note, "too_big at turns");
});

Deno.test("AgentSessionRecordV2Schema: refuses more calls than the session limit on its own", () => {
  const parsed = AgentSessionRecordV2Schema.safeParse(oversizedSession());
  assertEquals(parsed.success, false);
  assertEquals(parsed.error?.issues[0].path, ["turns"]);
});

Deno.test("readAgentSessionRecord: refuses more turns than the limit before parsing them", () => {
  const session = sampleSession();
  session.turns = Array.from(
    { length: AGENT_SESSION_LIMITS.turns + 1 },
    () => "not a turn",
  );
  const reading = readAgentSessionRecord(session);
  assert(reading.kind === "skipped" && reading.reason === "invalid");
  assertStringIncludes(reading.note, "too_big at turns");
});

Deno.test("AGENT_SESSION_QUERY_PREDICATE: lists by the type tag", () => {
  assertEquals(AGENT_SESSION_QUERY_PREDICATE, 'tags.type == "agent-session"');
});

function parses(session: Record<string, unknown>): boolean {
  return AgentSessionRecordV2Schema.safeParse(session).success;
}

function record(session: Record<string, unknown>): AgentSessionRecord {
  return AgentSessionRecordV2Schema.parse(session);
}

Deno.test("AgentSessionRecordV2Schema: invocation is required and one of three values", () => {
  for (const invocation of ["interactive", "headless", "unknown"]) {
    assert(parses({ ...sampleSession(), invocation }));
  }
  const missing = sampleSession();
  delete missing.invocation;
  assertEquals(parses(missing), false);
  assertEquals(parses({ ...sampleSession(), invocation: "cron" }), false);
});

Deno.test("AgentSessionRecordV2Schema: model is optional", () => {
  const noModel = sampleSession();
  delete noModel.model;
  assert(parses(noModel));
  assertEquals(parses({ ...sampleSession(), model: "" }), false);
});

Deno.test("AgentSessionRecordV2Schema: agentId and agentType are only for a child session", () => {
  assertEquals(parses({ ...sampleSession(), agentType: "Explore" }), false);
  assertEquals(parses({ ...sampleSession(), agentId: "A1b2" }), false);
  assert(
    parses({
      ...sampleSession(),
      parentSessionId: "parent-1",
      agentId: "A1b2",
      agentType: "Explore",
    }),
  );
});

Deno.test("AgentSessionRecordV2Schema: subagentSessionId is only for a subagent call", () => {
  const onShell = sampleSession();
  firstCall(onShell).subagentSessionId = "parent-1_a1b2";
  const parsed = AgentSessionRecordV2Schema.safeParse(onShell);
  assertEquals(parsed.success, false);
  assertEquals(parsed.error?.issues[0].path, [
    "turns",
    0,
    "calls",
    0,
    "subagentSessionId",
  ]);

  const onSubagent = sampleSession();
  Object.assign(firstCall(onSubagent), {
    tool: "Agent",
    toolKind: "subagent",
    subagentSessionId: "parent-1_a1b2",
  });
  assert(parses(onSubagent));
});

Deno.test("AgentSessionRecordV2Schema: an unlabeled call has no category or rule, a labelled one needs both", () => {
  const unlabeled = sampleSession();
  const call = firstCall(unlabeled);
  call.label = "unlabeled";
  delete call.category;
  delete call.rule;
  assert(parses(unlabeled));

  const unlabeledWithRule = sampleSession();
  firstCall(unlabeledWithRule).label = "unlabeled";
  delete firstCall(unlabeledWithRule).category;
  assertEquals(parses(unlabeledWithRule), false);

  for (const key of ["category", "rule"]) {
    const labelled = sampleSession();
    delete firstCall(labelled)[key];
    assertEquals(parses(labelled), false);
  }
});

Deno.test("AgentSessionRecordV2Schema: truncated is only ever true", () => {
  const cut = sampleSession();
  firstCall(cut).truncated = true;
  assert(parses(cut));
  const notCut = sampleSession();
  firstCall(notCut).truncated = false;
  assertEquals(parses(notCut), false);
});

Deno.test("AgentSessionRecordV2Schema: a finding can be info", () => {
  const info = sampleSession();
  (info.findings as Record<string, unknown>[])[0].severity = "info";
  assert(parses(info));
});

Deno.test("agentSessionChildId: the parent id, then a hash of both ids", async () => {
  // SHA-256 of ["3b1c9e2a-0f4d","A1B2C3d4e5f6a7b8c"] as JSON, first 32 hex.
  assertEquals(
    await agentSessionChildId("3b1c9e2a-0f4d", "A1B2C3d4e5f6a7b8c"),
    "3b1c9e2a-0f4d_0789f6bf2eaf2134f3b956d4f043bd78",
  );
});

Deno.test("agentSessionChildId: ids that differ only in case or in where an underscore falls stay apart", async () => {
  assertNotEquals(
    await agentSessionChildId("parent", "A1b"),
    await agentSessionChildId("parent", "a1B"),
  );
  assertNotEquals(
    await agentSessionChildId("x_y", "z"),
    await agentSessionChildId("x", "y_z"),
  );
});

Deno.test("agentSessionChildId: a longest parent id still gives a valid child id", async () => {
  const parent = "a".repeat(AGENT_SESSION_LIMITS.sessionIdLength);
  const id = await agentSessionChildId(parent, "b".repeat(200));
  assertEquals(id.length, AGENT_SESSION_LIMITS.sessionIdLength);
  assert(
    parses({ ...sampleSession(), id, parentSessionId: parent, agentId: "b" }),
  );
});

Deno.test("agentSessionChildId: refuses a parent id the record schema refuses, or an empty or over-long agent id", async () => {
  await assertRejects(() => agentSessionChildId("Parent/1", "a"));
  await assertRejects(() => agentSessionChildId("parent", ""));
  await assertRejects(() => agentSessionChildId("parent", "a".repeat(201)));
});

Deno.test("agentSessionSummary: counts the session's own calls, tokens and findings", () => {
  const session = sampleSession();
  const subagentCall = {
    id: "call-3",
    tool: "Agent",
    toolKind: "subagent",
    start: 9200,
    end: 15000,
    ok: true,
    text: "Explore",
    label: "unlabeled",
    subagentSessionId: "child-1",
  };
  (turns(session)[1].calls as Record<string, unknown>[]).push(subagentCall);
  assertEquals(agentSessionSummary(record(session)), {
    repo: "demo-repo",
    harness: "claude-code",
    harnessVersion: "2.1.0",
    invocation: "interactive",
    // The subagent call ends after the last turn does.
    wallMs: 15000,
    activeMs: 4200 + 3000,
    turns: 2,
    calls: 3,
    swamp: 1,
    bypass: 1,
    neutral: 0,
    unlabeled: 1,
    failedCalls: 1,
    subagents: 1,
    tokens: { input: 130, output: 1500, cacheRead: 61000, cacheWrite: 1700 },
    findings: { high: 0, medium: 1, low: 0, info: 0 },
  });
});

Deno.test("agentSessionSummary: a turn that ends before it starts adds no active time", () => {
  const session = sampleSession();
  Object.assign(turns(session)[1], { start: 12000, end: 9000 });
  const summary = agentSessionSummary(record(session));
  assertEquals(summary.activeMs, 4200);
  assertEquals(summary.wallMs, 9150);
});

Deno.test("agentSessionSummary: totals stop at the largest safe integer, so the tag still reads", () => {
  const session = sampleSession();
  for (const turn of turns(session)) {
    Object.assign(turn, { start: 0, end: Number.MAX_VALUE });
    (turn.tokens as Record<string, number>).input = Number.MAX_SAFE_INTEGER;
  }
  const parsed = record(session);
  const summary = agentSessionSummary(parsed);
  assertEquals(summary.activeMs, Number.MAX_SAFE_INTEGER);
  assertEquals(summary.tokens.input, Number.MAX_SAFE_INTEGER);
  assertEquals(
    readAgentSessionSummary(
      agentSessionTags(parsed)[AGENT_SESSION_SUMMARY_TAG],
    ),
    summary,
  );
});

Deno.test("agentSessionTags: writes the list tags of a top-level session", () => {
  const session = record({
    ...sampleSession(),
    startedAt: "2026-10-29T15:58:12Z",
    invocation: "unknown",
  });
  const tags = agentSessionTags(session);
  assertEquals(
    Object.keys(tags).sort(),
    [
      AGENT_SESSION_HEADLESS_TAG,
      AGENT_SESSION_STARTED_AT_TAG,
      AGENT_SESSION_SUMMARY_TAG,
    ].sort(),
  );
  // Rewritten with milliseconds, so every tag sorts in time order.
  assertEquals(tags[AGENT_SESSION_STARTED_AT_TAG], "2026-10-29T15:58:12.000Z");
  assertEquals(tags[AGENT_SESSION_HEADLESS_TAG], "false");
  assertEquals(
    readAgentSessionSummary(tags[AGENT_SESSION_SUMMARY_TAG]),
    agentSessionSummary(session),
  );
});

Deno.test("agentSessionTags: a headless child carries its parent id", () => {
  const tags = agentSessionTags(record({
    ...sampleSession(),
    parentSessionId: "parent-1",
    invocation: "headless",
  }));
  assertEquals(tags[AGENT_SESSION_PARENT_TAG], "parent-1");
  assertEquals(tags[AGENT_SESSION_HEADLESS_TAG], "true");
});

Deno.test("readAgentSessionSummary: returns undefined for anything but a valid summary", () => {
  const summary = agentSessionSummary(record(sampleSession()));
  const padded = JSON.stringify(summary) +
    " ".repeat(AGENT_SESSION_LIMITS.summaryTagLength);
  for (
    const value of [
      undefined,
      42,
      "not json",
      "{}",
      JSON.stringify({ ...summary, prompt: "do the thing" }),
      padded,
    ]
  ) {
    assertEquals(readAgentSessionSummary(value), undefined);
  }
  assertEquals(readAgentSessionSummary(JSON.stringify(summary)), summary);
});

Deno.test("AGENT_SESSION_TOP_LEVEL_PREDICATE: leaves out sessions with a parent", () => {
  assertEquals(
    AGENT_SESSION_TOP_LEVEL_PREDICATE,
    'tags.type == "agent-session" && !has(tags.parentSessionId)',
  );
});

Deno.test("agentSessionChildrenPredicate: matches one parent's children", () => {
  assertEquals(
    agentSessionChildrenPredicate("parent-1"),
    'tags.type == "agent-session" && tags.parentSessionId == "parent-1"',
  );
});

Deno.test("agentSessionChildrenPredicate: refuses an id the record schema refuses", () => {
  for (const id of ['x" || true || "', "", "AbC"]) {
    assertThrows(() => agentSessionChildrenPredicate(id));
  }
});
