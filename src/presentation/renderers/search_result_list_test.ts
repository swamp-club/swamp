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
import {
  createSearchListRenderer,
  writeSearchResultList,
} from "./search_result_list.ts";
import { captureLog } from "./search_list_test_helpers.ts";
import type { SwampError } from "../../libswamp/errors.ts";

type TestEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: { names: string[]; note?: string } }
  | { kind: "error"; error: SwampError };

Deno.test("writeSearchResultList: separates entries with a blank line and ends with a count", async () => {
  const lines = await captureLog(() =>
    writeSearchResultList(["a\nA", "b"], (s) => s, "things")
  );
  assertEquals(lines, ["a\nA\n\nb", "", "things: 2"]);
});

Deno.test("writeSearchResultList: one entry", async () => {
  const lines = await captureLog(() =>
    writeSearchResultList(["a"], (s) => s, "things")
  );
  assertEquals(lines, ["a", "", "things: 1"]);
});

Deno.test("writeSearchResultList: no entries prints the no-results line and the hint", async () => {
  assertEquals(
    await captureLog(() => writeSearchResultList([], (s) => s, "things")),
    ["No matching things found"],
  );
  assertEquals(
    await captureLog(() =>
      writeSearchResultList([], (s) => s, "things", "Tip: look elsewhere")
    ),
    ["No matching things found", "Tip: look elsewhere"],
  );
});

Deno.test("createSearchListRenderer: lists the configured items, then runs afterList", async () => {
  const renderer = createSearchListRenderer<TestEvent, string>({
    itemLabel: "names",
    items: (e) => e.data.names.filter((n) => n !== "skip"),
    renderEntry: (n) => `name ${n}`,
    afterList: (e) => {
      if (e.data.note) console.log(e.data.note);
    },
    toError: (error) => new Error(error.message),
  });
  const lines = await captureLog(() =>
    renderer.handlers().completed({
      kind: "completed",
      data: { names: ["x", "skip", "y"], note: "the end" },
    })
  );
  assertEquals(lines, ["name x\n\nname y", "", "names: 2", "the end"]);
  assertEquals(renderer.selectedItem(), undefined);
});

Deno.test("createSearchListRenderer: emptyHint is printed only with no results", async () => {
  const renderer = createSearchListRenderer<TestEvent, string>({
    itemLabel: "names",
    items: (e) => e.data.names,
    renderEntry: (n) => n,
    emptyHint: () => "Tip: try again",
    toError: (error) => new Error(error.message),
  });
  assertEquals(
    await captureLog(() =>
      renderer.handlers().completed({ kind: "completed", data: { names: [] } })
    ),
    ["No matching names found", "Tip: try again"],
  );
  assertEquals(
    await captureLog(() =>
      renderer.handlers().completed({
        kind: "completed",
        data: { names: ["n"] },
      })
    ),
    ["n", "", "names: 1"],
  );
});

Deno.test("createSearchListRenderer: an error event throws the converted error", () => {
  const renderer = createSearchListRenderer<TestEvent, string>({
    itemLabel: "names",
    items: (e) => e.data.names,
    renderEntry: (n) => n,
    toError: (error) => new Error(`converted: ${error.message}`),
  });
  assertThrows(
    () =>
      renderer.handlers().error({
        kind: "error",
        error: { code: "boom", message: "it broke" },
      }),
    Error,
    "converted: it broke",
  );
});
