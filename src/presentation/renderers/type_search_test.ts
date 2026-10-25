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
import { createTypeSearchRenderer } from "./type_search.tsx";
import { captureLog } from "./search_list_test_helpers.ts";

Deno.test("createTypeSearchRenderer: non-interactive log lists the matching types", async () => {
  const renderer = createTypeSearchRenderer("log", undefined, {
    interactive: false,
  });
  const lines = await captureLog(() =>
    renderer.handlers().completed({
      kind: "completed",
      data: {
        query: "shell",
        results: [
          { raw: "command/shell", normalized: "command/shell" },
          { raw: "swamp/echo", normalized: "swamp/echo" },
        ],
      },
    })
  );
  assertEquals(lines, ["command/shell", "", "types: 1"]);
});

Deno.test("createTypeSearchRenderer: non-interactive log with no match suggests extension search", async () => {
  const renderer = createTypeSearchRenderer("log", undefined, {
    interactive: false,
  });
  const lines = await captureLog(() =>
    renderer.handlers().completed({
      kind: "completed",
      data: { query: "zzz", results: [] },
    })
  );
  assertEquals(lines, [
    "No matching types found",
    "Tip: run `swamp extension search zzz` to check community extensions",
  ]);
});
