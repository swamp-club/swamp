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

import { assertEquals, assertThrows } from "@std/assert";
import { Ceiling, ceilingWithin, MAX_CEILING_ENTRIES } from "./ceiling.ts";

function ceiling(
  ...entries: { actions: string[]; resource: string }[]
): Ceiling {
  return Ceiling.parse({ version: 1, ceiling: entries });
}

Deno.test("Ceiling.parse: matches the vectors shared with swamp-club", async () => {
  const one = ceiling({
    actions: ["signal", "run", "read", "approve", "run"],
    resource: "workflow:@acme/deploy",
  });
  assertEquals(
    one.canonical(),
    '{"ceiling":[{"actions":["approve","read","run","signal"],"resource":"workflow:@acme/deploy"}],"version":1}',
  );
  assertEquals(
    await one.digest(),
    "sha256:404d2bf3122fd23d85dae64b24eea63a4dee5f9f33b97e7c5408a54839d2a024",
  );
  assertEquals(ceiling().canonical(), '{"ceiling":[],"version":1}');
  assertEquals(
    await ceiling().digest(),
    "sha256:9ffe302e5d397bf7afb0a73086be9e4759c9cb99a6352ef898d338ccb7d789ab",
  );
});

Deno.test("Ceiling.parse: order and duplicate resources carry no meaning", () => {
  const a = ceiling(
    { actions: ["run"], resource: "workflow:b" },
    { actions: ["read"], resource: "workflow:a" },
    { actions: ["approve"], resource: "workflow:b" },
  );
  const b = ceiling(
    { actions: ["read"], resource: "workflow:a" },
    { actions: ["approve", "run"], resource: "workflow:b" },
  );
  assertEquals(a.canonical(), b.canonical());
});

Deno.test("Ceiling.parse: refuses write, tag and admin", () => {
  for (const action of ["write", "tag", "admin"]) {
    assertThrows(
      () => ceiling({ actions: [action], resource: "workflow:*" }),
      Error,
      "is not allowed",
    );
  }
});

Deno.test("Ceiling.parse: refuses every resource kind but workflow, behavior included", () => {
  for (
    const resource of [
      "model:*",
      "behavior:*",
      "data:*",
      "vault:*",
      "access:*",
    ]
  ) {
    assertThrows(
      () => ceiling({ actions: ["read"], resource }),
      Error,
      "only workflow resources",
    );
  }
});

Deno.test("Ceiling.parse: refuses methods, unknown keys and an unknown version", () => {
  assertThrows(() =>
    Ceiling.parse({
      version: 1,
      ceiling: [{ actions: ["run"], resource: "workflow:*", methods: ["x"] }],
    })
  );
  assertThrows(() => Ceiling.parse({ version: 1, ceiling: [], extra: true }));
  assertThrows(
    () => Ceiling.parse({ version: 2, ceiling: [] }),
    Error,
    "not supported",
  );
  assertThrows(() => Ceiling.parse([]));
  assertThrows(() =>
    Ceiling.parse({
      version: 1,
      ceiling: [{ actions: [], resource: "workflow:*" }],
    })
  );
});

Deno.test("Ceiling.parse: refuses bad selectors and unbounded input", () => {
  assertThrows(() => ceiling({ actions: ["run"], resource: "workflow:a*b" }));
  assertThrows(() => ceiling({ actions: ["run"], resource: "workflow:" }));
  assertThrows(() =>
    ceiling({ actions: ["run"], resource: "workflow:\uD800" })
  );
  assertThrows(() =>
    ceiling({ actions: ["run"], resource: `workflow:${"a".repeat(600)}` })
  );
  assertThrows(() =>
    ceiling(
      ...Array.from(
        { length: MAX_CEILING_ENTRIES + 1 },
        (_, i) => ({ actions: ["run"], resource: `workflow:w${i}` }),
      ),
    )
  );
});

Deno.test("Ceiling.allows: an action is literal, so run does not allow approve or signal", () => {
  const c = ceiling({ actions: ["run"], resource: "workflow:@acme/*" });
  assertEquals(c.allows("run", "@acme/deploy"), true);
  assertEquals(c.allows("approve", "@acme/deploy"), false);
  assertEquals(c.allows("signal", "@acme/deploy"), false);
  assertEquals(c.allows("read", "@acme/deploy"), false);
  assertEquals(c.allows("run", "@other/deploy"), false);
  assertEquals(c.allows("write", "@acme/deploy"), false);
});

Deno.test("Ceiling.allows: the empty ceiling allows nothing", () => {
  const c = Ceiling.empty();
  assertEquals(c.allows("read", "anything"), false);
  assertEquals(c.allowsSomewhere("read"), false);
});

Deno.test("ceilingWithin: tells narrowing from widening", () => {
  const consented = ceiling({
    actions: ["read", "run"],
    resource: "workflow:a*",
  });
  const narrower = ceiling({ actions: ["read"], resource: "workflow:ab" });
  const widerAction = ceiling({
    actions: ["approve"],
    resource: "workflow:ab",
  });
  const widerResource = ceiling({ actions: ["read"], resource: "workflow:b" });
  const widerPattern = ceiling({ actions: ["read"], resource: "workflow:*" });
  assertEquals(ceilingWithin(consented, consented), true);
  assertEquals(ceilingWithin(consented, narrower), true);
  assertEquals(ceilingWithin(consented, Ceiling.empty()), true);
  assertEquals(ceilingWithin(consented, widerAction), false);
  assertEquals(ceilingWithin(consented, widerResource), false);
  assertEquals(ceilingWithin(consented, widerPattern), false);
});

Deno.test("ceilingWithin: an exact selector does not cover a wildcard that starts with it", () => {
  assertEquals(
    ceilingWithin(
      ceiling({ actions: ["read"], resource: "workflow:a" }),
      ceiling({ actions: ["read"], resource: "workflow:a*" }),
    ),
    false,
  );
});
