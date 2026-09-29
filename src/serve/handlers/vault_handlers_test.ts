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
import { stringify as stringifyYaml } from "@std/yaml";
import { dirname, join } from "@std/path";
import {
  handleVaultAnnotate,
  handleVaultCreate,
  handleVaultDelete,
  handleVaultEdit,
  handleVaultPut,
  isReservedVaultName,
} from "./vault_handlers.ts";
import { buildMarkDirtyHook } from "../../cli/repo_context.ts";
import { registerManagedConfig } from "../../infrastructure/persistence/paths.ts";
import { createRepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import type { ConnectionContext } from "./shared.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
} from "../../domain/datastore/datastore_sync_service.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import { EventBus } from "../../domain/events/event_bus.ts";
import "../../domain/vaults/vault_types.ts";
import { VaultConfig } from "../../domain/vaults/vault_config.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import type {
  VaultDeleteProvider,
  VaultProvider,
} from "../../domain/vaults/vault_provider.ts";
import type { Grant } from "../../domain/models/access/grant_model.ts";
import { GrantBasedAccessDecisionService } from "../../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../../domain/access/policy_snapshot.ts";
import type { PolicySnapshotLoader } from "../../domain/access/policy_snapshot_loader.ts";
import type { Principal } from "../../domain/access/principal.ts";
import { evaluateGrantCondition } from "../../infrastructure/cel/grant_condition_environment.ts";

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

Deno.test("handleVaultAnnotate: makes no datastore push, since nothing it writes is in the cache (swamp-club#2415)", async () => {
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

    // Annotations live in the always-local .swamp/secrets. A bare
    // markDirty() here used to turn every annotate into a full-cache push.
    assertEquals(markDirtyCalls, []);
    assertEquals(pushCalls, []);
  });
});

Deno.test("handleVaultDelete: makes no datastore push, since nothing it writes is in the cache (swamp-club#2415)", async () => {
  await withTempDir(async (dir) => {
    await setupVault(dir);

    const { service, pushCalls, markDirtyCalls } = createMockSyncService();
    const ctx = createAnnotateCtx(dir, service);
    const socket = createMockSocket();

    await handleVaultDelete(
      socket,
      ctx,
      "req-delete",
      { vaultName: TEST_VAULT_NAME, key: "test-key" },
      new AbortController(),
      null,
    );

    const response = JSON.parse(socket.sent[0]);
    assertEquals(response.type, "vault.delete");
    assertEquals(markDirtyCalls, []);
    assertEquals(pushCalls, []);
  });
});

for (const force of [false, true]) {
  Deno.test(
    `handleVaultDelete: a missing vault${
      force ? " with force" : ""
    } replies not found without listing the configured vaults (swamp-club#2716)`,
    async () => {
      await withTempDir(async (dir) => {
        await setupVault(dir);
        const socket = createMockSocket();

        await handleVaultDelete(
          socket,
          createAnnotateCtx(dir),
          "req-delete",
          { vaultName: "no-such-vault", key: "test-key", force },
          new AbortController(),
          null,
        );

        assertEquals(socket.sent.length, 1);
        const response = JSON.parse(socket.sent[0]);
        assertEquals(response.type, "error");
        assertEquals(response.error.code, "vault_delete_failed");
        assertEquals(response.error.message, "Vault not found: no-such-vault");
        assertEquals(response.error.details, { reason: "not_found" });
        assert(!socket.sent[0].includes(TEST_VAULT_NAME));
      });
    },
  );
}

for (const force of [false, true]) {
  Deno.test(
    `handleVaultPut: a missing vault${
      force ? " with force" : ""
    } replies not found without listing the configured vaults (swamp-club#2716)`,
    async () => {
      await withTempDir(async (dir) => {
        await setupVault(dir);
        const socket = createMockSocket();

        await handleVaultPut(
          socket,
          createAnnotateCtx(dir),
          "req-put",
          { vaultName: "no-such-vault", key: "test-key", value: "v", force },
          new AbortController(),
          null,
        );

        assertEquals(socket.sent.length, 1);
        const response = JSON.parse(socket.sent[0]);
        assertEquals(response.type, "error");
        assertEquals(response.error.code, "vault_put_failed");
        assertEquals(response.error.message, "Vault not found: no-such-vault");
        assertEquals(response.error.details, { reason: "not_found" });
        assert(!socket.sent[0].includes(TEST_VAULT_NAME));
      });
    },
  );
}

