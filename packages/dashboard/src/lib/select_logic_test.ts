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
import {
  filterOptions,
  isNavKey,
  moveActive,
  typeaheadMatch,
} from "./select_logic.ts";

const opts = [
  { label: "All prefixes" },
  { label: "backup", hint: "8" },
  { label: "billing", hint: "5", disabled: true },
  { label: "deploy", hint: "12" },
  { label: "etl", hint: "8" },
];

Deno.test("isNavKey: only navigation keys", () => {
  assertEquals(isNavKey("ArrowDown"), true);
  assertEquals(isNavKey("a"), false);
});

Deno.test("moveActive: skips disabled, stops at the ends", () => {
  assertEquals(moveActive(opts, 1, "ArrowDown"), 3);
  assertEquals(moveActive(opts, 3, "ArrowUp"), 1);
  assertEquals(moveActive(opts, 4, "ArrowDown"), 4);
  assertEquals(moveActive(opts, 0, "ArrowUp"), 0);
  assertEquals(moveActive(opts, 2, "Home"), 0);
  assertEquals(moveActive(opts, 0, "End"), 4);
});

Deno.test("moveActive: nothing active starts at an end", () => {
  assertEquals(moveActive(opts, -1, "ArrowDown"), 0);
  assertEquals(moveActive(opts, -1, "ArrowUp"), 4);
  assertEquals(moveActive([{ label: "x", disabled: true }], -1, "Home"), -1);
});

Deno.test("moveActive: page keys jump and clamp", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ label: `o${i}` }));
  assertEquals(moveActive(many, 0, "PageDown"), 8);
  assertEquals(moveActive(many, 25, "PageDown"), 29);
  assertEquals(moveActive(many, 10, "PageUp"), 2);
  assertEquals(moveActive(many, 3, "PageUp"), 0);
});

Deno.test("typeaheadMatch: prefix match after the current option", () => {
  assertEquals(typeaheadMatch(opts, "d", 0), 3);
  assertEquals(typeaheadMatch(opts, "de", 3), 3);
  assertEquals(typeaheadMatch(opts, "z", 0), -1);
  assertEquals(typeaheadMatch(opts, "", 0), -1);
});

Deno.test("typeaheadMatch: repeating a letter cycles, skipping disabled", () => {
  assertEquals(typeaheadMatch(opts, "b", 0), 1);
  // "billing" is disabled, so "bb" wraps back around to "backup".
  assertEquals(typeaheadMatch(opts, "bb", 1), 1);
});

Deno.test("filterOptions: fuzzy over label and hint", () => {
  assertEquals(filterOptions(opts, "dep").map((o) => o.label), ["deploy"]);
  assertEquals(filterOptions(opts, "").length, opts.length);
});
