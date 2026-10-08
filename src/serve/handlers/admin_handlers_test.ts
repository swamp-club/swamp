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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { hostname } from "node:os";
import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import "../../domain/vaults/vault_types.ts";
import { buildMarkDirtyHook } from "../../cli/repo_context.ts";
import type { CustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import type { DatastoreSyncService } from "../../domain/datastore/datastore_sync_service.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { MockVaultProvider } from "../../domain/vaults/mock_vault_provider.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { DefaultDatastorePathResolver } from "../../infrastructure/persistence/default_datastore_path_resolver.ts";
import { registerManagedConfig } from "../../infrastructure/persistence/paths.ts";
import { createRepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import { assertPathArrayEquals } from "../../infrastructure/persistence/path_test_helpers.ts";
import {
  signalChange,
  type UnscopedChange,
  useUnscopedChangeReporterForTesting,
} from "../../infrastructure/persistence/unit_of_work_scope.ts";
import type { ConnectionContext } from "./shared.ts";
import {
  DEFAULT_STALE_TTL_MS,
  type HeartbeatRecord,
  InstanceHeartbeatService,
} from "../instance_heartbeat.ts";
import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import type { MergedServeOptions } from "../serve_config.ts";
import { ActiveRun } from "../../domain/models/active_run.ts";
import { WorkflowRun } from "../../domain/workflows/workflow_run.ts";
import type {
  WorkflowId,
  WorkflowRunId,
} from "../../domain/workflows/workflow_id.ts";
import { RunTrackerStore } from "../../infrastructure/persistence/run_tracker_store.ts";
import {
  collectClusterInstances,
  handleDoctorWorkflows,
  handleExtensionList,
  handleExtensionRm,
  handleRunDoctor,
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

Deno.test("redactServeOptions: reports the scheduled-run limit under scheduling", () => {
  const base = {
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
  assertEquals(
    redactServeOptions(base as unknown as MergedServeOptions).scheduling,
    { enabled: true, maxConcurrentRuns: null },
  );
  assertEquals(
    redactServeOptions(
      {
        ...base,
        maxConcurrentScheduledRuns: 3,
      } as unknown as MergedServeOptions,
    ).scheduling,
    { enabled: true, maxConcurrentRuns: 3 },
  );
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

type SyncEvent =
  | { kind: "mark"; relPath?: string }
  | { kind: "push" }
  | { kind: "pull"; subdirs?: readonly string[] }
  | { kind: "lock" }
  | { kind: "unlock" };

function createRecordingSyncService(): {
  service: DatastoreSyncService;
  events: SyncEvent[];
} {
  const events: SyncEvent[] = [];
  const service: DatastoreSyncService = {
    pullChanged: (options) => {
      events.push({ kind: "pull", subdirs: options?.subdirs });
      return Promise.resolve(0);
    },
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
      signalRequiresExplicitGrant: false,
    },
  } as ConnectionContext;
  const cleanup = () => repoContext.catalogStore.close();
  return { repoDir, datastoreResolver, ctx, events, cleanup };
}

/**
 * Registers `@test/remote`, the datastore type {@link createSyncRepo} uses,
 * with a global lock that records into `events`.
 */
function registerRecordingLockProvider(events: SyncEvent[]): void {
  datastoreTypeRegistry.register({
    type: "@test/remote",
    name: "Test remote",
    description: "Records global lock use for the extension handler tests",
    isBuiltIn: false,
    createProvider: () => ({
      createLock: () => ({
        acquire: () => Promise.resolve(void events.push({ kind: "lock" })),
        release: () => Promise.resolve(void events.push({ kind: "unlock" })),
        withLock: <T>(fn: () => Promise<T>) => fn(),
        inspect: () => Promise.resolve(null),
        forceRelease: () => Promise.resolve(true),
      }),
      createVerifier: () => ({
        verify: () =>
          Promise.resolve({
            healthy: true,
            message: "ok",
            latencyMs: 1,
            datastoreType: "@test/remote",
          }),
      }),
      resolveDatastorePath: (repoDir: string) => join(repoDir, ".remote"),
    }),
  });
}

Deno.test("handleExtensionRm: fetches the lockfile under the global lock, then marks only it before the push under managedConfig (swamp-club#2415, swamp-club#2838)", async () => {
  await withTempDir(async (dir) => {
    const { datastoreResolver, ctx, events, cleanup } = await createSyncRepo(
      dir,
      true,
    );
    try {
      registerRecordingLockProvider(events);
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
      // The shared lockfile is fetched under the datastore global lock
      // before the removal, so a stale cache cannot revert other
      // instances' entries (swamp-club#2838). Extension sources still live
      // outside the datastore tier (swamp-club#2612), so the lockfile is the
      // only file to mark. A bare markDirty() would turn the push into a
      // walk of the whole cache.
      assertEquals(events, [
        { kind: "lock" },
        { kind: "pull", subdirs: ["config"] },
        { kind: "mark", relPath: "config/upstream_extensions.json" },
        { kind: "push" },
        { kind: "unlock" },
      ]);
    } finally {
      datastoreTypeRegistry.invalidateType("@test/remote");
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

Deno.test("handleVaultMigrate: refuses a local_encryption target naming its own key source (swamp-club#2690)", async () => {
  const sourceType = `@test/migrate-source-${crypto.randomUUID()}`;
  vaultTypeRegistry.register({
    type: sourceType,
    name: "Migrate source",
    description: "In-memory vault for the migrate key-source test",
    isBuiltIn: false,
    createProvider: (name) => new MockVaultProvider(name),
  });
  try {
    await withTempDir(async (dir) => {
      const { datastoreResolver, ctx, cleanup } = await createSyncRepo(
        dir,
        true,
      );
      try {
        const vaultsDir = join(
          datastoreResolver.resolvePath("config"),
          "vaults",
        );
        const sourcePath = join(vaultsDir, sourceType, "source-vault-id.yaml");
        await ensureDir(dirname(sourcePath));
        await Deno.writeTextFile(
          sourcePath,
          stringifyYaml({
            id: "source-vault-id",
            name: "source-vault",
            type: sourceType,
            config: {},
            createdAt: new Date().toISOString(),
          }),
        );
        const outsideKey = join(dir, "outside", "key");
        const socket = createMockSocket();

        await handleVaultMigrate(
          socket,
          ctx,
          "req-migrate",
          {
            vaultName: "source-vault",
            targetType: "local_encryption",
            targetConfig: { auto_generate: true, key_file: outsideKey },
          },
          new AbortController(),
          null,
        );

        const frame = JSON.parse(socket.sent[0]);
        assertEquals(frame.type, "error");
        assertStringIncludes(frame.error.message, "Cannot set key_file");
        await Deno.stat(sourcePath);
        assert(
          !(await Deno.stat(outsideKey).then(() => true, () => false)),
          "no key file should be written outside the repo",
        );
      } finally {
        cleanup();
      }
    });
  } finally {
    vaultTypeRegistry.invalidateType(sourceType);
  }
});

Deno.test("handleExtensionList: reads the managed lockfile and the transitional local one, not the models dir (swamp-club#2483)", async () => {
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
      await ensureDir(join(repoDir, ".swamp", "config"));
      await Deno.writeTextFile(
        join(repoDir, ".swamp", "config", "upstream_extensions.json"),
        JSON.stringify({ "@test/auto": entry }),
      );
      // Installed on disk; one gone entirely would await reinstall instead.
      await ensureDir(
        join(repoDir, ".swamp", "config", "pulled-extensions", "@test", "auto"),
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
      assertEquals(names, ["@test/auto", "@test/team"]);
    } finally {
      cleanup();
    }
  });
});

const BROKEN_WORKFLOW_YAML = `id: "550e8400-e29b-41d4-a716-446655440003"
name: broken-remote
jobs:
  - name: job
    steps:
      - name: step
        task:
          type: not_a_real_task
`;

Deno.test("handleDoctorWorkflows: checks the dirs the server loads workflows from (swamp-club#2942)", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const configBase = join(dir, "config-base");
    const extensionDir = join(repoDir, "extensions", "workflows");
    const pulledDir = join(dir, "pulled");
    // Keyed by this run's temp dir, so it cannot leak into another test.
    registerManagedConfig(repoDir, true, configBase);
    await ensureDir(join(configBase, "workflows"));
    await ensureDir(join(extensionDir, "nested"));
    await ensureDir(pulledDir);
    await Deno.writeTextFile(
      join(configBase, "workflows", "workflow-broken.yaml"),
      BROKEN_WORKFLOW_YAML,
    );
    await Deno.writeTextFile(
      join(extensionDir, "nested", "broken.yml"),
      BROKEN_WORKFLOW_YAML,
    );
    // Stale repo-local dirs the server never reads: must not be checked.
    await ensureDir(join(repoDir, "workflows"));
    await Deno.writeTextFile(
      join(repoDir, "workflows", "workflow-stale.yaml"),
      BROKEN_WORKFLOW_YAML,
    );

    const repoContext = createRepositoryContext({
      repoDir,
      enableIndexing: false,
      workflowsDir: extensionDir,
    });
    try {
      // A reload points the extension repo at newly pulled dirs.
      await Deno.writeTextFile(
        join(pulledDir, "broken.yaml"),
        BROKEN_WORKFLOW_YAML,
      );
      repoContext.extensionWorkflowRepo?.updateAdditionalDirs([pulledDir]);
      const ctx = {
        repoDir,
        repoContext,
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
          signalRequiresExplicitGrant: false,
        },
      } as unknown as ConnectionContext;
      const socket = createMockSocket();

      await handleDoctorWorkflows(
        socket,
        ctx,
        "req-doctor",
        new AbortController(),
        null,
      );

      const message = JSON.parse(socket.sent[0]);
      assertEquals(message.type, "doctor.workflows");
      const report = message.payload.data as {
        overallStatus: string;
        workflows: { file: string }[];
      };
      assertEquals(report.overallStatus, "fail");
      assertPathArrayEquals(report.workflows.map((w) => w.file), [
        join(configBase, "workflows", "workflow-broken.yaml"),
        join(extensionDir, "nested", "broken.yml"),
        join(pulledDir, "broken.yaml"),
      ]);
    } finally {
      repoContext.catalogStore.close();
    }
  });
});

Deno.test("handleRunDoctor: the fix's run saves stage into a root unit over the repository context's hook (swamp-club#3056)", async () => {
  const marks: (string | undefined)[] = [];
  const markDirty = (path?: string) => {
    marks.push(path);
    return Promise.resolve();
  };
  const settled: string[] = [];
  const ctx = {
    instanceId: "self",
    // Heartbeats are recorded, and the peer has none.
    controlPlaneStore: {
      get: (key: string) =>
        Promise.resolve(key === "heartbeats/self" ? new Uint8Array([1]) : null),
    },
    runTracker: {
      findAll: () => [],
      findStaleRuns: () => [],
      findById: () => null,
      markSettled: (id: string) => settled.push(id),
    },
    repoContext: {
      markDirty,
      workflowRunRepo: {
        findGlobalByStatus: () =>
          Promise.resolve([{
            run: {
              id: "run-1",
              instanceId: "dead-peer",
              interruptOrphaned: () => {},
            },
            workflowId: "wf-1",
          }]),
        // As the run repository signals before it writes.
        save: () => signalChange(markDirty, { kind: "write", path: "run-1" }),
      },
    },
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
      signalRequiresExplicitGrant: false,
    },
  } as unknown as ConnectionContext;
  const reports: UnscopedChange[] = [];
  const dispose = useUnscopedChangeReporterForTesting((report) => {
    reports.push(report);
  });
  try {
    await handleRunDoctor(createMockSocket(), ctx, "req-doctor", {
      fix: true,
    }, null);
  } finally {
    dispose();
  }
  assertEquals(reports, []);
  assertEquals(marks, ["run-1"]);
  assertEquals(settled, ["run-1"]);
});

Deno.test("handleRunDoctor: fix settles an interrupted row whose renamed workflow's run finished (swamp-club#2917)", async () => {
  await withTempDir(async (dir) => {
    const tracker = new RunTrackerStore(join(dir, "run_tracker.db"));
    try {
      const workflowId = crypto.randomUUID() as WorkflowId;
      const run = WorkflowRun.fromData({
        id: crypto.randomUUID(),
        workflowId,
        workflowName: "old-name",
        status: "succeeded",
        startedAt: new Date().toISOString(),
        jobs: [],
        tags: {},
      });
      const now = new Date().toISOString();
      tracker.register(ActiveRun.fromData({
        id: run.id,
        runKind: "workflow",
        modelType: null,
        methodName: null,
        workflowName: "old-name",
        pid: 2147483647,
        hostname: "some-host",
        startedAt: now,
        heartbeatAt: now,
        status: "running",
      }));
      // Reaped while its owner went on to finish the run.
      tracker.complete(run.id, "interrupted");
      const ctx = {
        repoDir: dir,
        runTracker: tracker,
        repoContext: {
          workflowRunRepo: {
            findById: (wfId: WorkflowId, runId: WorkflowRunId) =>
              Promise.resolve(
                wfId === workflowId && runId === run.id ? run : null,
              ),
            listWorkflowIds: () => Promise.resolve([workflowId]),
          },
          workflowRepo: { findByName: () => Promise.resolve(null) },
        },
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
          signalRequiresExplicitGrant: false,
        },
      } as unknown as ConnectionContext;

      await handleRunDoctor(createMockSocket(), ctx, "req-1", {}, null);
      assertEquals(tracker.findById(run.id)?.settled, false);

      await handleRunDoctor(
        createMockSocket(),
        ctx,
        "req-2",
        { fix: true },
        null,
      );
      assertEquals(tracker.findById(run.id)?.cancelReason, "record_settled");
    } finally {
      tracker.close();
    }
  });
});

/** A pid no process has: the largest a 32-bit pid_t holds. */
const DEAD_PID = 2147483647;

/** A run record left `running` under `pid` by serve instance `instanceId`. */
function runningRecord(pid: number, instanceId: string): WorkflowRun {
  return WorkflowRun.fromData({
    id: crypto.randomUUID(),
    workflowId: crypto.randomUUID(),
    workflowName: "deploy",
    status: "running",
    startedAt: new Date().toISOString(),
    pid,
    instanceId,
    jobs: [],
    tags: {},
  });
}

/** Registers the tracker row the owner of `run` wrote on this host. */
function registerLocalRow(tracker: RunTrackerStore, run: WorkflowRun): void {
  const now = new Date().toISOString();
  tracker.register(ActiveRun.fromData({
    id: run.id,
    runKind: "workflow",
    modelType: null,
    methodName: null,
    workflowName: run.workflowName,
    pid: run.pid!,
    hostname: hostname(),
    instanceId: run.instanceId,
    startedAt: now,
    heartbeatAt: now,
    status: "running",
  }));
}

interface DoctorReply {
  orphanedWorkflowRuns: number;
  orphanedReaped: number;
}

/**
 * Runs `handleRunDoctor` as serve instance `self` over `runs`, with a control
 * plane holding a heartbeat for each of `heartbeats`. Returns the reply, the
 * ids of the runs saved and the control-plane keys read.
 */
async function doctorScan(
  tracker: RunTrackerStore,
  runs: WorkflowRun[],
  heartbeats: string[],
  fix: boolean,
): Promise<{ reply: DoctorReply; saved: string[]; reads: string[] }> {
  const saved: string[] = [];
  const reads: string[] = [];
  const ctx = {
    instanceId: "self",
    controlPlaneStore: {
      get: (key: string) => {
        reads.push(key);
        return Promise.resolve(
          heartbeats.some((id) => key === `heartbeats/${id}`)
            ? new Uint8Array([1])
            : null,
        );
      },
    },
    runTracker: tracker,
    repoContext: {
      markDirty: () => Promise.resolve(),
      workflowRunRepo: {
        findGlobalByStatus: () =>
          Promise.resolve(
            runs.map((run) => ({ run, workflowId: run.workflowId })),
          ),
        save: (_workflowId: WorkflowId, run: WorkflowRun) => {
          saved.push(run.id);
          return Promise.resolve();
        },
        findById: (_workflowId: WorkflowId, runId: WorkflowRunId) =>
          Promise.resolve(runs.find((run) => run.id === runId) ?? null),
        listWorkflowIds: () => Promise.resolve([]),
      },
      workflowRepo: { findByName: () => Promise.resolve(null) },
    },
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
      signalRequiresExplicitGrant: false,
    },
  } as unknown as ConnectionContext;
  const socket = createMockSocket();
  await handleRunDoctor(socket, ctx, "req-doctor", { fix }, null);
  return { reply: JSON.parse(socket.sent[0]).payload, saved, reads };
}

async function withDoctorTracker(
  fn: (tracker: RunTrackerStore) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const tracker = new RunTrackerStore(join(dir, "run_tracker.db"));
    try {
      await fn(tracker);
    } finally {
      tracker.close();
    }
  });
}