Deno.test("handleVaultDelete: a missing secret with force is a no-op success", async () => {
  await withTempDir(async (dir) => {
    await setupVault(dir);
    const socket = createMockSocket();

    await handleVaultDelete(
      socket,
      createAnnotateCtx(dir),
      "req-delete",
      { vaultName: TEST_VAULT_NAME, key: "no-such-key", force: true },
      new AbortController(),
      null,
    );

    const response = JSON.parse(socket.sent[0]);
    assertEquals(response.type, "vault.delete");
    assertEquals(response.payload.data.noOp, true);
  });
});

Deno.test("handleVaultDelete: with force, a provider's coded not-found Error for a missing secret is still a no-op success", async () => {
  // Provider SDK errors (e.g. Azure's RestError) are Errors that carry a string
  // code; they must reach the missing-secret branch, not the SwampError one.
  const type = `@test/coded-not-found-${crypto.randomUUID()}`;
  const provider = (name: string): VaultProvider & VaultDeleteProvider => ({
    get: () => Promise.reject(new Error("unused")),
    put: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    getName: () => name,
    delete: (key: string) =>
      Promise.reject(
        Object.assign(
          new Error(`A secret with (name/id) ${key} was not found`),
          { code: "SecretNotFound" },
        ),
      ),
  });
  vaultTypeRegistry.register({
    type,
    name: "Coded not-found vault",
    description: "Throws an Error with a string code on delete",
    isBuiltIn: false,
    createProvider: provider,
  });
  try {
    await withTempDir(async (dir) => {
      const repoContext = createRepositoryContext({
        repoDir: dir,
        enableIndexing: false,
      });
      try {
        await repoContext.vaultConfigRepo.save(
          VaultConfig.create(crypto.randomUUID(), "coded-vault", type, {}),
        );
      } finally {
        repoContext.catalogStore.close();
      }
      const socket = createMockSocket();

      await handleVaultDelete(
        socket,
        createAnnotateCtx(dir),
        "req-delete",
        { vaultName: "coded-vault", key: "no-such-key", force: true },
        new AbortController(),
        null,
      );

      const response = JSON.parse(socket.sent[0]);
      assertEquals(response.type, "vault.delete");
      assertEquals(response.payload.data.noOp, true);
    });
  } finally {
    vaultTypeRegistry.invalidateType(type);
  }
});

type VaultSyncEvent = { kind: "mark"; relPath?: string } | { kind: "push" };

async function runVaultCreate(
  repoDir: string,
  cacheRoot: string,
): Promise<{ events: VaultSyncEvent[]; response: { type: string } }> {
  const events: VaultSyncEvent[] = [];
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
  const repoContext = createRepositoryContext({
    repoDir,
    enableIndexing: false,
    markDirty: buildMarkDirtyHook(service, cacheRoot, repoDir),
  });
  try {
    const ctx: ConnectionContext = {
      ...createAnnotateCtx(repoDir, service),
      repoContext,
    };
    const socket = createMockSocket();
    await handleVaultCreate(
      socket,
      ctx,
      "req-create",
      { vaultType: "local_encryption", name: "new-vault" },
      new AbortController(),
      null,
    );
    return { events, response: JSON.parse(socket.sent[0]) };
  } finally {
    repoContext.catalogStore.close();
  }
}

