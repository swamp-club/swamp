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
import { createWorkerModelRunDeps } from "./run_deps.ts";
import { createRepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import { Definition } from "../../domain/definitions/definition.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import "../../domain/models/models.ts";

Deno.test("createWorkerModelRunDeps: createAndSaveDefinition calls markDirty hook", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "swamp-run-deps-test-" });
  try {
    const dirtyPaths: string[] = [];
    const ctx = createRepositoryContext({
      repoDir: dir,
      enableIndexing: false,
      markDirty: (relPath?: string) => {
        if (relPath) dirtyPaths.push(relPath);
        return Promise.resolve();
      },
    });

    const deps = await createWorkerModelRunDeps(dir, ctx);
    const definition = Definition.create({
      name: "test-token",
      type: "swamp/enrollment-token",
      typeVersion: "2026.07.04.1",
    });
    await deps.createAndSaveDefinition!(
      ModelType.create("swamp/enrollment-token"),
      definition,
    );

    assert(
      dirtyPaths.length > 0,
      "markDirty must be called when saving an auto-definition",
    );
    ctx.catalogStore.close();
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

/** A definition file written straight into a directory. */
async function writeDefinition(
  dir: string,
  type: string,
  name: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await Deno.mkdir(join(dir, ...type.split("/")), { recursive: true });
  await Deno.writeTextFile(
    join(dir, ...type.split("/"), `${name}.yaml`),
    `type: ${type}\ntypeVersion: 2026.01.01.1\nid: ${id}\nname: ${name}\nversion: 1\ntags: {}\nglobalArguments: {}\nmethods: {}\n`,
  );
  return id;
}

async function withLookupRepo(
  fn: (
    dir: string,
    ctx: ReturnType<typeof createRepositoryContext>,
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-run-deps-lookup-" });
  const ctx = createRepositoryContext({ repoDir: dir, enableIndexing: false });
  try {
    await fn(dir, ctx);
  } finally {
    ctx.catalogStore.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const WORKER_TYPE = ModelType.create("swamp/worker");

Deno.test("createWorkerModelRunDeps: with definitionType, finds an auto-definition of that type without a global name search (swamp-club#3405)", async () => {
  await withLookupRepo(async (dir, ctx) => {
    const id = await writeDefinition(
      ctx.autoDefinitionsDir,
      "swamp/worker",
      "worker-a",
    );
    // A same-name definition of another type in models/ is not a match.
    await writeDefinition(join(dir, "models"), "command/shell", "worker-a");
    ctx.definitionRepo.findByNameGlobal = () => {
      throw new Error("global name search");
    };

    const deps = await createWorkerModelRunDeps(dir, ctx, {
      definitionType: WORKER_TYPE,
    });
    const found = await deps.lookupDefinition("worker-a");
    assertEquals(found?.definition.id, id);
    assertEquals(found?.type.normalized, WORKER_TYPE.normalized);
  });
});

Deno.test("createWorkerModelRunDeps: with definitionType, a models/ definition of that type wins over the auto-definition (swamp-club#3405)", async () => {
  await withLookupRepo(async (dir, ctx) => {
    await writeDefinition(ctx.autoDefinitionsDir, "swamp/worker", "worker-b");
    const primaryId = await writeDefinition(
      join(dir, "models"),
      "swamp/worker",
      "worker-b",
    );

    const deps = await createWorkerModelRunDeps(dir, ctx, {
      definitionType: WORKER_TYPE,
    });
    assertEquals(
      (await deps.lookupDefinition("worker-b"))?.definition.id,
      primaryId,
    );
    assertEquals(await deps.lookupDefinition("worker-missing"), null);
  });
});

Deno.test("createWorkerModelRunDeps: without definitionType, looks up by name across types", async () => {
  await withLookupRepo(async (dir, ctx) => {
    const id = await writeDefinition(
      join(dir, "models"),
      "command/shell",
      "shared-name",
    );
    const deps = await createWorkerModelRunDeps(dir, ctx);
    assertEquals(
      (await deps.lookupDefinition("shared-name"))?.definition.id,
      id,
    );
  });
});
