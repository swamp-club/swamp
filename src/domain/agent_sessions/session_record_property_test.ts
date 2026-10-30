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
import fc from "fast-check";
import {
  AGENT_SESSION_LIMITS,
  AGENT_SESSION_SUMMARY_TAG,
  agentSessionSummary,
  AgentSessionSummaryV1Schema,
  agentSessionTags,
  CallLabelSchema,
  FindingSeveritySchema,
  InvocationSchema,
  readAgentSessionRecord,
  readAgentSessionSummary,
  ToolKindSchema,
} from "./session_record.ts";

const arbMillis = fc.integer({ min: 0, max: 10_000_000 });
const arbTokens = fc.integer({ min: 0, max: 10_000_000 });
const arbText = fc.string({ maxLength: 60 });
const arbName = fc.string({ minLength: 1, maxLength: 40 });

const arbSessionId = fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,30}$/);

const arbLabelling = fc.constantFrom(...CallLabelSchema.options).chain((
  label,
): fc.Arbitrary<Record<string, string>> =>
  label === "unlabeled"
    ? fc.constant({ label })
    : fc.record({ label: fc.constant(label), category: arbName, rule: arbName })
);

// A subagent link only on a subagent call, as the schema requires.
const arbTool = fc.constantFrom(...ToolKindSchema.options).chain((
  toolKind,
): fc.Arbitrary<Record<string, string | undefined>> =>
  toolKind === "subagent"
    ? fc.record({
      toolKind: fc.constant(toolKind),
      subagentSessionId: fc.option(arbSessionId, { nil: undefined }),
    }, { requiredKeys: ["toolKind"] })
    : fc.constant({ toolKind })
);

const arbCall = (id: string) =>
  fc.tuple(
    fc.record({
      id: fc.constant(id),
      tool: arbName,
      start: arbMillis,
      end: arbMillis,
      ok: fc.boolean(),
      exitCode: fc.option(fc.integer({ min: -255, max: 255 }), {
        nil: undefined,
      }),
      text: arbText,
      truncated: fc.option(fc.constant(true as const), { nil: undefined }),
      swampSpans: fc.option(
        fc.array(
          fc.record({
            offset: arbMillis,
            spans: fc.array(
              fc.record({
                name: arbName,
                start: arbMillis,
                duration: arbMillis,
                depth: fc.integer({ min: 0, max: 8 }),
                error: fc.boolean(),
              }),
              { minLength: 1, maxLength: 4 },
            ),
          }),
          { maxLength: 2 },
        ),
        { nil: undefined },
      ),
    }, {
      requiredKeys: ["id", "tool", "start", "end", "ok", "text"],
    }),
    arbTool,
    arbLabelling,
  ).map(([call, tool, labelling]) => ({ ...call, ...tool, ...labelling }));

const arbSession = fc.array(fc.integer({ min: 0, max: 4 }), {
  minLength: 0,
  maxLength: 4,
}).chain((callsPerTurn) => {
  let next = 0;
  const turnArbs = callsPerTurn.map((count, t) =>
    fc.record({
      n: fc.constant(t + 1),
      start: arbMillis,
      end: arbMillis,
      tokens: fc.record({
        input: arbTokens,
        output: arbTokens,
        cacheRead: arbTokens,
        cacheWrite: arbTokens,
      }),
      calls: fc.tuple(
        ...Array.from({ length: count }, () => arbCall(`call-${next++}`)),
      ),
    })
  );
  const callIds = Array.from({ length: next }, (_, i) => `call-${i}`);
  return fc.record({
    schemaVersion: fc.constant(2),
    id: arbSessionId,
    repo: arbName,
    harness: fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/),
    harnessVersion: fc.option(arbName, { nil: undefined }),
    model: fc.option(arbName, { nil: undefined }),
    startedAt: fc.date({
      min: new Date("2020-01-01T00:00:00Z"),
      max: new Date("2030-01-01T00:00:00Z"),
      noInvalidDate: true,
    }).map((d) => d.toISOString()),
    invocation: fc.constantFrom(...InvocationSchema.options),
    swampUserId: fc.option(arbName, { nil: undefined }),
    swampUsername: fc.option(arbName, { nil: undefined }),
    importerVersion: arbName,
    turns: fc.tuple(...turnArbs),
    findings: fc.array(
      fc.record({
        severity: fc.constantFrom(...FindingSeveritySchema.options),
        title: arbName,
        detail: arbText,
        tune: arbText,
        callIds: callIds.length > 0
          ? fc.array(fc.constantFrom(...callIds), { maxLength: 3 })
          : fc.constant([]),
      }),
      { maxLength: 3 },
    ),
  }, {
    requiredKeys: [
      "schemaVersion",
      "id",
      "repo",
      "harness",
      "startedAt",
      "invocation",
      "importerVersion",
      "turns",
      "findings",
    ],
  });
});

Deno.test("readAgentSessionRecord: a valid record round-trips through JSON", () => {
  fc.assert(
    fc.property(arbSession, (session) => {
      const stored = JSON.parse(JSON.stringify(session));
      const reading = readAgentSessionRecord(stored);
      assertEquals(reading.kind, "record");
      if (reading.kind === "record") assertEquals(reading.record, stored);
    }),
  );
});

Deno.test("readAgentSessionRecord: never throws on arbitrary JSON", () => {
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      const reading = readAgentSessionRecord(value);
      assert(reading.kind === "record" || reading.kind === "skipped");
    }),
  );
});

Deno.test("readAgentSessionRecord: never throws on a valid record with one field replaced", () => {
  fc.assert(
    fc.property(
      arbSession,
      fc.string(),
      fc.jsonValue(),
      (session, key, value) => {
        const reading = readAgentSessionRecord({ ...session, [key]: value });
        assert(reading.kind === "record" || reading.kind === "skipped");
      },
    ),
  );
});

Deno.test("agentSessionSummary: every valid record gives a valid summary whose tag round-trips", () => {
  fc.assert(
    fc.property(arbSession, (session) => {
      const reading = readAgentSessionRecord(session);
      assert(reading.kind === "record");
      const summary = agentSessionSummary(reading.record);
      assert(AgentSessionSummaryV1Schema.safeParse(summary).success);
      assertEquals(
        summary.swamp + summary.bypass + summary.neutral + summary.unlabeled,
        summary.calls,
      );
      if (reading.record.turns.length === 0) {
        assertEquals([summary.wallMs, summary.activeMs], [0, 0]);
      }
      const tag = agentSessionTags(reading.record)[AGENT_SESSION_SUMMARY_TAG];
      assert(tag.length <= AGENT_SESSION_LIMITS.summaryTagLength);
      assertEquals(readAgentSessionSummary(tag), summary);
    }),
  );
});