Deno.test("handleRunDoctor: without recorded heartbeats, a run a live process on this host owns is not orphaned (swamp-club#3059)", async () => {
  await withDoctorTracker(async (tracker) => {
    const run = runningRecord(Deno.pid, "peer");
    registerLocalRow(tracker, run);

    const report = await doctorScan(tracker, [run], [], false);
    assertEquals(report.reply.orphanedWorkflowRuns, 0);

    const fix = await doctorScan(tracker, [run], [], true);
    assertEquals(fix.reply.orphanedWorkflowRuns, 0);
    assertEquals(fix.reply.orphanedReaped, 0);
    assertEquals(fix.saved, []);
    assertEquals(run.status, "running");
    assertEquals(tracker.findById(run.id)?.status, "running");
  });
});

Deno.test("handleRunDoctor: without recorded heartbeats, another instance's run with no tracker row is left alone", async () => {
  await withDoctorTracker(async (tracker) => {
    const run = runningRecord(DEAD_PID, "peer");

    const fix = await doctorScan(tracker, [run], [], true);

    assertEquals(fix.reply.orphanedWorkflowRuns, 0);
    assertEquals(fix.saved, []);
    assertEquals(run.status, "running");
  });
});

Deno.test("handleRunDoctor: without recorded heartbeats, fix interrupts a run whose owner on this host is dead", async () => {
  await withDoctorTracker(async (tracker) => {
    const run = runningRecord(DEAD_PID, "old-instance");
    registerLocalRow(tracker, run);

    const report = await doctorScan(tracker, [run], [], false);
    assertEquals(report.reply.orphanedWorkflowRuns, 1);
    assertEquals(report.reply.orphanedReaped, 0);
    assertEquals(report.saved, []);

    // As a reap on heartbeat age leaves the row; only such a row is settled.
    tracker.complete(run.id, "interrupted");
    const fix = await doctorScan(tracker, [run], [], true);
    assertEquals(fix.reply.orphanedReaped, 1);
    assertEquals(fix.saved, [run.id]);
    assertEquals(run.status, "interrupted");
    assertEquals(run.tags.interrupt_reason, "doctor_reap");
    assertEquals(tracker.findById(run.id)?.cancelReason, "doctor_reap");
  });
});