Deno.test("handleVaultCreate: marks the new config file by path under managedConfig (swamp-club#2415)", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const cacheRoot = join(dir, "cache");
    await Deno.mkdir(repoDir, { recursive: true });
    // Keyed by this run's temp dir, so it cannot leak into another test.
    registerManagedConfig(repoDir, true, join(cacheRoot, "config"));

    const { events, response } = await runVaultCreate(repoDir, cacheRoot);

    assertEquals(response.type, "vault.create");
    assertEquals(events.length, 2);
    const [mark, push] = events;
    assertEquals(push, { kind: "push" });
    assert(
      mark.kind === "mark" &&
        mark.relPath?.startsWith("config/vaults/local_encryption/") &&
        mark.relPath.endsWith(".yaml"),
      `expected a per-path mark for the vault config, got ${
        JSON.stringify(mark)
      }`,
    );
  });
});

Deno.test("handleVaultCreate: sends no mark for a repo-local config without managedConfig (swamp-club#2415)", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    await Deno.mkdir(repoDir, { recursive: true });

    const { events, response } = await runVaultCreate(
      repoDir,
      join(dir, "cache"),
    );

    assertEquals(response.type, "vault.create");
    // <repo>/vaults is never synced, so the hook drops the mark and the
    // push takes the fast path.
    assertEquals(events, [{ kind: "push" }]);
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

// --- handleVaultEdit (swamp-club#2426) ---

const VAULT_EDITOR: Principal = { kind: "user", id: "editor" };

function vaultGrant(overrides: Partial<Grant>): Grant {
  return {
    id: crypto.randomUUID(),
    subject: { kind: "user", name: "editor" },
    effect: "allow",
    actions: ["write"],
    resource: { kind: "data", pattern: "*" },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

interface VaultEditRun {
  frames: Array<Record<string, unknown> & { type: string }>;
  events: VaultSyncEvent[];
  read: (id: string) => Promise<VaultConfig | null>;
  /** The vault file's text, for files that may not parse. */
  readRaw: (id: string) => Promise<string>;
}

/**
 * Seeds `vaults` into a real repository context for `repoDir`, then runs one
 * vault.edit request built by `payloadFor` from the seeded configs.
 */
async function runVaultEdit(
  repoDir: string,
  cacheRoot: string,
  vaults: VaultConfig[],
  payloadFor: (vaults: VaultConfig[]) => Parameters<typeof handleVaultEdit>[3],
  options: { grants?: Grant[]; brokenIds?: string[] } = {},
): Promise<VaultEditRun> {
  const events: VaultSyncEvent[] = [];
  const service: DatastoreSyncService = {
    pullChanged: () => Promise.resolve(0),
    pushChanged: () => {
      events.push({ kind: "push" });
      return Promise.resolve(0);
    },
    markDirty: (opts) => {
      events.push({ kind: "mark", relPath: opts?.relPath });
      return Promise.resolve();
    },
  };
  const repoContext = createRepositoryContext({
    repoDir,
    enableIndexing: false,
    markDirty: buildMarkDirtyHook(service, cacheRoot, repoDir),
  });
  try {
    for (const vault of vaults) {
      await repoContext.vaultConfigRepo.save(vault);
    }
    for (const id of options.brokenIds ?? []) {
      const path = repoContext.vaultConfigRepo.getPath("local_encryption", id);
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, BROKEN_YAML);
    }
    events.length = 0;
    const base = createAnnotateCtx(repoDir, service);
    const ctx: ConnectionContext = {
      ...base,
      repoContext,
      ...(options.grants
        ? {
          authConfig: { ...base.authConfig, mode: "token" as const },
          policySnapshotLoader: {
            decisionService: new GrantBasedAccessDecisionService(
              new PolicySnapshot(options.grants, [], evaluateGrantCondition),
            ),
          } as unknown as PolicySnapshotLoader,
        }
        : {}),
    };
    const socket = createMockSocket();
    await handleVaultEdit(
      socket,
      ctx,
      "req-edit",
      payloadFor(vaults),
      new AbortController(),
      options.grants ? VAULT_EDITOR : null,
    );
    const repo = repoContext.vaultConfigRepo;
    return {
      frames: socket.sent.map((raw) => JSON.parse(raw)),
      events,
      read: (id) => repo.findById("local_encryption", id),
      readRaw: (id) => Deno.readTextFile(repo.getPath("local_encryption", id)),
    };
  } finally {
    repoContext.catalogStore.close();
  }
}

const BROKEN_YAML = "name: [broken\n  : : :\n";

function localVault(name: string): VaultConfig {
  return VaultConfig.create(
    crypto.randomUUID(),
    name,
    "local_encryption",
    {},
  );
}

function vaultYaml(
  vault: VaultConfig,
  overrides: Record<string, unknown> = {},
): string {
  return stringifyYaml({
    ...vault.toData(),
    ...overrides,
  } as unknown as Record<string, unknown>);
}

Deno.test("handleVaultEdit: rejects a request without content instead of opening an editor on the server", async () => {
  await withTempDir(async (dir) => {
    const { frames } = await runVaultEdit(
      join(dir, "repo"),
      join(dir, "cache"),
      [localVault("plain-vault")],
      () => ({ vaultNameOrId: "plain-vault" }),
    );

    assertEquals(frames.length, 1);
    assertEquals(
      (frames[0].error as { code: string }).code,
      "invalid_request",
    );
  });
});

Deno.test("handleVaultEdit: updates the managed vault config and pushes it by path", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const cacheRoot = join(dir, "cache");
    await Deno.mkdir(repoDir, { recursive: true });
    // Keyed by this run's temp dir, so it cannot leak into another test.
    registerManagedConfig(repoDir, true, join(cacheRoot, "config"));
    const vault = localVault("managed-vault");

    const { frames, events, read } = await runVaultEdit(
      repoDir,
      cacheRoot,
      [vault],
      () => ({
        vaultNameOrId: "managed-vault",
        content: vaultYaml(vault, { auditReads: true }),
      }),
    );

    assertEquals(frames.length, 1);
    assertEquals(frames[0].type, "vault.edit");
    assertEquals(
      (frames[0].payload as { data: { status: string } }).data.status,
      "updated",
    );
    assertEquals((await read(vault.id))?.auditReads, true);
    assertEquals(events.length, 2);
    const [mark, push] = events;
    assertEquals(push, { kind: "push" });
    assertEquals(mark, {
      kind: "mark",
      relPath: `config/vaults/local_encryption/${vault.id}.yaml`,
    });
  });
});

