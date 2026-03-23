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
  vaultPut,
  type VaultPutDeps,
  type VaultPutEvent,
  vaultPutPreview,
} from "./put.ts";

function makeDeps(overrides: Partial<VaultPutDeps> = {}): VaultPutDeps {
  return {
    findVault: () =>
      Promise.resolve({ id: "v1", name: "my-vault", type: "env" }),
    listVaultNames: () => Promise.resolve(["my-vault"]),
    secretExists: () => Promise.resolve(false),
    putSecret: () => Promise.resolve(),
    publishSecretUpdated: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("vaultPutPreview: returns preview with secret existence check", async () => {
  const deps = makeDeps({
    secretExists: () => Promise.resolve(true),
  });

  const preview = await vaultPutPreview(
    createLibSwampContext(),
    deps,
    "my-vault",
    "API_KEY",
  );

  assertEquals(preview.vaultName, "my-vault");
  assertEquals(preview.vaultType, "env");
  assertEquals(preview.secretKey, "API_KEY");
  assertEquals(preview.secretExists, true);
});

Deno.test("vaultPutPreview: throws not_found for missing vault", async () => {
  const deps = makeDeps({
    findVault: () => Promise.resolve(null),
    listVaultNames: () => Promise.resolve(["other-vault"]),
  });

  try {
    await vaultPutPreview(
      createLibSwampContext(),
      deps,
      "missing-vault",
      "KEY",
    );
    throw new Error("Expected to throw");
  } catch (error) {
    assertEquals((error as { code: string }).code, "not_found");
  }
});

Deno.test("vaultPut: yields completed after storing secret", async () => {
  let storedKey = "";
  let storedValue = "";
  const deps = makeDeps({
    putSecret: (_vault, key, value) => {
      storedKey = key;
      storedValue = value;
      return Promise.resolve();
    },
  });

  const events = await collect<VaultPutEvent>(
    vaultPut(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      key: "API_KEY",
      value: "secret123",
      overwritten: false,
    }),
  );

  assertEquals(events.length, 2);
  const completed = events[1] as Extract<
    VaultPutEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.vaultName, "my-vault");
  assertEquals(completed.data.secretKey, "API_KEY");
  assertEquals(completed.data.overwritten, false);
  assertEquals(storedKey, "API_KEY");
  assertEquals(storedValue, "secret123");
});

Deno.test("vaultPut: yields error when vault not found", async () => {
  const deps = makeDeps({
    findVault: () => Promise.resolve(null),
  });

  const events = await collect<VaultPutEvent>(
    vaultPut(createLibSwampContext(), deps, {
      vaultName: "missing",
      key: "KEY",
      value: "val",
      overwritten: false,
    }),
  );

  const last = events[events.length - 1] as Extract<
    VaultPutEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});
