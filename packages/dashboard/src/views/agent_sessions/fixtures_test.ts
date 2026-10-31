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
  agentSessionChildId,
  agentSessionTags,
  readAgentSessionRecord,
  readAgentSessionSummary,
} from "../../../../../src/domain/agent_sessions/session_record.ts";
import {
  fixtureSessions,
  SUBAGENT_AGENT_ID,
  SUBAGENT_CHILD_ID,
  SUBAGENT_PARENT_ID,
} from "./fixtures.ts";

Deno.test("fixtureSessions: every session reads as a current record", () => {
  for (const session of fixtureSessions()) {
    const reading = readAgentSessionRecord(
      JSON.parse(JSON.stringify(session)),
    );
    assertEquals(reading.kind, "record", JSON.stringify(reading));
  }
});

Deno.test("fixtureSessions: every session's summary tag reads back", () => {
  for (const session of fixtureSessions()) {
    const summary = readAgentSessionSummary(agentSessionTags(session).summary);
    assert(summary, session.id);
  }
});

Deno.test("fixtureSessions: keep the prototype's sizes and add what it lacked", () => {
  const [edits, long, child, headless] = fixtureSessions();
  const callsIn = (s: typeof edits) =>
    s.turns.reduce((n, t) => n + t.calls.length, 0);
  assertEquals([edits.turns.length, callsIn(edits)], [5, 32]);
  assertEquals([long.turns.length, callsIn(long)], [17, 169]);
  assert(long.turns.some((t) => t.calls.length > 100));
  assertEquals(headless.invocation, "headless");
  assertEquals(child.parentSessionId, long.id);
  const all = fixtureSessions().flatMap((s) => s.turns.flatMap((t) => t.calls));
  assert(all.some((c) => c.truncated === true));
  assert(all.some((c) => c.label === "unlabeled"));
  const severities = new Set(
    fixtureSessions().flatMap((s) => s.findings.map((f) => f.severity)),
  );
  assertEquals([...severities].sort(), ["high", "info", "low", "medium"]);
});

Deno.test("fixtureSessions: the subagent call names the child the helper builds", async () => {
  assertEquals(
    await agentSessionChildId(SUBAGENT_PARENT_ID, SUBAGENT_AGENT_ID),
    SUBAGENT_CHILD_ID,
  );
  const long = fixtureSessions()[1];
  const link = long.turns.flatMap((t) => t.calls).find((c) =>
    c.toolKind === "subagent"
  );
  assertEquals(link?.subagentSessionId, SUBAGENT_CHILD_ID);
});
