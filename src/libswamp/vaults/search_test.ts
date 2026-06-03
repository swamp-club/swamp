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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  vaultSearch,
  type VaultSearchDeps,
  type VaultSearchEvent,
} from "./search.ts";

function makeDeps(
  overrides: Partial<VaultSearchDeps> = {},
): VaultSearchDeps {
  return {
    findAllVaults: () =>
      Promise.resolve([
        {
          id: "vault-1",
          name: "default",
          type: "local_encryption",
          createdAt: new Date("2026-01-15T10:00:00Z"),
        },
        {
          id: "vault-2",
          name: "aws-vault",
          type: "aws_secrets_manager",
          createdAt: new Date("2026-02-01T12:00:00Z"),
        },
      ]),
    ...overrides,
  };
}

Deno.test("vaultSearch: returns all vaults with no query", async () => {
  const deps = makeDeps();
  const events = await collect<VaultSearchEvent>(
    vaultSearch(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  const completed = events[1] as Extract<
    VaultSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.query, "");
  assertEquals(completed.data.results.length, 2);
  assertEquals(completed.data.results[0].id, "vault-1");
  assertEquals(completed.data.results[0].name, "default");
  assertEquals(completed.data.results[0].type, "local_encryption");
  assertEquals(completed.data.results[0].createdAt, "2026-01-15T10:00:00.000Z");
});

Deno.test("vaultSearch: passes query through in data", async () => {
  const deps = makeDeps();
  const events = await collect<VaultSearchEvent>(
    vaultSearch(createLibSwampContext(), deps, { query: "aws" }),
  );

  assertEquals(events.length, 2);
  const completed = events[1] as Extract<
    VaultSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.query, "aws");
  assertEquals(completed.data.results.length, 2);
});

Deno.test("vaultSearch: returns empty results when no vaults exist", async () => {
  const deps = makeDeps({
    findAllVaults: () => Promise.resolve([]),
  });
  const events = await collect<VaultSearchEvent>(
    vaultSearch(createLibSwampContext(), deps, {}),
  );

  assertEquals(events.length, 2);
  const completed = events[1] as Extract<
    VaultSearchEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.results.length, 0);
});
