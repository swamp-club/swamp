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

import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { ControlPlaneStore } from "../datastore/control_plane_store.ts";
import { UserError } from "../errors.ts";
import { initializeControlPlaneVault } from "./control_plane_vault_init.ts";
import { TOKEN_SECRETS_VAULT_NAME } from "./control_plane_vault_provider.ts";
import type { VaultProvider } from "./vault_provider.ts";
import { VaultService } from "./vault_service.ts";

await initializeLogging({});

function createMockStore(): ControlPlaneStore {
  const data = new Map<string, Uint8Array>();
  return {
    put(key: string, value: Uint8Array): Promise<void> {
      data.set(key, new Uint8Array(value));
      return Promise.resolve();
    },
    putIfAbsent(key: string, value: Uint8Array): Promise<boolean> {
      if (data.has(key)) return Promise.resolve(false);
      data.set(key, new Uint8Array(value));
      return Promise.resolve(true);
    },
    get(key: string): Promise<Uint8Array | null> {
      return Promise.resolve(data.get(key) ?? null);
    },
    delete(key: string): Promise<void> {
      data.delete(key);
      return Promise.resolve();
    },
    list(prefix: string): Promise<string[]> {
      return Promise.resolve(
        [...data.keys()].filter((k) => k.startsWith(prefix)),
      );
    },
  };
}

function createFailingStore(): ControlPlaneStore {
  return {
    put(): Promise<void> {
      return Promise.reject(new Error("S3 unreachable"));
    },
    get(): Promise<Uint8Array | null> {
      return Promise.reject(new Error("S3 unreachable"));
    },
    delete(): Promise<void> {
      return Promise.reject(new Error("S3 unreachable"));
    },
    list(): Promise<string[]> {
      return Promise.reject(new Error("S3 unreachable"));
    },
  };
}

Deno.test("initializeControlPlaneVault: returns provider with isRemote=true when flagged as remote", async () => {
  const store = createMockStore();
  const result = await initializeControlPlaneVault(store, true);
  assertNotEquals(result, null);
  assertEquals(result!.isRemote, true);
  assertEquals(result!.provider.getName(), TOKEN_SECRETS_VAULT_NAME);
});

Deno.test("initializeControlPlaneVault: returns provider with isRemote=false for local store", async () => {
  const store = createMockStore();
  const result = await initializeControlPlaneVault(store, false);
  assertNotEquals(result, null);
  assertEquals(result!.isRemote, false);
  assertEquals(result!.provider.getName(), TOKEN_SECRETS_VAULT_NAME);
});

Deno.test("initializeControlPlaneVault: provider can round-trip a secret", async () => {
  const store = createMockStore();
  const result = await initializeControlPlaneVault(store, false);
  assertNotEquals(result, null);

  await result!.provider.put("test-key", "test-value");
  const retrieved = await result!.provider.get("test-key");
  assertEquals(retrieved, "test-value");
});

Deno.test("initializeControlPlaneVault: throws the store failure for a remote control plane", async () => {
  const store = createFailingStore();
  const error = await assertRejects(
    () => initializeControlPlaneVault(store, true),
    UserError,
  );
  assertStringIncludes(error.message, TOKEN_SECRETS_VAULT_NAME);
  assertStringIncludes(error.message, "remote datastore");
  assertStringIncludes(error.message, "S3 unreachable");
  assertStringIncludes(
    error.message,
    "Check the datastore credentials and endpoint, then rerun.",
  );
});

Deno.test("initializeControlPlaneVault: throws the store failure for a local control plane", async () => {
  const store = createFailingStore();
  const error = await assertRejects(
    () => initializeControlPlaneVault(store, false),
    UserError,
  );
  assertStringIncludes(error.message, TOKEN_SECRETS_VAULT_NAME);
  assertStringIncludes(error.message, "local control plane");
  assertStringIncludes(error.message, "S3 unreachable");
  assertStringIncludes(
    error.message,
    "Check that the local control-plane store is readable and intact",
  );
});

Deno.test("initializeControlPlaneVault: a failed init does not replace the registered provider", async () => {
  const sentinel: VaultProvider = {
    get: () => Promise.resolve("sentinel-value"),
    put: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    getName: () => TOKEN_SECRETS_VAULT_NAME,
  };
  VaultService.registerGlobalProvider(
    TOKEN_SECRETS_VAULT_NAME,
    "control_plane",
    sentinel,
  );

  await assertRejects(
    () => initializeControlPlaneVault(createFailingStore(), true),
    UserError,
  );

  const tempDir = await Deno.makeTempDir();
  try {
    const vaultService = await VaultService.fromRepository(tempDir);
    assertEquals(
      await vaultService.get(TOKEN_SECRETS_VAULT_NAME, "any-key"),
      "sentinel-value",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});
