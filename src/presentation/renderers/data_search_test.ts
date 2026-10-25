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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { createDataSearchRenderer } from "./data_search.tsx";
import { captureLog } from "./search_list_test_helpers.ts";
import type { DataSearchItem } from "../../libswamp/data/search.ts";

function item(name: string): DataSearchItem {
  return {
    id: `id-${name}`,
    name,
    version: 1,
    contentType: "application/json",
    type: "resource",
    lifetime: "infinite",
    lifecycle: "",
    ownerType: "model-method",
    ownerRef: "web",
    modelId: "m1",
    modelName: "web",
    modelType: "command/shell",
    streaming: false,
    size: 10,
    createdAt: "2026-10-25T00:00:00.000Z",
    tags: {},
  };
}

Deno.test("createDataSearchRenderer: non-interactive log lists every result the server returned", async () => {
  const renderer = createDataSearchRenderer("log", undefined, {
    interactive: false,
  });
  const lines = await captureLog(() =>
    renderer.handlers().completed({
      kind: "completed",
      data: {
        query: "",
        filters: {},
        results: [item("alpha"), item("beta")],
        total: 2,
        limited: false,
      },
    })
  );
  assertEquals(lines.length, 3);
  assertStringIncludes(lines[0], "alpha");
  assertStringIncludes(lines[0], "beta");
  assertEquals(lines[2], "data: 2");
});
