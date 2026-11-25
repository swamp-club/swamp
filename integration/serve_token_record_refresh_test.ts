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

        const refresh = serverTokenRecordRefreshOver(
          ctx.datastoreConfig,
          ctx.syncService,
          ctx.repoContext,
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
        assertEquals(
          (await readServerTokenRecord(ctx.repoContext, NAME)).createdAt,
          "2026-11-25T10:00:01.000Z",
        );

        assertEquals(await refresh(NAME, "secret-of-mint-a"), true);
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
