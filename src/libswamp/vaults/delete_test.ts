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
  vaultDelete,
  type VaultDeleteDeps,
  type VaultDeleteEvent,
  vaultDeletePreview,
} from "./delete.ts";

function makeDeps(overrides: Partial<VaultDeleteDeps> = {}): VaultDeleteDeps {
  return {
    findVault: () =>
      Promise.resolve({ id: "v1", name: "my-vault", type: "local_encryption" }),
    listVaultNames: () => Promise.resolve(["my-vault"]),
    secretExists: () => Promise.resolve(true),
    supportsDelete: () => Promise.resolve(true),
    deleteSecret: () => Promise.resolve(),
    publishSecretDeleted: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("vaultDeletePreview: returns preview with secret existence check", async () => {
  const deps = makeDeps();

  const preview = await vaultDeletePreview(
    createLibSwampContext(),
    deps,
    "my-vault",
    "API_KEY",
  );

  assertEquals(preview.vaultName, "my-vault");
  assertEquals(preview.vaultType, "local_encryption");
  assertEquals(preview.secretKey, "API_KEY");
  assertEquals(preview.secretExists, true);
  assertEquals(preview.supportsDelete, true);
});

Deno.test("vaultDeletePreview: throws not_found for missing vault", async () => {
  const deps = makeDeps({
    findVault: () => Promise.resolve(null),
    listVaultNames: () => Promise.resolve(["other-vault"]),
  });

  try {
    await vaultDeletePreview(
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

Deno.test("vaultDeletePreview: reports unsupported when provider lacks delete", async () => {
  const deps = makeDeps({
    supportsDelete: () => Promise.resolve(false),
  });

  const preview = await vaultDeletePreview(
    createLibSwampContext(),
    deps,
    "my-vault",
    "KEY",
  );

  assertEquals(preview.supportsDelete, false);
  assertEquals(preview.secretExists, false);
});

Deno.test("vaultDeletePreview: reports non-existent secret", async () => {
  const deps = makeDeps({
    secretExists: () => Promise.resolve(false),
  });

  const preview = await vaultDeletePreview(
    createLibSwampContext(),
    deps,
    "my-vault",
    "MISSING_KEY",
  );

  assertEquals(preview.secretExists, false);
});

Deno.test("vaultDelete: yields completed after deleting secret", async () => {
  let deletedKey = "";
  const deps = makeDeps({
    deleteSecret: (_vault, key) => {
      deletedKey = key;
      return Promise.resolve();
    },
  });

  const events = await collect<VaultDeleteEvent>(
    vaultDelete(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      key: "API_KEY",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "deleting");
  const completed = events[1] as Extract<
    VaultDeleteEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.vaultName, "my-vault");
  assertEquals(completed.data.secretKey, "API_KEY");
  assertEquals(completed.data.vaultType, "local_encryption");
  assertEquals(deletedKey, "API_KEY");
});

Deno.test("vaultDelete: yields error when vault not found", async () => {
  const deps = makeDeps({
    findVault: () => Promise.resolve(null),
  });

  const events = await collect<VaultDeleteEvent>(
    vaultDelete(createLibSwampContext(), deps, {
      vaultName: "missing",
      key: "KEY",
    }),
  );

  const last = events[events.length - 1] as Extract<
    VaultDeleteEvent,
    { kind: "error" }
  >;
  assertEquals(last.kind, "error");
  assertEquals(last.error.code, "not_found");
});

Deno.test("vaultDelete: publishes VaultSecretDeleted event", async () => {
  let publishedKey = "";
  let publishedVaultName = "";
  const deps = makeDeps({
    publishSecretDeleted: (_id, _type, vaultName, key) => {
      publishedKey = key;
      publishedVaultName = vaultName;
      return Promise.resolve();
    },
  });

  await collect<VaultDeleteEvent>(
    vaultDelete(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      key: "SECRET",
    }),
  );

  assertEquals(publishedKey, "SECRET");
  assertEquals(publishedVaultName, "my-vault");
});
