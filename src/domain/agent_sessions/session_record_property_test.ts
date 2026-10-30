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
  CallLabelSchema,
  FindingSeveritySchema,
  readAgentSessionRecord,
  ToolKindSchema,
} from "./session_record.ts";

const arbMillis = fc.integer({ min: 0, max: 10_000_000 });
const arbTokens = fc.integer({ min: 0, max: 10_000_000 });
const arbText = fc.string({ maxLength: 60 });
const arbName = fc.string({ minLength: 1, maxLength: 40 });

const arbCall = (id: string) =>
  fc.record({
    id: fc.constant(id),
    tool: arbName,
    toolKind: fc.constantFrom(...ToolKindSchema.options),
    start: arbMillis,
    end: arbMillis,
    ok: fc.boolean(),
    exitCode: fc.option(fc.integer({ min: -255, max: 255 }), {
      nil: undefined,
    }),
    text: arbText,
    label: fc.constantFrom(...CallLabelSchema.options),
    category: arbName,
    rule: arbName,
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
    requiredKeys: [
      "id",
      "tool",
      "toolKind",
      "start",
      "end",
      "ok",
      "text",
      "label",
      "category",
      "rule",
    ],
  });

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
    schemaVersion: fc.constant(1),
    id: fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$/),
    repo: arbName,
    harness: fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/),
    harnessVersion: fc.option(arbName, { nil: undefined }),
    model: arbName,
    startedAt: fc.date({
      min: new Date("2020-01-01T00:00:00Z"),
      max: new Date("2030-01-01T00:00:00Z"),
      noInvalidDate: true,
    }).map((d) => d.toISOString()),
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
      "model",
      "startedAt",
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
