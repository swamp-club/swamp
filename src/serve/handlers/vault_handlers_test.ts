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

import { assertEquals, assertGreater } from "@std/assert";
import { stringify as stringifyYaml } from "@std/yaml";
import { join } from "@std/path";
import { handleVaultAnnotate, isReservedVaultName } from "./vault_handlers.ts";
import type { ConnectionContext } from "./shared.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
} from "../../domain/datastore/datastore_sync_service.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { EventBus } from "../../domain/events/event_bus.ts";
import "../../domain/vaults/vault_types.ts";

Deno.test("isReservedVaultName: returns true for _token-secrets", () => {
  assertEquals(isReservedVaultName("_token-secrets"), true);
});

Deno.test("isReservedVaultName: returns true for _any-underscore-prefix", () => {
  assertEquals(isReservedVaultName("_any-underscore-prefix"), true);
});

Deno.test("isReservedVaultName: returns false for normal vault names", () => {
  assertEquals(isReservedVaultName("default"), false);
  assertEquals(isReservedVaultName("my-vault"), false);
  assertEquals(isReservedVaultName("production"), false);
});

Deno.test("isReservedVaultName: returns false for empty string", () => {
  assertEquals(isReservedVaultName(""), false);
});

function createMockSocket(): WebSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
    sent,
    close() {},
  } as unknown as WebSocket & { sent: string[] };
}

function createMockSyncService(): {
  service: DatastoreSyncService;
  pushCalls: DatastoreSyncOptions[];
  markDirtyCalls: DatastoreSyncOptions[];
} {
  const pushCalls: DatastoreSyncOptions[] = [];
  const markDirtyCalls: DatastoreSyncOptions[] = [];
  const service: DatastoreSyncService = {
    pullChanged(_options?: DatastoreSyncOptions): Promise<number | void> {
      return Promise.resolve(0);
    },
    pushChanged(options?: DatastoreSyncOptions): Promise<number | void> {
      pushCalls.push(options ?? {});
      return Promise.resolve(0);
    },
    markDirty(options?: DatastoreSyncOptions): Promise<void> {
      markDirtyCalls.push(options ?? {});
      return Promise.resolve();
    },
  };
  return { service, pushCalls, markDirtyCalls };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir({
    prefix: "swamp-vault-handler-test-",
  });
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

const TEST_VAULT_ID = "test-vault-id-001";
const TEST_VAULT_NAME = "test-vault";

async function setupVault(repoDir: string): Promise<void> {
  const vaultConfigDir = join(repoDir, "vaults", "local_encryption");
  await Deno.mkdir(vaultConfigDir, { recursive: true });

  const configYaml = stringifyYaml({
    id: TEST_VAULT_ID,
    name: TEST_VAULT_NAME,
    type: "local_encryption",
    config: { auto_generate: true, base_dir: repoDir },
    createdAt: new Date().toISOString(),
  });
  await Deno.writeTextFile(
    join(vaultConfigDir, `${TEST_VAULT_ID}.yaml`),
    configYaml,
  );

  const svc = await VaultService.fromRepository(repoDir);
  await svc.put(TEST_VAULT_NAME, "test-key", "test-value");
}

function createAnnotateCtx(
  repoDir: string,
  syncService?: DatastoreSyncService,
): ConnectionContext {
  return {
    repoDir,
    repoContext: {
      eventBus: new EventBus(),
    } as unknown as ConnectionContext["repoContext"],
    datastoreConfig: {
      type: "custom",
      provider: "test",
      namespace: "shared",
      config: {},
      datastorePath: "/tmp/test-datastore",
    } as unknown as ConnectionContext["datastoreConfig"],
    datastoreResolver: {} as ConnectionContext["datastoreResolver"],
    syncService,
    authConfig: {
      mode: "none" as const,
      admins: [],
      allowedCollectives: [],
      allowedUsers: [],
      oauthProvider: "",
      groupsField: "collectives",
      restrictedModelTypes: [],
      restrictedCommands: [],
      approveRequiresExplicitGrant: false,
    },
  } as ConnectionContext;
}

Deno.test("handleVaultAnnotate: calls markDirty and pushChanged on syncService after successful annotation", async () => {
  await withTempDir(async (dir) => {
    await setupVault(dir);

    const { service, pushCalls, markDirtyCalls } = createMockSyncService();
    const ctx = createAnnotateCtx(dir, service);
    const socket = createMockSocket();

    await handleVaultAnnotate(
      socket,
      ctx,
      "req-annotate",
      { vaultName: TEST_VAULT_NAME, key: "test-key", notes: "a note" },
      new AbortController(),
      null,
    );

    const response = JSON.parse(socket.sent[0]);
    assertEquals(response.type, "vault.annotate");

    assertGreater(markDirtyCalls.length, 0);
    assertGreater(pushCalls.length, 0);
    assertEquals(pushCalls[0].namespace, "shared");
  });
});

Deno.test("handleVaultAnnotate: works without syncService (local-only mode)", async () => {
  await withTempDir(async (dir) => {
    await setupVault(dir);

    const ctx = createAnnotateCtx(dir);
    const socket = createMockSocket();

    await handleVaultAnnotate(
      socket,
      ctx,
      "req-annotate-local",
      { vaultName: TEST_VAULT_NAME, key: "test-key", notes: "local note" },
      new AbortController(),
      null,
    );

    const response = JSON.parse(socket.sent[0]);
    assertEquals(response.type, "vault.annotate");
    assertEquals(response.payload.data.vaultName, TEST_VAULT_NAME);
  });
});

Deno.test("handleVaultAnnotate: persists labels with their values", async () => {
  await withTempDir(async (dir) => {
    await setupVault(dir);

    const ctx = createAnnotateCtx(dir);
    const socket = createMockSocket();

    await handleVaultAnnotate(
      socket,
      ctx,
      "req-annotate-labels",
      {
        vaultName: TEST_VAULT_NAME,
        key: "test-key",
        labels: { team: "infra", env: "prod" },
      },
      new AbortController(),
      null,
    );

    const response = JSON.parse(socket.sent[0]);
    assertEquals(response.type, "vault.annotate");

    const svc = await VaultService.fromRepository(dir);
    const annotation = await svc.getAnnotation(TEST_VAULT_NAME, "test-key");
    assertEquals(annotation?.labels, { team: "infra", env: "prod" });
  });
});

Deno.test("handleVaultAnnotate: removeLabels removes only the named labels", async () => {
  await withTempDir(async (dir) => {
    await setupVault(dir);

    const ctx = createAnnotateCtx(dir);

    await handleVaultAnnotate(
      createMockSocket(),
      ctx,
      "req-annotate-add",
      {
        vaultName: TEST_VAULT_NAME,
        key: "test-key",
        labels: { team: "infra", env: "prod" },
      },
      new AbortController(),
      null,
    );

    const socket = createMockSocket();
    await handleVaultAnnotate(
      socket,
      ctx,
      "req-annotate-remove",
      { vaultName: TEST_VAULT_NAME, key: "test-key", removeLabels: ["team"] },
      new AbortController(),
      null,
    );

    const response = JSON.parse(socket.sent[0]);
    assertEquals(response.type, "vault.annotate");

    const svc = await VaultService.fromRepository(dir);
    const annotation = await svc.getAnnotation(TEST_VAULT_NAME, "test-key");
    assertEquals(annotation?.labels, { env: "prod" });
  });
});
