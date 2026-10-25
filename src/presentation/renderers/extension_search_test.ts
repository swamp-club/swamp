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
import { createExtensionSearchRenderer } from "./extension_search.tsx";
import { captureLog } from "./search_list_test_helpers.ts";
import type { ExtensionSearchItem } from "../../libswamp/extensions/search.ts";

function extension(name: string): ExtensionSearchItem {
  return {
    name,
    description: `${name} description`,
    repository: null,
    repositoryVerified: null,
    repositoryVerifiedUrl: null,
    latestVersion: "1.0.0",
    latestRc: null,
    latestBeta: null,
    platforms: [],
    labels: [],
    contentTypes: [],
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
  };
}

Deno.test("createExtensionSearchRenderer: non-interactive log lists every extension the server returned", async () => {
  const renderer = createExtensionSearchRenderer("log", { interactive: false });
  const lines = await captureLog(() =>
    renderer.handlers().completed({
      kind: "completed",
      data: {
        query: "aws",
        results: [extension("@acme/aws"), extension("@acme/aws-s3")],
        meta: { total: 2, page: 1, perPage: 20 },
      },
    })
  );
  assertEquals(lines.length, 3);
  assertStringIncludes(lines[0], "@acme/aws v1.0.0\n@acme/aws description");
  assertStringIncludes(lines[0], "@acme/aws-s3 v1.0.0");
  assertEquals(lines[2], "extensions: 2");
  assertEquals(renderer.selectedAction(), undefined);
});
