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

import { assert, assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import "../../domain/vaults/vault_types.ts";
import { buildMarkDirtyHook } from "../../cli/repo_context.ts";
import type { CustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import type { DatastoreSyncService } from "../../domain/datastore/datastore_sync_service.ts";
import { MockVaultProvider } from "../../domain/vaults/mock_vault_provider.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { DefaultDatastorePathResolver } from "../../infrastructure/persistence/default_datastore_path_resolver.ts";
import { registerManagedConfig } from "../../infrastructure/persistence/paths.ts";
import { createRepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import type { ConnectionContext } from "./shared.ts";
import {
  DEFAULT_STALE_TTL_MS,
  type HeartbeatRecord,
  InstanceHeartbeatService,
} from "../instance_heartbeat.ts";
import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import type { MergedServeOptions } from "../serve_config.ts";
import {
  collectClusterInstances,
  handleExtensionList,
  handleExtensionRm,
  handleVaultMigrate,
  redactServeOptions,
} from "./admin_handlers.ts";

await initializeLogging({});

function makeHeartbeat(
  id: string,
  heartbeatAt: string,
  address?: string,
): HeartbeatRecord {
  return {
    instanceId: id,
    hostname: "test-host",
    pid: 1000,
    startedAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt,
    ...(address !== undefined ? { address } : {}),
  };
}

function makeStore(
  records: HeartbeatRecord[],
): ControlPlaneStore {
  const store = new Map<string, Uint8Array>();
  for (const r of records) {
    store.set(
      `heartbeats/${r.instanceId}`,
      new TextEncoder().encode(JSON.stringify(r)),
    );
  }
  return {
    put(key: string, data: Uint8Array) {
      store.set(key, data);
      return Promise.resolve();
    },
    get(key: string) {
      return Promise.resolve(store.get(key) ?? null);
    },
    delete(key: string) {
      store.delete(key);
      return Promise.resolve();
    },
    list(prefix: string) {
      return Promise.resolve(
        [...store.keys()].filter((k) => k.startsWith(prefix)),
      );
    },
  };
}

// ── parseRecord tests ────────────────────────────────────────────────

Deno.test("parseRecord: parses valid record with address", () => {
  const record = makeHeartbeat(
    "inst-1",
    "2026-01-01T00:01:00.000Z",
    "http://host-a:9090",
  );
  const data = new TextEncoder().encode(JSON.stringify(record));
  const parsed = InstanceHeartbeatService.parseRecord(data);
  assertEquals(parsed?.instanceId, "inst-1");
  assertEquals(parsed?.address, "http://host-a:9090");
});

Deno.test("parseRecord: rejects record with non-string address", () => {
  const raw = {
    instanceId: "inst-1",
    hostname: "host-a",
    pid: 1234,
    startedAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt: "2026-01-01T00:01:00.000Z",
    address: 12345,
  };
  const data = new TextEncoder().encode(JSON.stringify(raw));
  assertEquals(InstanceHeartbeatService.parseRecord(data), null);
});

// ── collectClusterInstances tests ────────────────────────────────────

Deno.test("collectClusterInstances: healthy status for fresh heartbeat", async () => {
  const now = new Date().toISOString();
  const store = makeStore([makeHeartbeat("inst-1", now, "http://host:9090")]);
  const ac = new AbortController();

  const instances = await collectClusterInstances({
    controlPlaneStore: store,
    instanceId: "other-id",
    signal: ac.signal,
  });

  assertEquals(instances.length, 1);
  assertEquals(instances[0].status, "healthy");
  assertEquals(instances[0].address, "http://host:9090");
});

Deno.test("collectClusterInstances: degraded status near stale threshold", async () => {
  const staleTtlMs = 90_000;
  const degradedAge = staleTtlMs * 2 / 3 + 1000;
  const degradedTime = new Date(Date.now() - degradedAge).toISOString();
  const store = makeStore([makeHeartbeat("inst-1", degradedTime)]);
  const ac = new AbortController();

  const instances = await collectClusterInstances({
    controlPlaneStore: store,
    instanceId: "other-id",
    staleTtlMs,
    signal: ac.signal,
  });

  assertEquals(instances.length, 1);
  assertEquals(instances[0].status, "degraded");
});

Deno.test("collectClusterInstances: unreachable status past stale threshold", async () => {
  const staleTtlMs = 90_000;
  const staleTime = new Date(Date.now() - staleTtlMs - 5000).toISOString();
  const store = makeStore([makeHeartbeat("inst-1", staleTime)]);
  const ac = new AbortController();

  const instances = await collectClusterInstances({
    controlPlaneStore: store,
    instanceId: "other-id",
    staleTtlMs,
    signal: ac.signal,
  });

  assertEquals(instances.length, 1);
  assertEquals(instances[0].status, "unreachable");
});

Deno.test("collectClusterInstances: unreachable for invalid timestamp", async () => {
  const store = makeStore([makeHeartbeat("inst-1", "not-a-date")]);
  const ac = new AbortController();

  const instances = await collectClusterInstances({
    controlPlaneStore: store,
    instanceId: "other-id",
    signal: ac.signal,
  });

  assertEquals(instances.length, 1);
  assertEquals(instances[0].status, "unreachable");
});

Deno.test("collectClusterInstances: standalone fallback when no heartbeats", async () => {
  const store = makeStore([]);
  const ac = new AbortController();

  const instances = await collectClusterInstances({
    controlPlaneStore: store,
    instanceId: "local-id",
    serveOptions: {
      port: 9090,
      host: "127.0.0.1",
    } as MergedServeOptions,
    signal: ac.signal,
  });

  assertEquals(instances.length, 1);
  assertEquals(instances[0].instanceId, "local-id");
  assertEquals(instances[0].status, "healthy");
  assertEquals(instances[0].address, "http://127.0.0.1:9090");
});

Deno.test("collectClusterInstances: standalone fallback derives https from TLS options", async () => {
  const store = makeStore([]);
  const ac = new AbortController();

  const instances = await collectClusterInstances({
    controlPlaneStore: store,
    instanceId: "local-id",
    serveOptions: {
      port: 443,
      host: "0.0.0.0",
      certFile: "/path/to/cert.pem",
      keyFile: "/path/to/key.pem",
    } as MergedServeOptions,
    signal: ac.signal,
  });

  assertEquals(instances.length, 1);
  assertEquals(instances[0].address, "https://0.0.0.0:443");
});

Deno.test("collectClusterInstances: multiple instances with mixed status", async () => {
  const now = new Date();
  const healthy = makeHeartbeat("inst-1", now.toISOString(), "http://a:9090");
  const stale = makeHeartbeat(
    "inst-2",
    new Date(now.getTime() - DEFAULT_STALE_TTL_MS - 5000).toISOString(),
    "http://b:9090",
  );
  const store = makeStore([healthy, stale]);
  const ac = new AbortController();

  const instances = await collectClusterInstances({
    controlPlaneStore: store,
    instanceId: "inst-1",
    signal: ac.signal,
  });

  assertEquals(instances.length, 2);
  const inst1 = instances.find((i) => i.instanceId === "inst-1");
  const inst2 = instances.find((i) => i.instanceId === "inst-2");
  assertEquals(inst1?.status, "healthy");
  assertEquals(inst2?.status, "unreachable");
});

// ── redactServeOptions tests ─────────────────────────────────────────

Deno.test("redactServeOptions: verifies webhook secrets are not exposed", () => {
  const opts = {
    port: 9090,
    host: "127.0.0.1",
    schedule: true,
    authMode: "none",
    grantReload: "manual",
    trustProxy: false,
    verifyOnEnroll: false,
    detachRuns: false,
    hotReload: false,
    enableInternalApi: false,
    remoteOnly: false,
    webhookConfigs: [{
      route: "/hook",
      workflow: "deploy",
      secret: "super-secret-value",
      scheme: "github",
    }],
  };
  const redacted = redactServeOptions(
    opts as unknown as MergedServeOptions,
  );
  const webhooks = redacted.webhooks as Array<Record<string, unknown>>;
  assertEquals(webhooks.length, 1);
  assertEquals(webhooks[0].route, "/hook");
  assertEquals(webhooks[0].workflow, "deploy");
  assertEquals(webhooks[0].scheme, "github");
  assertEquals(Object.hasOwn(webhooks[0], "secret"), false);
});

Deno.test("redactServeOptions: omits TLS key file", () => {
  const opts = {
    port: 443,
    host: "0.0.0.0",
    schedule: false,
    certFile: "/path/to/cert.pem",
    keyFile: "/path/to/key.pem",
    authMode: "admin-token",
    grantReload: "manual",
    trustProxy: true,
    verifyOnEnroll: false,
    detachRuns: false,
    hotReload: false,
    enableInternalApi: false,
    remoteOnly: false,
  };
  const redacted = redactServeOptions(
    opts as unknown as MergedServeOptions,
  );
  const tls = redacted.tls as Record<string, unknown>;
  assertEquals(tls.enabled, true);
  assertEquals(tls.certFile, "/path/to/cert.pem");
  assertEquals(Object.hasOwn(tls, "keyFile"), false);
});

Deno.test("redactServeOptions: handles no webhooks", () => {
  const opts = {
    port: 9090,
    host: "127.0.0.1",
    schedule: true,
    authMode: "none",
    grantReload: "manual",
    trustProxy: false,
    verifyOnEnroll: false,
    detachRuns: false,
    hotReload: false,
    enableInternalApi: false,
    remoteOnly: false,
  };
  const redacted = redactServeOptions(
    opts as unknown as MergedServeOptions,
  );
  const webhooks = redacted.webhooks as Array<Record<string, unknown>>;
  assertEquals(webhooks.length, 0);
  assertEquals(redacted.port, 9090);
  assertEquals(redacted.authMode, "none");
});

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
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

function createMockSocket(): WebSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
    sent,
  } as unknown as WebSocket & { sent: string[] };
}

type SyncEvent = { kind: "mark"; relPath?: string } | { kind: "push" };

function createRecordingSyncService(): {
  service: DatastoreSyncService;
  events: SyncEvent[];
} {
  const events: SyncEvent[] = [];
  const service: DatastoreSyncService = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => {
      events.push({ kind: "push" });
      return Promise.resolve(0);
    },
    markDirty: (options) => {
      events.push({ kind: "mark", relPath: options?.relPath });
      return Promise.resolve();
    },
  };
  return { service, events };
}

