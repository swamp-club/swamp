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

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import type { DatastoreSyncOptions } from "../src/domain/datastore/datastore_sync_service.ts";
import { join } from "@std/path";
import { createInMemoryRemote } from "@swamp-club/swamp-testing";
import { Definition } from "../src/domain/definitions/definition.ts";
import {
  SERVER_TOKEN_MODEL_TYPE,
  type ServerToken,
  serverTokenModel,
  serverTokenSecretFingerprint,
  TOKEN_DATA_NAME,
} from "../src/domain/models/access/server_token_model.ts";
import { createResourceWriter } from "../src/domain/models/data_writer.ts";
import { RepoPath } from "../src/domain/repo/repo_path.ts";
import { RepoService } from "../src/domain/repo/repo_service.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { runInRootUnitOfWork } from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import {
  configureTestDatastore,
  registerTestDatastoreType,
} from "../src/infrastructure/testing/test_datastore_type.ts";
import { VERSION } from "../src/infrastructure/runtime/build_info.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import { readServerTokenRecord } from "../src/serve/token_auth.ts";
import { serverTokenRecordRefreshOver } from "../src/serve/token_record_refresh.ts";

await initializeLogging({});

const NAME = "svc";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-token-refresh-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function record(secret: string, createdAt: string): Promise<ServerToken> {
  return {
    name: NAME,
    state: "active",
    principalId: "user:live",
    principalEmail: "live@example.com",
    collectives: [],
    groups: [],
    createdAt,
    expiresAt: "2099-01-01T00:00:00.000Z",
    vaultName: "_token-secrets",
    secretKey: `server-token-${NAME}`,
    secretFingerprint: await serverTokenSecretFingerprint(secret),
  };
}

Deno.test("serverTokenRecordRefreshOver: a cache holding another mint's record takes the datastore's paired one, and only that", async () => {
  const remote = createInMemoryRemote();
  const { typeName, dispose } = registerTestDatastoreType(remote);
  try {
    await withTempDir(async (dir) => {
      const repoDir = join(dir, "repo");
      await Deno.mkdir(repoDir, { recursive: true });
      const homeDir = join(repoDir, "test-home");
      await new RepoService(VERSION, {
        homeDir,
        configDir: join(homeDir, ".config", "swamp"),
      }).init(RepoPath.create(repoDir), { tools: [] });
      await configureTestDatastore(repoDir, typeName);
      const ctx = await requireInitializedRepoUnlocked({
        repoDir,
        outputMode: "json",
      });
      try {
        const definition = Definition.create({
          name: NAME,
          type: SERVER_TOKEN_MODEL_TYPE.normalized,
          globalArguments: {},
        });
        const repo = ctx.repoContext.unifiedDataRepo;
        await runInRootUnitOfWork(
          ctx.repoContext,
          { flush: undefined },
          async () => {
            await ctx.repoContext.definitionRepo.save(
              SERVER_TOKEN_MODEL_TYPE,
              definition,
            );
            const { writeResource } = createResourceWriter(
              repo,
              SERVER_TOKEN_MODEL_TYPE,
              definition.id,
              serverTokenModel.resources!,
              undefined,
              undefined,
              definition.tags,
              undefined,
              definition.name,
            );
            await writeResource(
              "token",
              TOKEN_DATA_NAME,
              await record("secret-of-mint-a", "2026-11-25T10:00:00.000Z"),
            );
          },
        );
        await ctx.syncService!.pushChanged();

        let gateEntries = 0;
        const refresh = serverTokenRecordRefreshOver(
          ctx.datastoreConfig,
          ctx.syncService,
          ctx.repoContext,
          (fn) => {
            gateEntries++;
            return fn();
          },
        );
        assert(refresh !== undefined, "an extension datastore can refresh");

        // a peer published the same version over the one this cache wrote
        const latest = await repo.findByName(
          SERVER_TOKEN_MODEL_TYPE,
          definition.id,
          TOKEN_DATA_NAME,
        );
        assert(latest !== null);
        const rawPath = repo.getContentPath(
          SERVER_TOKEN_MODEL_TYPE,
          definition.id,
          TOKEN_DATA_NAME,
          latest.version,
        );
        const remoteBytes = await Deno.readFile(rawPath);
        await Deno.writeTextFile(
          rawPath,
          JSON.stringify(
            await record("secret-of-mint-b", "2026-11-25T10:00:01.000Z"),
          ),
        );
        ctx.repoContext.catalogStore.invalidate();
        assertEquals(
          (await readServerTokenRecord(ctx.repoContext, NAME)).createdAt,
          "2026-11-25T10:00:01.000Z",
        );

        assertEquals(await refresh(NAME, "secret-of-mint-b"), false);
        assertEquals(gateEntries, 0, "a refusal takes no sync gate");
        assertEquals(
          (await readServerTokenRecord(ctx.repoContext, NAME)).createdAt,
          "2026-11-25T10:00:01.000Z",
        );

        assertEquals(await refresh(NAME, "secret-of-mint-a"), true);
        assertEquals(gateEntries, 1, "an adoption takes the gate once");
        assertEquals(await Deno.readFile(rawPath), remoteBytes);
        assertEquals(
          (await readServerTokenRecord(ctx.repoContext, NAME)).createdAt,
          "2026-11-25T10:00:00.000Z",
        );
        assertEquals(await refresh("no-such-token", "secret-of-mint-a"), false);
      } finally {
        ctx.repoContext.catalogStore.close();
      }
    });
  } finally {
    dispose();
  }
});

interface Fixture {
  ctx: Awaited<ReturnType<typeof requireInitializedRepoUnlocked>>;
  latestPath: string;
  fetches: () => number;
  // the next read of the latest marker answers this version instead
  moveMarkerOnNextRead: (version: number) => void;
}

