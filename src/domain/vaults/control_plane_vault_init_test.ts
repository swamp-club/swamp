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
import {
  controlPlaneVaultInitError,
  initializeControlPlaneVault,
  resolveTokenSecretsKey,
  type TokenSecretsKeyVaultReader,
} from "./control_plane_vault_init.ts";
import { TOKEN_SECRETS_VAULT_NAME } from "./control_plane_vault_provider.ts";
import {
  classifyTokenKeyRecord,
  TokenSecretsKeyError,
} from "./token_secrets_key.ts";
import type { VaultProvider } from "./vault_provider.ts";
import { VaultService } from "./vault_service.ts";

await initializeLogging({});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-control-plane-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

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

const KEY_REF = { vault: "prod-secrets", key: "swamp-token-key" };

function keyReader(
  secrets: Record<string, string>,
): TokenSecretsKeyVaultReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    get(vaultName: string, secretKey: string): Promise<string> {
      calls.push(`${vaultName}/${secretKey}`);
      const value = secrets[`${vaultName}/${secretKey}`];
      return value === undefined
        ? Promise.reject(new Error(`Secret '${secretKey}' not found`))
        : Promise.resolve(value);
    },
  };
}

function randomKeyBase64(): string {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  );
}

Deno.test("resolveTokenSecretsKey: reads and decodes the key from the named vault", async () => {
  const value = randomKeyBase64();
  const reader = keyReader({ "prod-secrets/swamp-token-key": value });
  const resolved = await resolveTokenSecretsKey(KEY_REF, reader);
  assertEquals(resolved.ref, KEY_REF);
  assertEquals(btoa(String.fromCharCode(...resolved.key)), value);
  assertEquals(reader.calls, ["prod-secrets/swamp-token-key"]);
});

Deno.test("resolveTokenSecretsKey: a missing secret fails closed naming the vault and key", async () => {
  const error = await assertRejects(
    () => resolveTokenSecretsKey(KEY_REF, keyReader({})),
    UserError,
  );
  assertStringIncludes(error.message, "vault 'prod-secrets'");
  assertStringIncludes(error.message, "key 'swamp-token-key'");
  assertStringIncludes(error.message, "not found");
});

Deno.test("resolveTokenSecretsKey: an unusable value fails closed without echoing it", async () => {
  const value = "short-and-wrong";
  const error = await assertRejects(
    () =>
      resolveTokenSecretsKey(
        KEY_REF,
        keyReader({ "prod-secrets/swamp-token-key": value }),
      ),
    UserError,
  );
  assertStringIncludes(error.message, "is not usable");
  assertEquals(error.message.includes(value), false);
});

Deno.test("initializeControlPlaneVault: with a token secrets key the store gets a marker, not a key", async () => {
  const store = createMockStore();
  const result = await initializeControlPlaneVault(store, true, {
    tokenSecretsKey: KEY_REF,
    vaultService: () =>
      Promise.resolve(
        keyReader({ "prod-secrets/swamp-token-key": randomKeyBase64() }),
      ),
  });
  await result.provider.put("server-token-a", "secret-a");
  assertEquals(await result.provider.get("server-token-a"), "secret-a");
  assertEquals(
    classifyTokenKeyRecord(await store.get("token-secrets/encryption-key"))
      .kind,
    "marker",
  );
});

Deno.test("initializeControlPlaneVault: without a token secrets key the vault service is never built", async () => {
  let built = false;
  await initializeControlPlaneVault(createMockStore(), true, {
    vaultService: () => {
      built = true;
      return Promise.resolve(keyReader({}));
    },
  });
  assertEquals(built, false);
});

Deno.test("initializeControlPlaneVault: a key error is reported as is, without the datastore hint", async () => {
  const error = await assertRejects(
    () =>
      initializeControlPlaneVault(createMockStore(), true, {
        tokenSecretsKey: KEY_REF,
        vaultService: () => Promise.resolve(keyReader({})),
      }),
    UserError,
  );
  assertStringIncludes(error.message, "Could not read the token secrets key");
  assertEquals(error.message.includes("datastore credentials"), false);
});

Deno.test("controlPlaneVaultInitError: other UserErrors still get the vault prefix and datastore hint", () => {
  const error = controlPlaneVaultInitError(
    new UserError("Namespace mismatch: bound to root"),
    true,
  );
  assertStringIncludes(error.message, TOKEN_SECRETS_VAULT_NAME);
  assertStringIncludes(error.message, "Namespace mismatch: bound to root");
  assertStringIncludes(error.message, "Check the datastore credentials");
});

Deno.test("controlPlaneVaultInitError: a token secrets key error is returned unchanged", () => {
  const original = new TokenSecretsKeyError("fix the key");
  assertEquals(controlPlaneVaultInitError(original, true), original);
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

  await withTempDir(async (tempDir) => {
    const vaultService = await VaultService.fromRepository(tempDir);
    assertEquals(
      await vaultService.get(TOKEN_SECRETS_VAULT_NAME, "any-key"),
      "sentinel-value",
    );
  });
});
