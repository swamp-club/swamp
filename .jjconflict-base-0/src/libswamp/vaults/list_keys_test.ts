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
  vaultListKeys,
  type VaultListKeysDeps,
  type VaultListKeysEvent,
} from "./list_keys.ts";

function makeDeps(
  overrides?: Partial<VaultListKeysDeps>,
): VaultListKeysDeps {
  return {
    findVaultByName: () => Promise.resolve({ name: "my-vault", type: "env" }),
    findAllVaults: () => Promise.resolve([{ name: "my-vault", type: "env" }]),
    listKeys: () => Promise.resolve(["API_KEY", "SECRET"]),
    ...overrides,
  };
}

Deno.test("vaultListKeys yields resolving then completed", async () => {
  const deps = makeDeps();
  const events = await collect<VaultListKeysEvent>(
    vaultListKeys(createLibSwampContext(), deps, { vaultName: "my-vault" }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    VaultListKeysEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.secretKeys, ["API_KEY", "SECRET"]);
  assertEquals(completed.data.count, 2);
});

Deno.test("vaultListKeys yields error when vault not found", async () => {
  const deps = makeDeps({
    findVaultByName: () => Promise.resolve(null),
    findAllVaults: () =>
      Promise.resolve([{ name: "other-vault", type: "env" }]),
  });
  const events = await collect<VaultListKeysEvent>(
    vaultListKeys(createLibSwampContext(), deps, { vaultName: "missing" }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[1].kind, "error");
  const error = events[1] as Extract<VaultListKeysEvent, { kind: "error" }>;
  assertEquals(error.error.code, "not_found");
});

Deno.test("vaultListKeys yields error when no vaults configured", async () => {
  const deps = makeDeps({
    findVaultByName: () => Promise.resolve(null),
    findAllVaults: () => Promise.resolve([]),
  });
  const events = await collect<VaultListKeysEvent>(
    vaultListKeys(createLibSwampContext(), deps, { vaultName: "missing" }),
  );

  assertEquals(events[1].kind, "error");
});
