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

// The OAuth server-token mint against a real repository on disk, wired to a
// sync service through the same markDirty hook serve uses. Pins which dirty
// signals the mint sends and in what order relative to its push
// (swamp-club#2408).

import { assert, assertEquals, assertExists } from "@std/assert";
import { ensureDir } from "@std/fs";
import { isAbsolute, join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { buildMarkDirtyHook } from "../src/cli/repo_context.ts";
import type { ServeAuthConfig } from "../src/domain/access/serve_auth_config.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
} from "../src/domain/datastore/datastore_sync_service.ts";
import { findDefinitionByIdOrName } from "../src/domain/models/model_lookup.ts";
import { TOKEN_SECRETS_VAULT_NAME } from "../src/domain/vaults/control_plane_vault_provider.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { createDeviceAuthDeps } from "../src/serve/device_auth_handler.ts";

await initializeLogging({});

const AUTH_CONFIG: ServeAuthConfig & { oauthClientId: string } = {
  mode: "oauth",
  admins: ["user:admin"],
  allowedCollectives: ["team-a"],
  allowedUsers: ["user-1"],
  oauthProvider: "https://auth.example.com",
  oauthClientId: "test-client-id",
  groupsField: "collectives",
  restrictedModelTypes: [],
  restrictedCommands: [],
  approveRequiresExplicitGrant: false,
};

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

// A repo-local vault resolves _token-secrets without registering a
// process-global provider.
async function writeTokenSecretsVault(dir: string): Promise<void> {
  const vaultDir = join(dir, "vaults", TOKEN_SECRETS_VAULT_NAME);
  await ensureDir(vaultDir);
  await Deno.writeTextFile(
    join(vaultDir, "token-secrets-id.yaml"),
    stringifyYaml({
      id: "token-secrets-id",
      name: TOKEN_SECRETS_VAULT_NAME,
      type: "mock",
      config: {},
      createdAt: new Date().toISOString(),
    }),
  );
}

type MarkEvent = { kind: "mark"; relPath?: string };
type SyncEvent = MarkEvent | { kind: "push"; options: DatastoreSyncOptions };

// Records marks and pushes in one log, so a test can check their order.
function createRecordingSyncService(): {
  service: DatastoreSyncService;
  events: SyncEvent[];
} {
  const events: SyncEvent[] = [];
  const service: DatastoreSyncService = {
    pullChanged(_options?: DatastoreSyncOptions): Promise<number | void> {
      return Promise.resolve(0);
    },
    pushChanged(options?: DatastoreSyncOptions): Promise<number | void> {
      events.push({ kind: "push", options: options ?? {} });
      return Promise.resolve(0);
    },
    markDirty(options?: DatastoreSyncOptions): Promise<void> {
      events.push({ kind: "mark", relPath: options?.relPath });
      return Promise.resolve();
    },
  };
  return { service, events };
}

Deno.test("createDeviceAuthDeps: mintServerToken sends only per-path markDirty before pushChanged (swamp-club#2408)", async () => {
  await withTempDir(async (dir) => {
    await writeTokenSecretsVault(dir);

    const { service, events } = createRecordingSyncService();
    const repoContext = createRepositoryContext({
      repoDir: dir,
      enableIndexing: false,
      namespace: "infra",
      markDirty: buildMarkDirtyHook(service, swampPath(dir), dir),
    });
    try {
      const deps = createDeviceAuthDeps(
        AUTH_CONFIG,
        "test-client-secret",
        dir,
        repoContext,
        undefined,
        service,
        "infra",
      );

      const token = await deps.mintServerToken(
        "user:user-1",
        "user@example.com",
        ["team-a"],
        [],
        dir,
        repoContext,
      );
      const tokenName = token.split(".")[0];

      assertEquals(
        events.filter((e) => e.kind === "push"),
        [{ kind: "push", options: { namespace: "infra" } }],
      );
      assertEquals(
        events.at(-1)?.kind,
        "push",
        "every mark must come before the push",
      );

      const marks = events.filter((e): e is MarkEvent => e.kind === "mark");
      // A bare markDirty() sets bulkInvalidated in the datastore extension,
      // which turns the push into a walk of the whole cache.
      assertEquals(
        marks.filter((m) => m.relPath === undefined),
        [],
        "mint must not call bare markDirty()",
      );
      const relPaths = marks.map((m) => m.relPath!);
      for (const relPath of relPaths) {
        assert(
          !isAbsolute(relPath) && !relPath.includes("\\"),
          `expected a cache-relative forward-slash path, got ${relPath}`,
        );
      }
      assert(
        relPaths.some((p) => p.startsWith("auto-definitions/")),
        `expected a per-path mark for the token definition, got ${relPaths}`,
      );
      assert(
        relPaths.some((p) => p.endsWith("/token-main")),
        `expected a per-path mark for the token data, got ${relPaths}`,
      );

      assertExists(
        await findDefinitionByIdOrName(repoContext.definitionRepo, tokenName),
      );
    } finally {
      repoContext.catalogStore.close();
    }
  });
});

// Models an ungated push (post-run, post-resume) landing right after each
// mark. The repositories mark a path before writing it, so that push finds
// the path absent under the cache root, takes it as a delete and clears the
// mark. Only marks made after the write survive to the mint's own push.
function createRacingSyncService(cacheRoot: string): {
  service: DatastoreSyncService;
  dirtyAtPush: string[];
} {
  const dirty = new Set<string>();
  const dirtyAtPush: string[] = [];
  const service: DatastoreSyncService = {
    pullChanged(_options?: DatastoreSyncOptions): Promise<number | void> {
      return Promise.resolve(0);
    },
    pushChanged(_options?: DatastoreSyncOptions): Promise<number | void> {
      dirtyAtPush.push(...dirty);
      dirty.clear();
      return Promise.resolve(0);
    },
    async markDirty(options?: DatastoreSyncOptions): Promise<void> {
      if (!options?.relPath) return;
      try {
        await Deno.stat(join(cacheRoot, options.relPath));
        dirty.add(options.relPath);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        dirty.delete(options.relPath);
      }
    },
  };
  return { service, dirtyAtPush };
}

Deno.test("createDeviceAuthDeps: mintServerToken re-marks the token paths after writing them, so a concurrent push cannot drop them (swamp-club#2408)", async () => {
  await withTempDir(async (dir) => {
    await writeTokenSecretsVault(dir);

    const cacheRoot = swampPath(dir);
    const { service, dirtyAtPush } = createRacingSyncService(cacheRoot);
    const repoContext = createRepositoryContext({
      repoDir: dir,
      enableIndexing: false,
      markDirty: buildMarkDirtyHook(service, cacheRoot, dir),
    });
    try {
      const deps = createDeviceAuthDeps(
        AUTH_CONFIG,
        "test-client-secret",
        dir,
        repoContext,
        undefined,
        service,
      );

      await deps.mintServerToken(
        "user:user-1",
        "user@example.com",
        ["team-a"],
        [],
        dir,
        repoContext,
      );

      assert(
        dirtyAtPush.some((p) => p.startsWith("auto-definitions/")),
        `token definition must still be marked when the mint pushes, got ${dirtyAtPush}`,
      );
      assert(
        dirtyAtPush.some((p) => p.endsWith("/token-main")),
        `token data must still be marked when the mint pushes, got ${dirtyAtPush}`,
      );
    } finally {
      repoContext.catalogStore.close();
    }
  });
});
