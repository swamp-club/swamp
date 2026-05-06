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
  vaultReadSecret,
  type VaultReadSecretDeps,
  type VaultReadSecretEvent,
} from "./read_secret.ts";

function makeDeps(
  overrides?: Partial<VaultReadSecretDeps>,
): VaultReadSecretDeps {
  return {
    findVault: () =>
      Promise.resolve({
        id: "vault-1",
        name: "my-vault",
        type: "local_encryption",
      }),
    listVaultNames: () => Promise.resolve(["my-vault"]),
    readSecret: () => Promise.resolve("sk-test-12345"),
    publishSecretRead: () => Promise.resolve(),
    ...overrides,
  };
}

Deno.test("vaultReadSecret: yields resolving then completed with secret value", async () => {
  const published: string[] = [];
  const deps = makeDeps({
    publishSecretRead: (_id, _type, _name, key) => {
      published.push(key);
      return Promise.resolve();
    },
  });
  const events = await collect<VaultReadSecretEvent>(
    vaultReadSecret(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      secretKey: "API_KEY",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "resolving" });
  assertEquals(events[1].kind, "completed");
  const completed = events[1] as Extract<
    VaultReadSecretEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.vaultName, "my-vault");
  assertEquals(completed.data.secretKey, "API_KEY");
  assertEquals(completed.data.vaultType, "local_encryption");
  assertEquals(completed.data.value, "sk-test-12345");
  assertEquals(published, ["API_KEY"]);
});

Deno.test("vaultReadSecret: yields error when vault not found", async () => {
  const deps = makeDeps({
    findVault: () => Promise.resolve(null),
    listVaultNames: () => Promise.resolve(["other-vault"]),
  });
  const events = await collect<VaultReadSecretEvent>(
    vaultReadSecret(createLibSwampContext(), deps, {
      vaultName: "missing",
      secretKey: "key",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[1].kind, "error");
  const error = events[1] as Extract<VaultReadSecretEvent, { kind: "error" }>;
  assertEquals(error.error.code, "not_found");
});

Deno.test("vaultReadSecret: yields error when no vaults configured", async () => {
  const deps = makeDeps({
    findVault: () => Promise.resolve(null),
    listVaultNames: () => Promise.resolve([]),
  });
  const events = await collect<VaultReadSecretEvent>(
    vaultReadSecret(createLibSwampContext(), deps, {
      vaultName: "missing",
      secretKey: "key",
    }),
  );

  assertEquals(events[1].kind, "error");
  const error = events[1] as Extract<VaultReadSecretEvent, { kind: "error" }>;
  assertEquals(error.error.code, "not_found");
});

Deno.test("vaultReadSecret: yields error when vault name is empty", async () => {
  const deps = makeDeps();
  const events = await collect<VaultReadSecretEvent>(
    vaultReadSecret(createLibSwampContext(), deps, {
      vaultName: "",
      secretKey: "key",
    }),
  );

  assertEquals(events[1].kind, "error");
  const error = events[1] as Extract<VaultReadSecretEvent, { kind: "error" }>;
  assertEquals(error.error.code, "validation_failed");
});

Deno.test("vaultReadSecret: yields error when secret key is empty", async () => {
  const deps = makeDeps();
  const events = await collect<VaultReadSecretEvent>(
    vaultReadSecret(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      secretKey: "",
    }),
  );

  assertEquals(events[1].kind, "error");
  const error = events[1] as Extract<VaultReadSecretEvent, { kind: "error" }>;
  assertEquals(error.error.code, "validation_failed");
});

Deno.test("vaultReadSecret: yields error when secret key not found in vault", async () => {
  const deps = makeDeps({
    readSecret: () => Promise.reject(new Error("Secret not found")),
  });
  const events = await collect<VaultReadSecretEvent>(
    vaultReadSecret(createLibSwampContext(), deps, {
      vaultName: "my-vault",
      secretKey: "missing-key",
    }),
  );

  assertEquals(events[1].kind, "error");
  const error = events[1] as Extract<VaultReadSecretEvent, { kind: "error" }>;
  assertEquals(error.error.code, "not_found");
});