Deno.test("handleVaultEdit: a request by id cannot sidestep a name-scoped deny", async () => {
  await withTempDir(async (dir) => {
    const vault = localVault("prod-secrets");

    const { frames, read } = await runVaultEdit(
      join(dir, "repo"),
      join(dir, "cache"),
      [vault],
      () => ({
        vaultNameOrId: vault.id,
        content: vaultYaml(vault, { auditReads: true }),
      }),
      {
        grants: [
          vaultGrant({}),
          vaultGrant({
            effect: "deny",
            resource: { kind: "data", pattern: "prod-*" },
          }),
        ],
      },
    );

    assertEquals(frames.length, 1);
    assertEquals(frames[0].type, "error");
    assertEquals((await read(vault.id))?.auditReads, false);
  });
});

Deno.test("handleVaultEdit: a rename into a denied name sends one error and writes nothing", async () => {
  await withTempDir(async (dir) => {
    const vault = localVault("dev-secrets");

    const { frames, read } = await runVaultEdit(
      join(dir, "repo"),
      join(dir, "cache"),
      [vault],
      () => ({
        vaultNameOrId: "dev-secrets",
        content: vaultYaml(vault, { name: "prod-secrets" }),
      }),
      {
        grants: [
          vaultGrant({}),
          vaultGrant({
            effect: "deny",
            resource: { kind: "data", pattern: "prod-*" },
          }),
        ],
      },
    );

    assertEquals(frames.length, 1);
    assertEquals(frames[0].type, "error");
    assertEquals((await read(vault.id))?.name, "dev-secrets");
  });
});

Deno.test("handleVaultEdit: refuses a reserved vault", async () => {
  await withTempDir(async (dir) => {
    const { frames } = await runVaultEdit(
      join(dir, "repo"),
      join(dir, "cache"),
      [],
      () => ({
        vaultNameOrId: "_token-secrets",
        content: "name: _token-secrets\n",
      }),
    );

    assertEquals(frames.length, 1);
    assertEquals((frames[0].error as { code: string }).code, "forbidden");
  });
});

