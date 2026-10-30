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
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import {
  modelOutputSearch,
  type ModelOutputSearchEvent,
} from "./output_search.ts";
import {
  modelUsageSummary,
  type ModelUsageSummaryEvent,
} from "./usage_summary.ts";

const TYPE = { normalized: "test/model" };
const DAY = 86_400_000;
const EPOCH = Date.UTC(2026, 0, 1);

/** Definitions the outputs may belong to; `def-gone` no longer resolves. */
const DEFINITIONS = [
  { definition: { id: "def-a", name: "a" }, type: TYPE },
  { definition: { id: "def-b", name: "b" }, type: TYPE },
];

const outputArb = fc.record({
  definitionId: fc.constantFrom("def-a", "def-b", "def-gone"),
  methodName: fc.constantFrom("run", "sync", "check"),
  status: fc.constantFrom("succeeded", "failed", "running"),
  offsetMs: fc.integer({ min: 0, max: 10 * DAY }),
});

const windowArb = fc.record({
  since: fc.option(fc.integer({ min: 0, max: 10 * DAY }), { nil: undefined }),
  until: fc.option(fc.integer({ min: 0, max: 10 * DAY }), { nil: undefined }),
});

const iso = (offsetMs: number | undefined) =>
  offsetMs === undefined ? undefined : new Date(EPOCH + offsetMs).toISOString();

Deno.test("modelUsageSummary: counts equal those of an unlimited output search over the same outputs and window", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(outputArb, { maxLength: 60 }),
      windowArb,
      fc.subarray(["run", "sync", "check"]),
      async (rows, window, readableMethods) => {
        const candidates = rows.map((row, i) => ({
          output: {
            id: `out-${i}`,
            definitionId: row.definitionId,
            methodName: row.methodName,
            status: row.status,
            startedAt: new Date(EPOCH + row.offsetMs),
          },
          type: TYPE,
        }));
        const shared = {
          findAllOutputsGlobal: () => Promise.resolve(candidates),
          findAllDefinitions: () => Promise.resolve(DEFINITIONS),
        };
        const input = { since: iso(window.since), until: iso(window.until) };
        const readable = new Set(readableMethods);

        const searched = await collect<ModelOutputSearchEvent>(
          modelOutputSearch(createLibSwampContext(), shared, input),
        );
        const last = searched[searched.length - 1];
        assert(last.kind === "completed");
        // What the serve handler keeps of a search before it answers.
        const items = last.data.results.filter((item) =>
          readable.has(item.methodName)
        );

        const summarized = await collect<ModelUsageSummaryEvent>(
          modelUsageSummary(createLibSwampContext(), {
            ...shared,
            isReadable: (group) =>
              Promise.resolve(readable.has(group.methodName)),
            definitionNameById: (id) =>
              Promise.resolve(
                DEFINITIONS.find((d) => d.definition.id === id)?.definition
                  .name,
              ),
          }, input),
        );
        const done = summarized[summarized.length - 1];
        assert(done.kind === "completed");
        const { totals, models } = done.data;

        assertEquals(totals, {
          executions: items.length,
          failed: items.filter((item) => item.status === "failed").length,
        });
        const named = items.filter((item) => item.modelName !== undefined);
        assertEquals(
          models.reduce((sum, model) => sum + model.executions, 0),
          named.length,
        );
        for (const model of models) {
          const own = named.filter((item) =>
            item.definitionId === model.definitionId
          );
          assertEquals(model.executions, own.length);
          assertEquals(
            model.failed,
            own.filter((item) => item.status === "failed").length,
          );
          assertEquals(
            [...model.methods].sort(),
            [...new Set(own.map((item) => item.methodName))].sort(),
          );
          // The search sorts newest first; ties may come in either order.
          assertEquals(model.lastStartedAt, own[0].startedAt);
          assertEquals(
            model.recent.map((o) => o.startedAt),
            own.slice(0, 20).map((item) => item.startedAt),
          );
        }
      },
    ),
  );
});
