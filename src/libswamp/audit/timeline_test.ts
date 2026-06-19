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

import { assertEquals } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  auditTimeline,
  type AuditTimelineDeps,
  type AuditTimelineEvent,
} from "./timeline.ts";

function makeDeps(
  overrides: Partial<AuditTimelineDeps> = {},
): AuditTimelineDeps {
  return {
    getTimeline: () =>
      Promise.resolve({
        entries: [{
          timestamp: "2026-01-01T00:00:00Z",
          source: "swamp" as const,
          summary: "test",
          status: "success" as const,
        }],
        totalSwamp: 1,
        totalDirect: 0,
        hoursAnalyzed: 24,
      }),
    ...overrides,
  };
}

Deno.test("auditTimeline: yields completed with timeline data", async () => {
  const deps = makeDeps();

  const events = await collect<AuditTimelineEvent>(
    auditTimeline(createLibSwampContext(), deps, {
      hours: 24,
      showAll: false,
      tool: "claude",
    }),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    AuditTimelineEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.status, "timeline");
});

Deno.test("auditTimeline: yields completed with no_data when empty", async () => {
  const deps = makeDeps({
    getTimeline: () =>
      Promise.resolve({
        entries: [],
        totalSwamp: 0,
        totalDirect: 0,
        hoursAnalyzed: 24,
      }),
  });

  const events = await collect<AuditTimelineEvent>(
    auditTimeline(createLibSwampContext(), deps, {
      hours: 24,
      showAll: false,
      tool: "claude",
    }),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    AuditTimelineEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.status, "no_data");
});

Deno.test("auditTimeline: yields completed with tool_not_supported for codex", async () => {
  const deps = makeDeps();

  const events = await collect<AuditTimelineEvent>(
    auditTimeline(createLibSwampContext(), deps, {
      hours: 24,
      showAll: false,
      tool: "codex",
    }),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    AuditTimelineEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.status, "tool_not_supported");
});

Deno.test("auditTimeline: copilot proceeds to normal timeline (not tool_not_supported)", async () => {
  const deps = makeDeps();

  const events = await collect<AuditTimelineEvent>(
    auditTimeline(createLibSwampContext(), deps, {
      hours: 24,
      showAll: false,
      tool: "copilot",
    }),
  );

  const completed = events[events.length - 1] as Extract<
    AuditTimelineEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.status, "timeline");
});
