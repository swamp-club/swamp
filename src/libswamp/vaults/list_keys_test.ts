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

Deno.test("vaultListKeys: yields validation error for empty vaultName", async () => {
  const deps = makeDeps();
  const events = await collect<VaultListKeysEvent>(
    vaultListKeys(createLibSwampContext(), deps, { vaultName: "" }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1].kind, "error");
  const error = events[1] as Extract<VaultListKeysEvent, { kind: "error" }>;
  assertEquals(error.error.code, "validation_failed");
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
  const error = events[1] as Extract<VaultListKeysEvent, { kind: "error" }>;
  assertStringIncludes(
    error.error.message,
    "Create a vault using: swamp vault create <type> missing",
  );
});

async function listKeysError(
  vaultName: string,
  vaultNames: string[],
): Promise<string> {
  const deps = makeDeps({
    findVaultByName: () => Promise.resolve(null),
    findAllVaults: () =>
      Promise.resolve(vaultNames.map((name) => ({ name, type: "env" }))),
  });
  const events = await collect<VaultListKeysEvent>(
    vaultListKeys(createLibSwampContext(), deps, { vaultName }),
  );
  const error = events[1] as Extract<VaultListKeysEvent, { kind: "error" }>;
  assertEquals(error.error.code, "not_found");
  return error.error.message;
}

Deno.test("vaultListKeys: explains the reserved token vault instead of suggesting vault create", async () => {
  for (const configured of [[], ["dev-secrets"]]) {
    const message = await listKeysError("_token-secrets", configured);
    assertStringIncludes(message, "swamp's reserved control-plane vault");
    assertStringIncludes(message, "swamp access token reveal <name>");
    assertEquals(message.includes("swamp vault create <type> _"), false);
  }
  assertStringIncludes(
    await listKeysError("_token-secrets", ["dev-secrets"]),
    "Available vaults: dev-secrets",
  );
});

Deno.test("vaultListKeys: does not suggest creating a vault with an invalid name", async () => {
  const message = await listKeysError("MyVault", []);
  assertStringIncludes(message, "'MyVault' is not a valid vault name.");
  assertStringIncludes(message, "swamp vault create <type> <name>");
  assertEquals(message.includes("swamp vault create <type> MyVault"), false);
});
