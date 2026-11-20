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
import { join } from "@std/path";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { Data } from "../src/domain/data/data.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { requireInitializedRepoUnlocked } from "../src/cli/repo_context.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { collect } from "../src/libswamp/testing.ts";
import { createDataGetDeps, dataGet } from "../src/libswamp/data/get.ts";
import {
  createDataVersionsDeps,
  dataVersions,
} from "../src/libswamp/data/versions.ts";
import { createDataListDeps, dataList } from "../src/libswamp/data/list.ts";

await initializeLogging({});

const TYPE = ModelType.create("command/shell");

async function withRepo(
  fn: (repoDir: string, repoContext: RepositoryContext) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-orphaned-owner-" });
  try {
    await Deno.writeTextFile(
      join(dir, ".swamp.yaml"),
      "swampVersion: 0.0.0\ninitializedAt: 2026-01-01T00:00:00.000Z\n",
    );
    const { repoDir, repoContext } = await requireInitializedRepoUnlocked({
      repoDir: dir,
      outputMode: "log",
    });
    await fn(repoDir, repoContext);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function orphanedRun(
  repoContext: RepositoryContext,
  name: string,
  output: string,
): Promise<string> {
  const definition = Definition.create({ name, globalArguments: {} });
  await repoContext.definitionRepo.save(TYPE, definition);
  await repoContext.unifiedDataRepo.save(
    TYPE,
    definition.id,
    Data.create({
      name: "result",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 10,
      tags: { type: "resource", modelName: name },
      ownerDefinition: {
        ownerType: "model-method",
        ownerRef: `${TYPE.normalized}:${definition.id}`,
      },
    }),
    new TextEncoder().encode(JSON.stringify({ stdout: output })),
  );
  await repoContext.definitionRepo.delete(TYPE, definition.id);
  return definition.id;
}

function cliDeps(repoDir: string, repoContext: RepositoryContext) {
  return {
    get: createDataGetDeps(
      repoDir,
      undefined,
      repoContext.unifiedDataRepo,
      repoContext.workflowRepo,
      undefined,
      repoContext.catalogStore,
    ),
    versions: createDataVersionsDeps(
      repoDir,
      undefined,
      repoContext.unifiedDataRepo,
      repoContext.definitionRepo,
      repoContext.catalogStore,
    ),
    list: createDataListDeps(
      repoDir,
      undefined,
      repoContext.unifiedDataRepo,
      undefined,
      repoContext.workflowRepo,
      undefined,
      repoContext.catalogStore,
    ),
  };
}

Deno.test("orphaned owner: data get, versions and list read data whose definition was deleted", async () => {
  await withRepo(async (repoDir, repoContext) => {
    const name = `echo-orphan-${crypto.randomUUID()}`;
    const modelId = await orphanedRun(repoContext, name, "hi");
    assertEquals(await repoContext.definitionRepo.findByName(TYPE, name), null);
    const deps = cliDeps(repoDir, repoContext);
    const ctx = createLibSwampContext();

    const got = (await collect(dataGet(ctx, deps.get, {
      modelIdOrName: name,
      dataName: "result",
      includeContent: true,
      repoDir,
    }))).at(-1)!;
    assert(got.kind === "completed", JSON.stringify(got));
    assertEquals([got.data.modelId, got.data.modelName], [modelId, name]);
    assert(got.data.content?.includes("hi"));

    const versions = (await collect(dataVersions(ctx, deps.versions, {
      modelIdOrName: name,
      dataName: "result",
    }))).at(-1)!;
    assert(versions.kind === "completed", JSON.stringify(versions));
    assertEquals([versions.data.modelId, versions.data.total], [modelId, 1]);

    const listed = (await collect(dataList(ctx, deps.list, {
      modelIdOrName: name,
    }))).at(-1)!;
    assert(listed.kind === "completed", JSON.stringify(listed));
    assertEquals("modelId" in listed.data && listed.data.modelId, modelId);
  });
});

Deno.test("orphaned owner: a name recorded under two owners is refused, and each id reads its own data", async () => {
  await withRepo(async (repoDir, repoContext) => {
    const name = `echo-orphan-${crypto.randomUUID()}`;
    const first = await orphanedRun(repoContext, name, "first");
    const second = await orphanedRun(repoContext, name, "second");
    const deps = cliDeps(repoDir, repoContext);
    const ctx = createLibSwampContext();
    const read = async (modelIdOrName: string) =>
      (await collect(dataGet(ctx, deps.get, {
        modelIdOrName,
        dataName: "result",
        includeContent: true,
        repoDir,
      }))).at(-1)!;

    const ambiguous = await read(name);
    assert(ambiguous.kind === "error", JSON.stringify(ambiguous));
    assertEquals(ambiguous.error.code, "validation_failed");
    assert(ambiguous.error.message.includes(first));
    assert(ambiguous.error.message.includes(second));

    for (const [id, output] of [[first, "first"], [second, "second"]]) {
      const got = await read(id);
      assert(got.kind === "completed", JSON.stringify(got));
      assert(got.data.content?.includes(output), got.data.content);
    }
  });
});

Deno.test("orphaned owner: a name with no definition and no data is still behavior not found", async () => {
  await withRepo(async (repoDir, repoContext) => {
    const got = (await collect(
      dataGet(createLibSwampContext(), cliDeps(repoDir, repoContext).get, {
        modelIdOrName: "nonexistent",
        dataName: "result",
        includeContent: false,
        repoDir,
      }),
    )).at(-1)!;
    assert(got.kind === "error", JSON.stringify(got));
    assertEquals(got.error.message, "Behavior not found: nonexistent");
  });
});