/**
 * A repo whose datastore cache lives outside it, as with S3 or GCS, and a
 * serve connection context whose sync service records every mark and push.
 */
async function createSyncRepo(dir: string, managedConfig: boolean) {
  const repoDir = join(dir, "repo");
  const cacheRoot = join(dir, "cache");
  await ensureDir(join(repoDir, ".swamp"));
  await ensureDir(cacheRoot);
  await Deno.writeTextFile(
    join(repoDir, ".swamp.yaml"),
    stringifyYaml({
      swampVersion: "0.0.0",
      initializedAt: new Date().toISOString(),
      datastore: { type: "@test/remote", managedConfig },
    }),
  );
  const datastoreConfig: CustomDatastoreConfig = {
    type: "@test/remote",
    config: {},
    datastorePath: join(dir, "remote"),
    cachePath: cacheRoot,
  };
  const datastoreResolver = new DefaultDatastorePathResolver(
    repoDir,
    datastoreConfig,
  );
  if (managedConfig) {
    // Keyed by this run's temp dir, so it cannot leak into another test.
    registerManagedConfig(
      repoDir,
      true,
      datastoreResolver.resolvePath("config"),
    );
  }
  const { service, events } = createRecordingSyncService();
  const repoContext = createRepositoryContext({
    repoDir,
    enableIndexing: false,
    datastoreResolver,
    markDirty: buildMarkDirtyHook(service, cacheRoot, repoDir),
  });
  const ctx = {
    repoDir,
    repoContext,
    datastoreConfig,
    datastoreResolver,
    syncService: service,
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
  const cleanup = () => repoContext.catalogStore.close();
  return { repoDir, datastoreResolver, ctx, events, cleanup };
}

Deno.test("handleExtensionRm: marks only the config-tier lockfile before the push under managedConfig (swamp-club#2415)", async () => {
  await withTempDir(async (dir) => {
    const { datastoreResolver, ctx, events, cleanup } = await createSyncRepo(
      dir,
      true,
    );
    try {
      const configDir = datastoreResolver.resolvePath("config");
      await ensureDir(configDir);
      await Deno.writeTextFile(
        join(configDir, "upstream_extensions.json"),
        JSON.stringify({
          "@test/ext": {
            version: "1.0.0",
            pulledAt: "2026-01-01T00:00:00Z",
            files: [],
          },
        }),
      );
      const socket = createMockSocket();

      await handleExtensionRm(
        socket,
        ctx,
        "req-rm",
        { extensionName: "@test/ext" },
        new AbortController(),
        null,
      );

      assertEquals(JSON.parse(socket.sent[0]).type, "extension.rm");
      // Extension sources still live outside the datastore tier
      // (swamp-club#2429), so the lockfile is the only file to mark. A bare
      // markDirty() would turn the push into a walk of the whole cache.
      assertEquals(events, [
        { kind: "mark", relPath: "config/upstream_extensions.json" },
        { kind: "push" },
      ]);
    } finally {
      cleanup();
    }
  });
});

Deno.test("handleExtensionRm: neither marks nor pushes without managedConfig (swamp-club#2415)", async () => {
  await withTempDir(async (dir) => {
    const { repoDir, ctx, events, cleanup } = await createSyncRepo(dir, false);
    try {
      const lockfileDir = join(repoDir, "extensions", "models");
      await ensureDir(lockfileDir);
      await Deno.writeTextFile(
        join(lockfileDir, "upstream_extensions.json"),
        JSON.stringify({
          "@test/ext": {
            version: "1.0.0",
            pulledAt: "2026-01-01T00:00:00Z",
            files: [],
          },
        }),
      );
      const socket = createMockSocket();

      await handleExtensionRm(
        socket,
        ctx,
        "req-rm",
        { extensionName: "@test/ext" },
        new AbortController(),
        null,
      );

      assertEquals(JSON.parse(socket.sent[0]).type, "extension.rm");
      assertEquals(events, []);
    } finally {
      cleanup();
    }
  });
});

Deno.test("handleVaultMigrate: marks the new and the old config path before the push (swamp-club#2415)", async () => {
  const targetType = `@test/migrate-target-${crypto.randomUUID()}`;
  vaultTypeRegistry.register({
    type: targetType,
    name: "Migrate target",
    description: "In-memory vault for the migrate dirty-path test",
    isBuiltIn: false,
    createProvider: (name) => new MockVaultProvider(name),
  });
  try {
    await withTempDir(async (dir) => {
      const { repoDir, datastoreResolver, ctx, events, cleanup } =
        await createSyncRepo(dir, true);
      try {
        const vaultsDir = join(
          datastoreResolver.resolvePath("config"),
          "vaults",
        );
        await ensureDir(join(vaultsDir, "local_encryption"));
        await Deno.writeTextFile(
          join(vaultsDir, "local_encryption", "migrate-vault-id.yaml"),
          stringifyYaml({
            id: "migrate-vault-id",
            name: "migrate-vault",
            type: "local_encryption",
            config: { auto_generate: true, base_dir: repoDir },
            createdAt: new Date().toISOString(),
          }),
        );
        const vaults = await VaultService.fromRepository(repoDir);
        await vaults.put("migrate-vault", "probe-key", "probe-value");
        events.length = 0;
        const socket = createMockSocket();

        await handleVaultMigrate(
          socket,
          ctx,
          "req-migrate",
          { vaultName: "migrate-vault", targetType },
          new AbortController(),
          null,
        );

        assertEquals(JSON.parse(socket.sent[0]).type, "vault.migrate");
        assertEquals(events.at(-1), { kind: "push" });
        const marks = events.flatMap((e) =>
          e.kind === "mark" ? [e.relPath] : []
        );
        // The old path is marked so the scoped push sees it absent and
        // deletes it remotely; a bare markDirty() would skip that.
        assertEquals(
          marks.sort(),
          [
            `config/vaults/${targetType}/migrate-vault-id.yaml`,
            "config/vaults/local_encryption/migrate-vault-id.yaml",
          ].sort(),
        );
        assert(
          !(await Deno.stat(
            join(vaultsDir, "local_encryption", "migrate-vault-id.yaml"),
          ).then(() => true, () => false)),
          "the old config should be gone locally",
        );
      } finally {
        cleanup();
      }
    });
  } finally {
    vaultTypeRegistry.invalidateType(targetType);
  }
});

Deno.test("handleExtensionList: reads the managed lockfile, not the models dir (swamp-club#2483)", async () => {
  await withTempDir(async (dir) => {
    const { repoDir, datastoreResolver, ctx, cleanup } = await createSyncRepo(
      dir,
      true,
    );
    try {
      const entry = {
        version: "1.0.0",
        pulledAt: "2026-01-01T00:00:00Z",
        files: [],
      };
      const configDir = datastoreResolver.resolvePath("config");
      await ensureDir(configDir);
      await Deno.writeTextFile(
        join(configDir, "upstream_extensions.json"),
        JSON.stringify({ "@test/team": entry }),
      );
      // A pre-migrate models-dir lockfile must be ignored.
      await ensureDir(join(repoDir, "extensions", "models"));
      await Deno.writeTextFile(
        join(repoDir, "extensions", "models", "upstream_extensions.json"),
        JSON.stringify({ "@test/stale": entry }),
      );
      const socket = createMockSocket();

      await handleExtensionList(
        socket,
        ctx,
        "req-list",
        new AbortController(),
        null,
      );

      const message = JSON.parse(socket.sent[0]);
      assertEquals(message.type, "extension.list");
      const names = message.payload.data.extensions.map((
        e: { name: string },
      ) => e.name);
      assertEquals(names, ["@test/team"]);
    } finally {
      cleanup();
    }
  });
});