Deno.test("handleVaultEdit: reports a rejected edit with its specific message", async () => {
  await withTempDir(async (dir) => {
    const vault = localVault("typed-vault");

    const { frames, read } = await runVaultEdit(
      join(dir, "repo"),
      join(dir, "cache"),
      [vault],
      () => ({
        vaultNameOrId: "typed-vault",
        content: vaultYaml(vault, { type: "aws-sm" }),
      }),
    );

    assertEquals(frames.length, 1);
    const error = frames[0].error as { code: string; message: string };
    assertEquals(error.code, "vault_edit_failed");
    assert(
      error.message.includes("Cannot change the type"),
      `expected the specific message, got ${error.message}`,
    );
    assertEquals((await read(vault.id))?.type, "local_encryption");
  });
});

Deno.test("handleVaultEdit: reports an unknown vault as not found", async () => {
  await withTempDir(async (dir) => {
    const { frames } = await runVaultEdit(
      join(dir, "repo"),
      join(dir, "cache"),
      [],
      () => ({ vaultNameOrId: "no-such-vault", content: "name: x\n" }),
    );

    assertEquals(frames.length, 1);
    assertEquals((frames[0].error as { code: string }).code, "not_found");
  });
});

// --- repairing a vault whose config does not parse (swamp-club#2693) ---

const BROKEN_ID = "0b0b0b0b-0000-4000-8000-000000000001";

const ADMIN_GRANT = vaultGrant({
  actions: ["admin"],
  resource: { kind: "access", pattern: "*" },
});

function repairPayload(name: string) {
  return () => ({
    vaultNameOrId: BROKEN_ID,
    vaultType: "local_encryption",
    content: `name: ${name}\ntype: local_encryption\nconfig: {}\n`,
  });
}

Deno.test("handleVaultEdit: an admin with write on the new name repairs a vault that does not parse", async () => {
  await withTempDir(async (dir) => {
    const { frames, read } = await runVaultEdit(
      join(dir, "repo"),
      join(dir, "cache"),
      [],
      repairPayload("fixed-vault"),
      { grants: [vaultGrant({}), ADMIN_GRANT], brokenIds: [BROKEN_ID] },
    );

    assertEquals(frames.length, 1);
    assertEquals(frames[0].type, "vault.edit");
    const data = (frames[0].payload as { data: Record<string, unknown> })
      .data;
    assertEquals(data.repaired, true);
    assertEquals(data.name, "fixed-vault");
    assertEquals((await read(BROKEN_ID))?.name, "fixed-vault");
  });
});

Deno.test("handleVaultEdit: write without admin cannot repair a vault that does not parse", async () => {
  await withTempDir(async (dir) => {
    const { frames, readRaw } = await runVaultEdit(
      join(dir, "repo"),
      join(dir, "cache"),
      [],
      repairPayload("fixed-vault"),
      { grants: [vaultGrant({})], brokenIds: [BROKEN_ID] },
    );

    assertEquals(frames.length, 1);
    assertStringIncludes(
      (frames[0].error as { message: string }).message,
      "does not have 'admin' on access:*",
    );
    assertEquals(await readRaw(BROKEN_ID), BROKEN_YAML);
  });
});

Deno.test("handleVaultEdit: an admin cannot repair a vault into a name denied to them", async () => {
  await withTempDir(async (dir) => {
    const { frames, readRaw } = await runVaultEdit(
      join(dir, "repo"),
      join(dir, "cache"),
      [],
      repairPayload("prod-secrets"),
      {
        grants: [
          vaultGrant({}),
          ADMIN_GRANT,
          vaultGrant({
            effect: "deny",
            resource: { kind: "data", pattern: "prod-*" },
          }),
        ],
        brokenIds: [BROKEN_ID],
      },
    );

    assertEquals(frames.length, 1);
    assertStringIncludes(
      (frames[0].error as { message: string }).message,
      "is explicitly denied 'write' on data:prod-secrets",
    );
    assertEquals(await readRaw(BROKEN_ID), BROKEN_YAML);
  });
});

