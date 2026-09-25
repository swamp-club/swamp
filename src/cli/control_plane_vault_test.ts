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
import { join } from "@std/path";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
  SyncCapabilities,
} from "../domain/datastore/datastore_sync_service.ts";
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import { UserError } from "../domain/errors.ts";
import { TOKEN_SECRETS_VAULT_NAME } from "../domain/vaults/control_plane_vault_provider.ts";
import { classifyTokenKeyRecord } from "../domain/vaults/token_secrets_key.ts";
import { VaultConfig } from "../domain/vaults/vault_config.ts";
import { VaultService } from "../domain/vaults/vault_service.ts";
import { swampPath } from "../infrastructure/persistence/paths.ts";
import { YamlVaultConfigRepository } from "../infrastructure/persistence/yaml_vault_config_repository.ts";
import { initializeControlPlaneVaultForCli } from "./control_plane_vault.ts";

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
  const fail = () => Promise.reject(new Error("S3 headBucket failed HTTP 403"));
  return { put: fail, get: fail, delete: fail, list: fail };
}

interface MockSyncServiceOptions {
  pullShouldFail?: boolean;
  controlPlaneStoreShouldFail?: boolean;
  controlPlaneStoreThrows?: boolean;
}

function createMockSyncService(
  opts: MockSyncServiceOptions = {},
): {
  syncService: DatastoreSyncService;
  calls: { method: string; options?: DatastoreSyncOptions }[];
} {
  const calls: { method: string; options?: DatastoreSyncOptions }[] = [];
  const store = opts.controlPlaneStoreShouldFail
    ? createFailingStore()
    : createMockStore();

  const syncService: DatastoreSyncService = {
    pullChanged(
      options?: DatastoreSyncOptions,
    ): Promise<number> {
      calls.push({ method: "pullChanged", options });
      if (opts.pullShouldFail) {
        return Promise.reject(new Error("S3 unreachable"));
      }
      return Promise.resolve(0);
    },
    pushChanged(
      options?: DatastoreSyncOptions,
    ): Promise<number> {
      calls.push({ method: "pushChanged", options });
      return Promise.resolve(0);
    },
    capabilities(): SyncCapabilities {
      return { controlPlane: true };
    },
    markDirty(): Promise<void> {
      calls.push({ method: "markDirty" });
      return Promise.resolve();
    },
    controlPlaneStore(): ControlPlaneStore {
      calls.push({ method: "controlPlaneStore" });
      if (opts.controlPlaneStoreThrows) {
        throw new Error("Namespace mismatch: bound to root");
      }
      return store;
    },
  };

  return { syncService, calls };
}

Deno.test("initializeControlPlaneVaultForCli: calls pullChanged with namespace before controlPlaneStore", async () => {
  const { syncService, calls } = createMockSyncService();

  const result = await initializeControlPlaneVaultForCli(
    "/tmp/test-repo",
    syncService,
    {
      namespace: "my-namespace",
      catalogInvalidate: () => {},
    },
  );

  assertNotEquals(result, null);

  const pullIndex = calls.findIndex((c) => c.method === "pullChanged");
  const storeIndex = calls.findIndex((c) => c.method === "controlPlaneStore");

  assertNotEquals(pullIndex, -1, "pullChanged must be called");
  assertNotEquals(storeIndex, -1, "controlPlaneStore must be called");
  assertEquals(
    pullIndex < storeIndex,
    true,
    "pullChanged must be called before controlPlaneStore",
  );
  assertEquals(calls[pullIndex].options?.namespace, "my-namespace");
});

Deno.test("initializeControlPlaneVaultForCli: calls catalogInvalidate after pullChanged", async () => {
  const { syncService } = createMockSyncService();

  let invalidated = false;
  await initializeControlPlaneVaultForCli(
    "/tmp/test-repo",
    syncService,
    {
      namespace: "my-namespace",
      catalogInvalidate: () => {
        invalidated = true;
      },
    },
  );

  assertEquals(invalidated, true);
});

Deno.test("initializeControlPlaneVaultForCli: skips pullChanged when no namespace", async () => {
  const { syncService, calls } = createMockSyncService();

  const result = await initializeControlPlaneVaultForCli(
    "/tmp/test-repo",
    syncService,
  );

  assertNotEquals(result, null);

  const pullCalls = calls.filter((c) => c.method === "pullChanged");
  assertEquals(
    pullCalls.length,
    0,
    "pullChanged must not be called without namespace",
  );

  const storeCalls = calls.filter((c) => c.method === "controlPlaneStore");
  assertEquals(storeCalls.length, 1, "controlPlaneStore must still be called");
});

Deno.test("initializeControlPlaneVaultForCli: surfaces a pullChanged failure as a control-plane init error", async () => {
  const { syncService, calls } = createMockSyncService({
    pullShouldFail: true,
  });

  const error = await assertRejects(
    () =>
      initializeControlPlaneVaultForCli(
        "/tmp/test-repo",
        syncService,
        { namespace: "my-namespace" },
      ),
    UserError,
  );
  assertStringIncludes(error.message, TOKEN_SECRETS_VAULT_NAME);
  assertStringIncludes(error.message, "remote datastore");
  assertStringIncludes(error.message, "S3 unreachable");
  assertEquals(
    calls.some((c) => c.method === "controlPlaneStore"),
    false,
    "controlPlaneStore must not be reached after pullChanged fails",
  );
});

