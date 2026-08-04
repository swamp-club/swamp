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

import { assertEquals, assertRejects } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { ControlPlaneStore } from "../datastore/control_plane_store.ts";
import {
  ControlPlaneVaultProvider,
  TOKEN_SECRETS_VAULT_NAME,
} from "./control_plane_vault_provider.ts";

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

Deno.test("ControlPlaneVaultProvider: getName returns the vault name constant", async () => {
  const provider = new ControlPlaneVaultProvider(createMockStore());
  await provider.initialize();
  assertEquals(provider.getName(), TOKEN_SECRETS_VAULT_NAME);
});

Deno.test("ControlPlaneVaultProvider: round-trips a secret through put and get", async () => {
  const provider = new ControlPlaneVaultProvider(createMockStore());
  await provider.initialize();

  await provider.put("my-key", "my-secret");
  const result = await provider.get("my-key");
  assertEquals(result, "my-secret");
});

Deno.test("ControlPlaneVaultProvider: get throws for missing secret", async () => {
  const provider = new ControlPlaneVaultProvider(createMockStore());
  await provider.initialize();

  await assertRejects(
    () => provider.get("nonexistent"),
    Error,
    "not found",
  );
});

Deno.test("ControlPlaneVaultProvider: delete removes a secret", async () => {
  const provider = new ControlPlaneVaultProvider(createMockStore());
  await provider.initialize();

  await provider.put("to-delete", "value");
  assertEquals(await provider.get("to-delete"), "value");

  await provider.delete("to-delete");
  await assertRejects(() => provider.get("to-delete"), Error, "not found");
});

Deno.test("ControlPlaneVaultProvider: list returns stored keys", async () => {
  const provider = new ControlPlaneVaultProvider(createMockStore());
  await provider.initialize();

  await provider.put("key-a", "val-a");
  await provider.put("key-b", "val-b");

  const keys = await provider.list();
  assertEquals(keys.sort(), ["key-a", "key-b"]);
});

Deno.test("ControlPlaneVaultProvider: two instances share the same encryption key", async () => {
  const store = createMockStore();

  const p1 = new ControlPlaneVaultProvider(store);
  await p1.initialize();

  const p2 = new ControlPlaneVaultProvider(store);
  await p2.initialize();

  await p1.put("shared-key", "shared-secret");
  assertEquals(await p2.get("shared-key"), "shared-secret");
});

Deno.test("ControlPlaneVaultProvider: throws if not initialized", async () => {
  const provider = new ControlPlaneVaultProvider(createMockStore());

  await assertRejects(
    () => provider.get("any-key"),
    Error,
    "not initialized",
  );
});

Deno.test("ControlPlaneVaultProvider: works without putIfAbsent", async () => {
  const store = createMockStore();
  const storeWithoutPIA: ControlPlaneStore = {
    put: store.put.bind(store),
    get: store.get.bind(store),
    delete: store.delete.bind(store),
    list: store.list.bind(store),
  };

  const provider = new ControlPlaneVaultProvider(storeWithoutPIA);
  await provider.initialize();

  await provider.put("key", "value");
  assertEquals(await provider.get("key"), "value");
});
