// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
  extensionList,
  type ExtensionListDeps,
  type ExtensionListEvent,
} from "./list.ts";

function makeDeps(
  overrides?: Partial<ExtensionListDeps>,
): ExtensionListDeps {
  return {
    readUpstreamExtensions: () =>
      Promise.resolve({
        "@ns/beta": { version: "1.0.0", pulledAt: "2026-01-02" },
        "@ns/alpha": {
          version: "2.0.0",
          pulledAt: "2026-01-01",
          files: ["a.ts"],
        },
      }),
    ...overrides,
  };
}

Deno.test("extensionList yields sorted extensions", async () => {
  const deps = makeDeps();
  const events = await collect<ExtensionListEvent>(
    extensionList(createLibSwampContext(), deps),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    ExtensionListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.extensions.length, 2);
  assertEquals(completed.data.extensions[0].name, "@ns/alpha");
  assertEquals(completed.data.extensions[1].name, "@ns/beta");
});

Deno.test("extensionList yields empty list when no extensions", async () => {
  const deps = makeDeps({
    readUpstreamExtensions: () => Promise.resolve({}),
  });
  const events = await collect<ExtensionListEvent>(
    extensionList(createLibSwampContext(), deps),
  );

  const completed = events[1] as Extract<
    ExtensionListEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.extensions.length, 0);
});
