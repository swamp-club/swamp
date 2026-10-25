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
import { createVaultSearchRenderer } from "./vault_search.tsx";
import { captureLog } from "./search_list_test_helpers.ts";

Deno.test("createVaultSearchRenderer: non-interactive log lists the matching vaults", async () => {
  const renderer = createVaultSearchRenderer("log", undefined, {
    interactive: false,
  });
  const lines = await captureLog(() =>
    renderer.handlers().completed({
      kind: "completed",
      data: {
        query: "prod",
        results: [
          {
            id: "v1",
            name: "prod-keys",
            type: "local_encryption",
            createdAt: "",
          },
          {
            id: "v2",
            name: "dev-keys",
            type: "local_encryption",
            createdAt: "",
          },
        ],
      },
    })
  );
  assertEquals(lines, [
    "prod-keys (local_encryption)\nID: v1",
    "",
    "vaults: 1",
  ]);
});
