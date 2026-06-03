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
  summarise,
  type SummariseDeps,
  type SummariseEvent,
} from "./summarise.ts";

function makeDeps(overrides: Partial<SummariseDeps> = {}): SummariseDeps {
  return {
    summarise: () =>
      Promise.resolve({
        since: "2026-01-01T00:00:00Z",
        methodExecutions: [{
          modelName: "test",
          type: "aws/s3-bucket",
          total: 1,
          succeeded: 1,
          failed: 0,
          methods: [],
        }],
        workflows: [],
        data: {
          totalItems: 0,
          totalVersions: 0,
          uniqueModels: 0,
          byModelType: [],
        },
      }),
    ...overrides,
  };
}

Deno.test("summarise: yields completed with summary data", async () => {
  const deps = makeDeps();

  const events = await collect<SummariseEvent>(
    summarise(createLibSwampContext(), deps, {
      since: new Date("2026-01-01T00:00:00Z"),
      sinceLabel: "24 hours",
    }),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    SummariseEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.status, "summary");
});

Deno.test("summarise: yields completed with no_activity when empty", async () => {
  const deps = makeDeps({
    summarise: () =>
      Promise.resolve({
        since: "2026-01-01T00:00:00Z",
        methodExecutions: [],
        workflows: [],
        data: {
          totalItems: 0,
          totalVersions: 0,
          uniqueModels: 0,
          byModelType: [],
        },
      }),
  });

  const events = await collect<SummariseEvent>(
    summarise(createLibSwampContext(), deps, {
      since: new Date("2026-01-01T00:00:00Z"),
      sinceLabel: "24 hours",
    }),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    SummariseEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.status, "no_activity");
});
