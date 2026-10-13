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

// Audit filters select the same events under the behavior and model
// spellings (swamp-club#3334).

import { assertEquals } from "@std/assert";
import fc from "fast-check";
import { AuditQueryService } from "./audit_query_service.ts";
import {
  AuditChainState,
  chainedEvent,
  inMemoryAuditStore,
} from "./behavior_spelling_test_helpers.ts";
import {
  canonicalAuditAction,
  canonicalAuditResource,
} from "./behavior_spelling.ts";

const ACTIONS = [
  "model.method.run",
  "model.create",
  "workflow.run",
  "data.get",
];
const KINDS = ["model", "workflow", "data"];
const NAMES = ["web", "db", "behavior", "model"];

const arbEvents = fc.array(
  fc.record({
    action: fc.constantFrom(...ACTIONS),
    kind: fc.constantFrom(...KINDS),
    name: fc.constantFrom(...NAMES),
  }),
  { maxLength: 12 },
);

/** A model-spelled filter value and its behavior spelling, when it has one. */
function respell(value: string, sep: "." | ":"): string {
  return value.startsWith(`model${sep}`)
    ? `behavior${sep}${value.slice(6)}`
    : value;
}

Deno.test("AuditQueryService property: behavior-spelled filters return what the model spelling returns", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbEvents,
      fc.option(fc.constantFrom(...ACTIONS), { nil: undefined }),
      fc.option(
        fc.tuple(fc.constantFrom(...KINDS), fc.constantFrom(...NAMES)).map((
          [k, n],
        ) => `${k}:${n}`),
        { nil: undefined },
      ),
      async (specs, action, resource) => {
        const chain = new AuditChainState();
        const events = [];
        for (const s of specs) {
          events.push(await chainedEvent(chain, s.action, s.kind, s.name));
        }
        const service = new AuditQueryService(inMemoryAuditStore(events));
        const since = new Date(Date.now() - 60_000).toISOString();
        const model = await service.query({ since, action, resource });
        const behavior = await service.query({
          since,
          action: action && respell(action, "."),
          resource: resource && respell(resource, ":"),
        });
        assertEquals(
          behavior.events.map((e) => e.id),
          model.events.map((e) => e.id),
        );
        assertEquals(behavior.total, model.total);
      },
    ),
    { numRuns: 100 },
  );
});

Deno.test("canonicalAuditAction/Resource property: idempotent, identity off the behavior prefix", () => {
  fc.assert(
    fc.property(fc.string(), (s) => {
      for (const canonical of [canonicalAuditAction, canonicalAuditResource]) {
        const once = canonical(s);
        assertEquals(canonical(once), once);
        if (!s.startsWith("behavior")) assertEquals(once, s);
      }
    }),
    { numRuns: 300 },
  );
});