Deno.test("handleVaultEdit: a broken vault file stays not found when the request names another vault", async () => {
  await withTempDir(async (dir) => {
    for (
      const payload of [
        // A name that matches nothing, with a type.
        {
          vaultNameOrId: "missing-vault",
          vaultType: "local_encryption",
          content: "name: missing-vault\n",
        },
        // The broken vault's id without a type.
        { vaultNameOrId: BROKEN_ID, content: "name: fixed-vault\n" },
      ]
    ) {
      const { frames, readRaw } = await runVaultEdit(
        join(dir, crypto.randomUUID()),
        join(dir, "cache"),
        [],
        () => payload,
        { grants: [vaultGrant({}), ADMIN_GRANT], brokenIds: [BROKEN_ID] },
      );

      assertEquals(frames.length, 1);
      assertEquals(
        (frames[0].error as { code: string }).code,
        "not_found",
      );
      assertEquals(await readRaw(BROKEN_ID), BROKEN_YAML);
    }
  });
});

Deno.test("handleVaultEdit: a valid vault resolves by id and type beside a broken one", async () => {
  await withTempDir(async (dir) => {
    const vault = localVault("good-vault");

    const { frames, read } = await runVaultEdit(
      join(dir, "repo"),
      join(dir, "cache"),
      [vault],
      () => ({
        vaultNameOrId: vault.id,
        vaultType: "local_encryption",
        content: vaultYaml(vault, { auditReads: true }),
      }),
      { grants: [vaultGrant({})], brokenIds: [BROKEN_ID] },
    );

    assertEquals(frames[0].type, "vault.edit");
    assertEquals((await read(vault.id))?.auditReads, true);
  });
});

Deno.test("handleVaultEdit: an admin repairs one broken vault while another is broken too", async () => {
  await withTempDir(async (dir) => {
    const otherId = "0b0b0b0b-0000-4000-8000-000000000000";

    const { frames, read, readRaw } = await runVaultEdit(
      join(dir, "repo"),
      join(dir, "cache"),
      [],
      repairPayload("fixed-vault"),
      {
        grants: [vaultGrant({}), ADMIN_GRANT],
        brokenIds: [otherId, BROKEN_ID],
      },
    );

    assertEquals(frames[0].type, "vault.edit");
    assertEquals((await read(BROKEN_ID))?.name, "fixed-vault");
    assertEquals(await readRaw(otherId), BROKEN_YAML);
  });
});

// --- local_encryption key source over serve (swamp-club#2690) ---

/** Runs one vault.create request against a repo with no datastore sync. */
async function runVaultCreateWith(
  repoDir: string,
  payload: Parameters<typeof handleVaultCreate>[3],
): Promise<{
  frames: Array<Record<string, unknown> & { type: string }>;
  vaults: VaultConfig[];
}> {
  const repoContext = createRepositoryContext({
    repoDir,
    enableIndexing: false,
  });
  try {
    const socket = createMockSocket();
    await handleVaultCreate(
      socket,
      { ...createAnnotateCtx(repoDir), repoContext },
      "req-create",
      payload,
      new AbortController(),
      null,
    );
    return {
      frames: socket.sent.map((raw) => JSON.parse(raw)),
      vaults: await repoContext.vaultConfigRepo.findAll(),
    };
  } finally {
    repoContext.catalogStore.close();
  }
}

Deno.test("handleVaultCreate: refuses a local_encryption config naming its own key source", async () => {
  for (
    const config of [
      { base_dir: "/tmp/outside" },
      { key_file: "/tmp/outside/key" },
      { ssh_key_path: "~/.ssh/id_ed25519" },
      { auto_generate: false },
    ]
  ) {
    await withTempDir(async (dir) => {
      const field = Object.keys(config)[0];
      for (const vaultType of ["local_encryption", "LOCAL_ENCRYPTION"]) {
        const { frames, vaults } = await runVaultCreateWith(dir, {
          vaultType,
          name: "remote-vault",
          config,
        });

        assertEquals(frames.length, 1);
        const error = frames[0].error as { code: string; message: string };
        assertEquals(error.code, "vault_create_failed");
        assertStringIncludes(error.message, `Cannot set ${field}`);
        assertEquals(vaults, []);
      }
    });
  }
});

