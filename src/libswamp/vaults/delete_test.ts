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
    supportsDelete: () => Promise.resolve(true),
    deleteSecret: () => Promise.resolve(),
    publishSecretDeleted: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("vaultDeletePreview: returns preview for existing vault", async () => {
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

async function deletePreviewError(
  vaultName: string,
  vaultNames: string[],
): Promise<string> {
  const deps = makeDeps({
    findVault: () => Promise.resolve(null),
    listVaultNames: () => Promise.resolve(vaultNames),
  });
  try {
    await vaultDeletePreview(createLibSwampContext(), deps, vaultName, "KEY");
  } catch (error) {
    const swampError = error as { code: string; message: string };
    assertEquals(swampError.code, "not_found");
    return swampError.message;
  }
  throw new Error("Expected to throw");
}

Deno.test("vaultDeletePreview: suggests vault create for a valid name when no vaults are configured", async () => {
  assertStringIncludes(
    await deletePreviewError("missing-vault", []),
    "Create a vault using: swamp vault create <type> missing-vault",
  );
});

Deno.test("vaultDeletePreview: explains the reserved token vault instead of suggesting vault create", async () => {
  for (const configured of [[], ["dev-secrets"]]) {
    const message = await deletePreviewError("_token-secrets", configured);
    assertStringIncludes(message, "swamp's reserved control-plane vault");
    assertStringIncludes(message, "swamp access token reveal <name>");
    assertEquals(message.includes("swamp vault create <type> _"), false);
  }
  assertStringIncludes(
    await deletePreviewError("_token-secrets", ["dev-secrets"]),
    "Available vaults: dev-secrets",
  );
});

Deno.test("vaultDeletePreview: explains other reserved names instead of suggesting vault create", async () => {
  const message = await deletePreviewError("_foo", []);
  assertStringIncludes(message, "reserved for swamp's internal vaults");
  assertEquals(message.includes("swamp vault create <type> _foo"), false);
});

Deno.test("vaultDeletePreview: does not suggest creating a vault with an invalid name", async () => {
  const message = await deletePreviewError("MyVault", []);
  assertStringIncludes(message, "'MyVault' is not a valid vault name.");
  assertStringIncludes(message, "swamp vault create <type> <name>");
  assertEquals(message.includes("swamp vault create <type> MyVault"), false);
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

Deno.test("vaultDelete: succeeds when provider normalizes key names", async () => {
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
      key: "client_id",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0].kind, "deleting");
  const completed = events[1] as Extract<
    VaultDeleteEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.secretKey, "client_id");
  assertEquals(deletedKey, "client_id");
});