/** a repo whose datastore holds svc's record minted with secret-of-mint-a */
async function withPublishedRecord(
  fn: (f: Fixture) => Promise<void>,
): Promise<void> {
  const remote = createInMemoryRemote();
  const { typeName, dispose } = registerTestDatastoreType(remote);
  try {
    await withTempDir(async (dir) => {
      const repoDir = join(dir, "repo");
      await Deno.mkdir(repoDir, { recursive: true });
      const homeDir = join(repoDir, "test-home");
      await new RepoService(VERSION, {
        homeDir,
        configDir: join(homeDir, ".config", "swamp"),
      }).init(RepoPath.create(repoDir), { tools: [] });
      await configureTestDatastore(repoDir, typeName);
      const ctx = await requireInitializedRepoUnlocked({
        repoDir,
        outputMode: "json",
      });
      try {
        const definition = Definition.create({
          name: NAME,
          type: SERVER_TOKEN_MODEL_TYPE.normalized,
          globalArguments: {},
        });
        const repo = ctx.repoContext.unifiedDataRepo;
        await runInRootUnitOfWork(
          ctx.repoContext,
          { flush: undefined },
          async () => {
            await ctx.repoContext.definitionRepo.save(
              SERVER_TOKEN_MODEL_TYPE,
              definition,
            );
            const { writeResource } = createResourceWriter(
              repo,
              SERVER_TOKEN_MODEL_TYPE,
              definition.id,
              serverTokenModel.resources!,
              undefined,
              undefined,
              definition.tags,
              undefined,
              definition.name,
            );
            await writeResource(
              "token",
              TOKEN_DATA_NAME,
              await record("secret-of-mint-a", "2026-11-25T10:00:00.000Z"),
            );
          },
        );
        await ctx.syncService!.pushChanged();
        const latestPath = join(
          repo.getDataNameDir(
            SERVER_TOKEN_MODEL_TYPE,
            definition.id,
            TOKEN_DATA_NAME,
          ),
          "latest",
        );
        const service = ctx.syncService!;
        const fetchContent = service.fetchContent!.bind(service);
        let fetches = 0;
        let movedMarker: number | undefined;
        const counted = new Proxy(service, {
          get(target, property, receiver) {
            if (property !== "fetchContent") {
              const value = Reflect.get(target, property, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            }
            return (rel: string, options?: DatastoreSyncOptions) => {
              fetches++;
              if (rel.endsWith("/latest") && movedMarker !== undefined) {
                const version = movedMarker;
                movedMarker = undefined;
                return Promise.resolve(
                  new TextEncoder().encode(`${version}\n`),
                );
              }
              return fetchContent(rel, options);
            };
          },
        });
        await fn({
          ctx: { ...ctx, syncService: counted },
          latestPath,
          fetches: () => fetches,
          moveMarkerOnNextRead: (version) => movedMarker = version,
        });
      } finally {
        ctx.repoContext.catalogStore.close();
      }
    });
  } finally {
    dispose();
  }
}

function refreshOf(
  f: Fixture,
  options:
    & { gate?: <T>(fn: () => Promise<T>) => Promise<T> }
    & Parameters<
      typeof serverTokenRecordRefreshOver
    >[4] = {},
) {
  const refresh = serverTokenRecordRefreshOver(
    f.ctx.datastoreConfig,
    f.ctx.syncService,
    f.ctx.repoContext,
    options.gate,
    options,
  );
  assert(refresh !== undefined, "an extension datastore can refresh");
  return refresh;
}

Deno.test("serverTokenRecordRefreshOver: concurrent refreshes for one token and secret share one fetch", async () => {
  await withPublishedRecord(async (f) => {
    const refresh = refreshOf(f);
    const results = await Promise.all([
      refresh(NAME, "secret-of-another-mint"),
      refresh(NAME, "secret-of-another-mint"),
      refresh(NAME, "secret-of-another-mint"),
    ]);
    assertEquals(results, [false, false, false]);
    // the marker, then the record and its metadata, once
    assertEquals(f.fetches(), 3);
  });
});

Deno.test("serverTokenRecordRefreshOver: a refusal is reused within the retry window and fetched again after it", async () => {
  await withPublishedRecord(async (f) => {
    let clock = 1_000_000;
    const refresh = refreshOf(f, { retryAfterMs: 30_000, now: () => clock });
    assertEquals(await refresh(NAME, "secret-of-another-mint"), false);
    const afterFirst = f.fetches();
    assertEquals(await refresh(NAME, "secret-of-another-mint"), false);
    assertEquals(f.fetches(), afterFirst, "no fetch inside the window");
    clock += 30_000;
    assertEquals(await refresh(NAME, "secret-of-another-mint"), false);
    assertEquals(f.fetches() > afterFirst, true, "fetched again after it");
  });
});

Deno.test("serverTokenRecordRefreshOver: a marker that moved before the gate stops the adoption, and the next attempt reads again", async () => {
  await withPublishedRecord(async (f) => {
    const refresh = refreshOf(f, {
      // a peer publishes version 2 while this one waits for the gate
      gate: (fn) => {
        f.moveMarkerOnNextRead(2);
        return fn();
      },
    });
    const before = await Deno.readFile(f.latestPath).catch(() => null);
    assertEquals(await refresh(NAME, "secret-of-mint-a"), false);
    assertEquals(await Deno.readFile(f.latestPath).catch(() => null), before);
    const fetched = f.fetches();
    await refresh(NAME, "secret-of-mint-a");
    assertEquals(
      f.fetches() > fetched,
      true,
      "a moved marker is not a refusal",
    );
  });
});