Deno.test("handleVaultCreate: a local_encryption config without a key source gets the server's", async () => {
  await withTempDir(async (dir) => {
    const { frames, vaults } = await runVaultCreateWith(dir, {
      vaultType: "local_encryption",
      name: "remote-vault",
      config: {},
    });

    assertEquals(frames[0].type, "vault.create");
    assertEquals(vaults.length, 1);
    assertEquals(vaults[0].config, { auto_generate: true, base_dir: dir });
  });
});

function keyedVault(name: string, repoDir: string): VaultConfig {
  return VaultConfig.create(
    crypto.randomUUID(),
    name,
    "local_encryption",
    { auto_generate: true, base_dir: repoDir },
  );
}

Deno.test("handleVaultEdit: refuses a change to a local_encryption key source and writes nothing", async () => {
  for (
    const change of [
      { base_dir: "/tmp/outside" },
      { key_file: "/tmp/outside/key" },
      { ssh_key_path: "~/.ssh/id_ed25519" },
      { auto_generate: false },
    ]
  ) {
    await withTempDir(async (dir) => {
      const repoDir = join(dir, "repo");
      const vault = keyedVault("keyed-vault", repoDir);
      const field = Object.keys(change)[0];

      const { frames, read } = await runVaultEdit(
        repoDir,
        join(dir, "cache"),
        [vault],
        () => ({
          vaultNameOrId: "keyed-vault",
          content: vaultYaml(vault, { config: { ...vault.config, ...change } }),
        }),
      );

      assertEquals(frames.length, 1);
      const error = frames[0].error as { code: string; message: string };
      assertEquals(error.code, "vault_edit_failed");
      assertStringIncludes(error.message, `Cannot change ${field} of vault`);
      assertEquals((await read(vault.id))?.config, vault.config);
    });
  }
});

Deno.test("handleVaultEdit: a round-trip that keeps the key source can rename the vault", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const vault = keyedVault("keyed-vault", repoDir);

    const { frames, read } = await runVaultEdit(
      repoDir,
      join(dir, "cache"),
      [vault],
      () => ({
        vaultNameOrId: "keyed-vault",
        content: vaultYaml(vault, { name: "renamed-vault", auditReads: true }),
      }),
    );

    assertEquals(frames[0].type, "vault.edit");
    const saved = await read(vault.id);
    assertEquals(saved?.name, "renamed-vault");
    assertEquals(saved?.auditReads, true);
    assertEquals(saved?.config, vault.config);
  });
});

Deno.test("handleVaultEdit: a repair gets the server's key source and refuses its own", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const refused = await runVaultEdit(
      repoDir,
      join(dir, "cache"),
      [],
      () => ({
        vaultNameOrId: BROKEN_ID,
        vaultType: "local_encryption",
        content:
          "name: fixed-vault\ntype: local_encryption\nconfig:\n  key_file: /tmp/k\n",
      }),
      { grants: [vaultGrant({}), ADMIN_GRANT], brokenIds: [BROKEN_ID] },
    );
    const error = refused.frames[0].error as { message: string };
    assertStringIncludes(error.message, "Cannot set key_file");
    assertEquals(await refused.readRaw(BROKEN_ID), BROKEN_YAML);

    const { frames, read } = await runVaultEdit(
      repoDir,
      join(dir, "cache"),
      [],
      repairPayload("fixed-vault"),
      { grants: [vaultGrant({}), ADMIN_GRANT], brokenIds: [BROKEN_ID] },
    );
    assertEquals(frames[0].type, "vault.edit");
    assertEquals((await read(BROKEN_ID))?.config, {
      auto_generate: true,
      base_dir: repoDir,
    });
  });
});
