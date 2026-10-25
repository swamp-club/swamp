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
import { createVaultTypeSearchRenderer } from "./vault_type_search.tsx";
import { captureLog } from "./search_list_test_helpers.ts";

Deno.test("createVaultTypeSearchRenderer: non-interactive log lists the matching vault types", async () => {
  const renderer = createVaultTypeSearchRenderer("log", { interactive: false });
  const lines = await captureLog(() =>
    renderer.handlers().completed({
      kind: "completed",
      data: {
        query: "aws",
        results: [
          { type: "aws-sm", name: "AWS", description: "Secrets Manager" },
          { type: "local", name: "Local", description: "On disk" },
        ],
      },
    })
  );
  assertEquals(lines, ["aws-sm - AWS\nSecrets Manager", "", "vault types: 1"]);
});
