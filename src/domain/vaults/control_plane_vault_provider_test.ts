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
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { ControlPlaneStore } from "../datastore/control_plane_store.ts";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  type EncryptedBlob,
  importAesKey,
} from "../crypto/aes_gcm.ts";
import { UserError } from "../errors.ts";
import {
  ControlPlaneVaultProvider,
  hasCoLocatedTokenKey,
  TOKEN_SECRETS_VAULT_NAME,
} from "./control_plane_vault_provider.ts";
import {
  classifyTokenKeyRecord,
  tokenKeyFingerprint,
  TokenSecretsKeyError,
} from "./token_secrets_key.ts";

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

// ── External key (serve.yaml token-secrets) ─────────────────────────

const KEY_PATH = "token-secrets/encryption-key";
const VALUES_PREFIX = "token-secrets/values/";
const REF = { vault: "prod-secrets", key: "swamp-token-key" };

function randomKeyBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

function externalProvider(
  store: ControlPlaneStore,
  key: Uint8Array,
): ControlPlaneVaultProvider {
  return new ControlPlaneVaultProvider(store, {
    externalKey: { ref: REF, key },
  });
}

async function readBlob(
  store: ControlPlaneStore,
  name: string,
): Promise<EncryptedBlob> {
  const data = await store.get(`${VALUES_PREFIX}${name}`);
  return JSON.parse(new TextDecoder().decode(data!));
}

Deno.test("ControlPlaneVaultProvider: without an external key, a marker record fails closed naming the recorded vault", async () => {
  const store = createMockStore();
  await externalProvider(store, randomKeyBytes()).initialize();

  const err = await assertRejects(
    () => new ControlPlaneVaultProvider(store).initialize(),
    UserError,
  );
  assertStringIncludes(err.message, "vault 'prod-secrets'");
  assertStringIncludes(err.message, "key 'swamp-token-key'");
  assertStringIncludes(err.message, "token-secrets block");
});

Deno.test("ControlPlaneVaultProvider: an external key on a fresh store writes a marker and never the key", async () => {
  const store = createMockStore();
  const key = randomKeyBytes();
  const provider = externalProvider(store, key);
  await provider.initialize();
  await provider.put("server-token-a", "secret-a");

  const record = classifyTokenKeyRecord(await store.get(KEY_PATH));
  assertEquals(record.kind, "marker");
  if (record.kind === "marker") {
    assertEquals(record.marker.vault, REF.vault);
    assertEquals(record.marker.fingerprint, await tokenKeyFingerprint(key));
  }
  assertEquals(
    await aesGcmDecrypt(
      await readBlob(store, "server-token-a"),
      await importAesKey(key),
    ),
    "secret-a",
  );
});

Deno.test("ControlPlaneVaultProvider: instances with the same external key share secrets", async () => {
  const store = createMockStore();
  const key = randomKeyBytes();
  const first = externalProvider(store, key);
  await first.initialize();
  await first.put("server-token-a", "secret-a");

  const second = externalProvider(store, new Uint8Array(key));
  await second.initialize();
  assertEquals(await second.get("server-token-a"), "secret-a");
});

Deno.test("ControlPlaneVaultProvider: a different external key fails closed without revealing either key", async () => {
  const store = createMockStore();
  const key = randomKeyBytes();
  await externalProvider(store, key).initialize();

  const other = randomKeyBytes();
  const err = await assertRejects(
    () => externalProvider(store, other).initialize(),
    UserError,
  );
  assertStringIncludes(err.message, "is not the key");
  for (const bytes of [key, other]) {
    assert(!err.message.includes(btoa(String.fromCharCode(...bytes))));
  }
});

Deno.test("ControlPlaneVaultProvider: migrates every secret from a co-located key and removes it", async () => {
  const store = createMockStore();
  const legacy = new ControlPlaneVaultProvider(store);
  await legacy.initialize();
  await legacy.put("server-token-a", "secret-a");
  await legacy.put("enrollment-token-b", "secret-b");
  const legacyKeyBytes = new Uint8Array((await store.get(KEY_PATH))!);

  const migrated = externalProvider(store, randomKeyBytes());
  await migrated.initialize();

  assertEquals(await migrated.get("server-token-a"), "secret-a");
  assertEquals(await migrated.get("enrollment-token-b"), "secret-b");
  assertEquals(
    classifyTokenKeyRecord(await store.get(KEY_PATH)).kind,
    "marker",
  );
  // The stored ciphertext no longer opens with the old co-located key.
  const legacyKey = await importAesKey(legacyKeyBytes);
  for (const name of ["server-token-a", "enrollment-token-b"]) {
    const blob = await readBlob(store, name);
    await assertRejects(() => aesGcmDecrypt(blob, legacyKey));
  }
  await assertRejects(
    () => new ControlPlaneVaultProvider(store).initialize(),
    UserError,
  );
});