Deno.test("handleRunDoctor: with heartbeats recorded, fix interrupts a run of an instance that has none", async () => {
  await withDoctorTracker(async (tracker) => {
    const run = runningRecord(DEAD_PID, "peer");

    const fix = await doctorScan(tracker, [run], ["self"], true);

    assertEquals(fix.reply.orphanedWorkflowRuns, 1);
    assertEquals(fix.reply.orphanedReaped, 1);
    assertEquals(fix.saved, [run.id]);
    assertEquals(run.status, "interrupted");
  });
});

Deno.test("handleRunDoctor: a run of an instance that still has a heartbeat is not orphaned", async () => {
  await withDoctorTracker(async (tracker) => {
    const run = runningRecord(DEAD_PID, "peer");

    const fix = await doctorScan(tracker, [run], ["self", "peer"], true);

    assertEquals(fix.reply.orphanedWorkflowRuns, 0);
    assertEquals(fix.saved, []);
    assertEquals(run.status, "running");
  });
});

Deno.test("handleRunDoctor: reads each instance's heartbeat once for the whole scan", async () => {
  await withDoctorTracker(async (tracker) => {
    const runs = [
      runningRecord(DEAD_PID, "peer"),
      runningRecord(DEAD_PID, "peer"),
    ];

    const report = await doctorScan(tracker, runs, ["self"], false);

    assertEquals(report.reply.orphanedWorkflowRuns, 2);
    assertEquals(report.reads.toSorted(), [
      "heartbeats/peer",
      "heartbeats/self",
    ]);
  });
});