Deno.test("initializeControlPlaneVaultForCli: surfaces a remote control-plane store failure", async () => {
  const { syncService } = createMockSyncService({
    controlPlaneStoreShouldFail: true,
  });

  const error = await assertRejects(
    () => initializeControlPlaneVaultForCli("/tmp/test-repo", syncService),
    UserError,
  );
  assertStringIncludes(error.message, TOKEN_SECRETS_VAULT_NAME);
  assertStringIncludes(error.message, "remote datastore");
  assertStringIncludes(error.message, "S3 headBucket failed HTTP 403");
});

Deno.test("initializeControlPlaneVaultForCli: surfaces a synchronous controlPlaneStore failure", async () => {
  const { syncService } = createMockSyncService({
    controlPlaneStoreThrows: true,
  });

  const error = await assertRejects(
    () => initializeControlPlaneVaultForCli("/tmp/test-repo", syncService),
    UserError,
  );
  assertStringIncludes(error.message, TOKEN_SECRETS_VAULT_NAME);
  assertStringIncludes(error.message, "remote datastore");
  assertStringIncludes(error.message, "Namespace mismatch: bound to root");
});

Deno.test("initializeControlPlaneVaultForCli: works without sync service", async () => {
  await withTempDir(async (repoDir) => {
    const result = await initializeControlPlaneVaultForCli(repoDir, undefined);

    assertEquals(result.isRemote, false);
  });
});

const KEY_VAULT = "prod-secrets";
const KEY_NAME = "swamp-token-key";

/** A local_encryption vault holding a token secrets key, and a serve.yaml naming it. */
async function setUpExternalKey(
  repoDir: string,
  serveYamlVault = KEY_VAULT,
): Promise<void> {
  await new YamlVaultConfigRepository(repoDir).save(
    VaultConfig.create(crypto.randomUUID(), KEY_VAULT, "local_encryption", {
      auto_generate: true,
    }),
  );
  const vaultService = await VaultService.fromRepository(repoDir);
  await vaultService.put(
    KEY_VAULT,
    KEY_NAME,
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
  );
  await writeServeYaml(repoDir, serveYamlVault);
}

async function writeServeYaml(repoDir: string, vault: string): Promise<void> {
  await Deno.mkdir(swampPath(repoDir), { recursive: true });
  await Deno.writeTextFile(
    join(swampPath(repoDir), "serve.yaml"),
    `token-secrets:\n  vault: ${vault}\n  key: ${KEY_NAME}\n`,
  );
}

async function readKeyRecord(repoDir: string): Promise<Uint8Array> {
  return await Deno.readFile(
    join(swampPath(repoDir), "_control", "token-secrets", "encryption-key"),
  );
}

Deno.test("initializeControlPlaneVaultForCli: uses the token secrets key named in the repo's serve.yaml", async () => {
  await withTempDir(async (repoDir) => {
    await setUpExternalKey(repoDir);

    const result = await initializeControlPlaneVaultForCli(repoDir, undefined);
    await result.provider.put("server-token-a", "secret-a");

    assertEquals(
      classifyTokenKeyRecord(await readKeyRecord(repoDir)).kind,
      "marker",
    );
    assertEquals(await result.provider.get("server-token-a"), "secret-a");
  });
});

Deno.test("initializeControlPlaneVaultForCli: fails closed without a serve.yaml block and never uses the marker's vault", async () => {
  await withTempDir(async (repoDir) => {
    await setUpExternalKey(repoDir);
    await initializeControlPlaneVaultForCli(repoDir, undefined);
    // The vault named in the marker still holds the right key; resolving it
    // from the marker would succeed, so this proves only serve.yaml counts.
    await Deno.remove(join(swampPath(repoDir), "serve.yaml"));

    const error = await assertRejects(
      () => initializeControlPlaneVaultForCli(repoDir, undefined),
      UserError,
    );
    assertStringIncludes(error.message, `vault '${KEY_VAULT}'`);
    assertStringIncludes(error.message, "token-secrets block");
  });
});

Deno.test("initializeControlPlaneVaultForCli: rejects _token-secrets as the key's vault", async () => {
  await withTempDir(async (repoDir) => {
    await writeServeYaml(repoDir, TOKEN_SECRETS_VAULT_NAME);

    const error = await assertRejects(
      () => initializeControlPlaneVaultForCli(repoDir, undefined),
      UserError,
    );
    assertStringIncludes(error.message, "token-secrets.vault");
  });
});

Deno.test("initializeControlPlaneVaultForCli: surfaces a corrupted local encryption key", async () => {
  await withTempDir(async (repoDir) => {
    const keyDir = join(swampPath(repoDir), "_control", "token-secrets");
    await Deno.mkdir(keyDir, { recursive: true });
    await Deno.writeFile(
      join(keyDir, "encryption-key"),
      new Uint8Array([1, 2, 3]),
    );

    const error = await assertRejects(
      () => initializeControlPlaneVaultForCli(repoDir, undefined),
      UserError,
    );
    assertStringIncludes(error.message, TOKEN_SECRETS_VAULT_NAME);
    assertStringIncludes(error.message, "local control plane");
    assertStringIncludes(error.message, "Invalid key length");
  });
});