Deno.test("ControlPlaneVaultProvider: with migrate false, a co-located key is left alone and startup fails", async () => {
  const store = createMockStore();
  const legacy = new ControlPlaneVaultProvider(store);
  await legacy.initialize();
  await legacy.put("server-token-a", "secret-a");
  const keyBefore = await store.get(KEY_PATH);
  const blobBefore = await store.get(`${VALUES_PREFIX}server-token-a`);

  const err = await assertRejects(
    () =>
      new ControlPlaneVaultProvider(store, {
        externalKey: { ref: REF, key: randomKeyBytes() },
        migrate: false,
      }).initialize(),
    TokenSecretsKeyError,
  );
  assertStringIncludes(err.message, "Restart swamp serve");
  assertEquals(await store.get(KEY_PATH), keyBefore);
  assertEquals(await store.get(`${VALUES_PREFIX}server-token-a`), blobBefore);
  assertEquals(await legacy.get("server-token-a"), "secret-a");
});

Deno.test("ControlPlaneVaultProvider: resumes a migration interrupted before the marker was written", async () => {
  const store = createMockStore();
  const legacy = new ControlPlaneVaultProvider(store);
  await legacy.initialize();
  await legacy.put("server-token-a", "secret-a");
  await legacy.put("server-token-b", "secret-b");

  // Simulate a crash after secret b was re-encrypted: the co-located key is
  // still in place and b is already under the external key.
  const key = randomKeyBytes();
  const reencrypted = await aesGcmEncrypt("secret-b", await importAesKey(key));
  await store.put(
    `${VALUES_PREFIX}server-token-b`,
    new TextEncoder().encode(JSON.stringify(reencrypted)),
  );

  const resumed = externalProvider(store, key);
  await resumed.initialize();
  assertEquals(await resumed.get("server-token-a"), "secret-a");
  assertEquals(await resumed.get("server-token-b"), "secret-b");
  assertEquals(
    classifyTokenKeyRecord(await store.get(KEY_PATH)).kind,
    "marker",
  );
});

Deno.test("ControlPlaneVaultProvider: migration leaves entries neither key decrypts untouched", async () => {
  const store = createMockStore();
  const legacy = new ControlPlaneVaultProvider(store);
  await legacy.initialize();
  await legacy.put("server-token-a", "secret-a");

  const stray = await aesGcmEncrypt(
    "lost",
    await importAesKey(randomKeyBytes()),
  );
  const strayBytes = new TextEncoder().encode(JSON.stringify(stray));
  const garbageBytes = new TextEncoder().encode("not json");
  await store.put(`${VALUES_PREFIX}server-token-lost`, strayBytes);
  await store.put(`${VALUES_PREFIX}server-token-garbage`, garbageBytes);

  const migrated = externalProvider(store, randomKeyBytes());
  await migrated.initialize();

  assertEquals(await migrated.get("server-token-a"), "secret-a");
  assertEquals(
    await store.get(`${VALUES_PREFIX}server-token-lost`),
    strayBytes,
  );
  assertEquals(
    await store.get(`${VALUES_PREFIX}server-token-garbage`),
    garbageBytes,
  );
  assertEquals(
    classifyTokenKeyRecord(await store.get(KEY_PATH)).kind,
    "marker",
  );
});

Deno.test("ControlPlaneVaultProvider: an external key migrates a co-located key written by a racing instance", async () => {
  const store = createMockStore();
  let raced = false;
  // An instance without the opt-in wins putIfAbsent between the external
  // provider's read of the key record and its own putIfAbsent.
  const racingStore: ControlPlaneStore = {
    ...store,
    putIfAbsent: async (path, data) => {
      if (!raced && path === KEY_PATH) {
        raced = true;
        const legacy = new ControlPlaneVaultProvider(store);
        await legacy.initialize();
        await legacy.put("server-token-a", "secret-a");
      }
      return await store.putIfAbsent!(path, data);
    },
  };

  const provider = externalProvider(racingStore, randomKeyBytes());
  await provider.initialize();
  assertEquals(raced, true);
  assertEquals(await provider.get("server-token-a"), "secret-a");
  assertEquals(
    classifyTokenKeyRecord(await store.get(KEY_PATH)).kind,
    "marker",
  );
});

Deno.test("hasCoLocatedTokenKey: true only for a co-located key record", async () => {
  const legacyStore = createMockStore();
  await new ControlPlaneVaultProvider(legacyStore).initialize();
  assertEquals(
    hasCoLocatedTokenKey(
      new Map([[KEY_PATH, (await legacyStore.get(KEY_PATH))!]]),
    ),
    true,
  );

  const markerStore = createMockStore();
  await externalProvider(markerStore, randomKeyBytes()).initialize();
  assertEquals(
    hasCoLocatedTokenKey(
      new Map([[KEY_PATH, (await markerStore.get(KEY_PATH))!]]),
    ),
    false,
  );
  assertEquals(hasCoLocatedTokenKey(new Map()), false);
});
