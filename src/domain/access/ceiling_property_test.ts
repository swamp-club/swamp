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
import { Ceiling, CEILING_ACTIONS } from "./ceiling.ts";

const name = fc.stringMatching(/^[a-c]{1,3}$/);
const selector = fc.oneof(
  fc.constant("workflow:*"),
  name.map((n) => `workflow:${n}`),
  name.map((n) => `workflow:${n}*`),
);
const workspaceSelector = fc.oneof(
  fc.constant("workspace:*"),
  name.map((n) => `workspace:${n}`),
  name.map((n) => `workspace:${n}*`),
);
const entry = fc.oneof(
  fc.record({
    actions: fc.array(fc.constantFrom(...CEILING_ACTIONS), { minLength: 1 }),
    resource: selector,
  }),
  fc.record({ actions: fc.constant(["read"]), resource: workspaceSelector }),
);
const document = fc.record({
  version: fc.constant(1),
  ceiling: fc.array(entry, { maxLength: 6 }),
});

Deno.test("Ceiling: canonical form round-trips and ignores entry order", () => {
  fc.assert(fc.property(document, (doc) => {
    const parsed = Ceiling.parse(doc);
    const again = Ceiling.parse(JSON.parse(parsed.canonical()));
    assertEquals(again.canonical(), parsed.canonical());
    const reversed = Ceiling.parse({
      ...doc,
      ceiling: [...doc.ceiling].reverse(),
    });
    assertEquals(reversed.canonical(), parsed.canonical());
  }));
});

Deno.test("Ceiling: isWithin is reflexive and everything allowed inside is allowed outside", () => {
  fc.assert(fc.property(document, document, name, (a, b, wf) => {
    const inner = Ceiling.parse(a);
    const outer = Ceiling.parse(b);
    assert(inner.isWithin(inner));
    if (!inner.isWithin(outer)) return;
    for (const action of CEILING_ACTIONS) {
      for (const kind of ["workflow", "workspace"] as const) {
        const resource = { kind, name: wf };
        if (inner.allows(action, resource)) {
          assert(outer.allows(action, resource));
        }
      }
    }
  }));
});

Deno.test("Ceiling: a workflow entry never allows a workspace of the same name, nor the reverse", () => {
  fc.assert(fc.property(document, name, (doc, n) => {
    const c = Ceiling.parse(doc);
    for (const action of CEILING_ACTIONS) {
      if (c.allows(action, { kind: "workspace", name: n })) {
        assert(
          doc.ceiling.some((e) =>
            e.resource.startsWith("workspace:") && e.actions.includes(action)
          ),
        );
        assertEquals(action, "read");
      }
      if (c.allows(action, { kind: "workflow", name: n })) {
        assert(
          doc.ceiling.some((e) =>
            e.resource.startsWith("workflow:") && e.actions.includes(action)
          ),
        );
      }
    }
  }));
});
