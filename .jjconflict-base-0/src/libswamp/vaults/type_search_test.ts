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
  vaultTypeSearch,
  type VaultTypeSearchDeps,
  type VaultTypeSearchEvent,
} from "./type_search.ts";

function makeDeps(
  overrides: Partial<VaultTypeSearchDeps> = {},
): VaultTypeSearchDeps {
  return {
    getVaultTypes: () => [
      {
        type: "local_encryption",
        name: "Local Encryption",
        description: "AES-GCM encrypted local storage",
      },
      {
        type: "aws_secrets_manager",
        name: "AWS Secrets Manager",
        description: "Store secrets in AWS",
      },
    ],
    ...overrides,
  };
}

Deno.test("vaultTypeSearch: returns all vault types with no query", async () => {
  const deps = makeDeps();
  const events = await collect<VaultTypeSearchEvent>(
    vaultTypeSearch(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    VaultTypeSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.query, "");
  assertEquals(completed.data.results.length, 2);
  assertEquals(completed.data.results[0].type, "local_encryption");
  assertEquals(completed.data.results[0].name, "Local Encryption");
});

Deno.test("vaultTypeSearch: passes query through in data", async () => {
  const deps = makeDeps();
  const events = await collect<VaultTypeSearchEvent>(
    vaultTypeSearch(createLibSwampContext(), deps, { query: "aws" }),
  );

  assertEquals(events.length, 2);
  const completed = events[1] as Extract<
    VaultTypeSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.query, "aws");
  assertEquals(completed.data.results.length, 2);
});

Deno.test("vaultTypeSearch: returns empty results when no vault types", async () => {
  const deps = makeDeps({
    getVaultTypes: () => [],
  });
  const events = await collect<VaultTypeSearchEvent>(
    vaultTypeSearch(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  const completed = events[1] as Extract<
    VaultTypeSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 0);
});
