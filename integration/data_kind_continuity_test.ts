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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import { InProcessExecutor } from "../src/domain/models/in_process_executor.ts";
import type { MethodExecutor } from "../src/domain/models/in_process_executor.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RECORD_KIND_TAG } from "../src/domain/data/data.ts";
import type {
  MethodContext,
  MethodDefinition,
  ModelDefinition,
} from "../src/domain/models/model.ts";
import type { DefinitionRepository } from "../src/domain/definitions/repositories.ts";
import type { UnifiedDataRepository } from "../src/domain/data/repositories.ts";
import { CompositeUnifiedDataRepository } from "../src/domain/data/composite_data_repository.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { InMemoryUnifiedDataRepository } from "../src/infrastructure/persistence/in_memory_data_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { createExtensionCelEnvironment } from "../src/infrastructure/cel/cel_evaluator.ts";

const MODEL_TYPE = ModelType.create("test/data-kind-continuity");

const modelDef: ModelDefinition = {
  type: MODEL_TYPE,
  version: "2026.01.01.1",
  resources: {
    meta: {
      description: "Resource",
      schema: z.object({ v: z.string() }),
      lifetime: "infinite",
      garbageCollection: 20,
    },
    scratch: {
      description: "Ephemeral resource",
      schema: z.object({ v: z.string() }),
      lifetime: "ephemeral",
      garbageCollection: 20,
    },
  },
  files: {
    blob: {
      description: "File",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {},
};

const executor: MethodExecutor = {
  execute: (_definition, method, context) => method.execute({}, context),
};

const writeFile: MethodDefinition["execute"] = async (_args, ctx) => ({
  dataHandles: [await ctx.createFileWriter!("blob", "x").writeText("body")],
});

const writeResource: MethodDefinition["execute"] = async (_args, ctx) => ({
  dataHandles: [await ctx.writeResource!("meta", "x", { v: "resource" })],
});

const writeEphemeralResource: MethodDefinition["execute"] = async (
  _args,
  ctx,
) => ({
  dataHandles: [await ctx.writeResource!("scratch", "x", { v: "scratch" })],
});

interface KindRepo {
  fsRepo: FileSystemUnifiedDataRepository;
  modelId: string;
  run: (
    execute: MethodDefinition["execute"],
    dataRepo?: UnifiedDataRepository,
  ) => Promise<{ status: string; error?: string }>;
  versions: () => Promise<number[]>;
  latestKind: () => Promise<string | undefined>;
}

/** each run is a separate method execution against one model's data */
async function withKindRepo(fn: (r: KindRepo) => Promise<void>) {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-kind-test-" });
  await Deno.mkdir(join(repoDir, ".swamp"), { recursive: true });
  const catalogStore = new CatalogStore(join(repoDir, ".swamp", "catalog.db"));
  try {
    const fsRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalogStore,
    );
    const definition = Definition.create({
      name: "kinds",
      methods: { test: { arguments: {} } },
    });
    const run = async (
      execute: MethodDefinition["execute"],
      dataRepo: UnifiedDataRepository = fsRepo,
    ) => {
      const method: MethodDefinition = {
        description: "Writes x",
        arguments: z.object({}),
        execute,
      };
      const context = {
        repoDir,
        modelType: MODEL_TYPE,
        modelId: definition.id,
        globalArgs: {},
        definition: {
          id: definition.id,
          name: "kinds",
          version: 1,
          tags: {},
        },
        methodName: "test",
        logger: getLogger(["test"]),
        dataRepository: dataRepo,
        definitionRepository: {} as DefinitionRepository,
        signal: new AbortController().signal,
        extensionFile: () => {
          throw new Error("extensionFile not stubbed");
        },
        createCelEnvironment: createExtensionCelEnvironment,
      } as MethodContext;
      const result = await new InProcessExecutor(
        executor,
        definition,
        method,
        modelDef,
        context,
        "test",
      ).execute({
        protocolVersion: 1,
        modelType: MODEL_TYPE.normalized,
        modelId: definition.id,
        methodName: "test",
        globalArgs: {},
        methodArgs: {},
        definitionMeta: {
          id: definition.id,
          name: "kinds",
          version: 1,
          tags: {},
        },
      });
      return result.status === "error"
        ? { status: result.status, error: result.error }
        : { status: result.status };
    };
    await fn({
      fsRepo,
      modelId: definition.id,
      run,
      versions: () => fsRepo.listVersions(MODEL_TYPE, definition.id, "x"),
      latestKind: async () =>
        (await fsRepo.findByName(MODEL_TYPE, definition.id, "x"))
          ?.tags[RECORD_KIND_TAG],
    });
  } finally {
    catalogStore.close();
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
}

Deno.test("data kind: a resource written over a name an earlier run wrote as a file is refused, and the file stays the only version", async () => {
  await withKindRepo(async (r) => {
    assertEquals((await r.run(writeFile)).status, "success");

    const second = await r.run(writeResource);

    assertEquals(second.status, "error");
    assertEquals(
      second.error,
      "Duplicate data instance name 'x' (version 1 was written as file 'blob'; delete it with swamp data delete kinds x before writing it as a resource)",
    );
    assertEquals(await r.versions(), [1]);
    assertEquals(await r.latestKind(), "file");
  });
});

Deno.test("data kind: a file written over a name an earlier run wrote as a resource is refused, and the resource stays the only version", async () => {
  await withKindRepo(async (r) => {
    assertEquals((await r.run(writeResource)).status, "success");

    const second = await r.run(writeFile);

    assertEquals(second.status, "error");
    assertEquals(
      second.error?.startsWith(
        "Duplicate data instance name 'x' (version 1 was written as resource 'meta'",
      ),
      true,
    );
    assertEquals(await r.versions(), [1]);
    assertEquals(await r.latestKind(), "resource");
  });
});

Deno.test("data kind: repeated runs of one kind keep adding versions", async () => {
  await withKindRepo(async (r) => {
    assertEquals((await r.run(writeResource)).status, "success");
    assertEquals((await r.run(writeResource)).status, "success");
    assertEquals(await r.versions(), [1, 2]);
  });
});

Deno.test("data kind: after the name is deleted a later run may write it as the other kind", async () => {
  await withKindRepo(async (r) => {
    assertEquals((await r.run(writeFile)).status, "success");
    await r.fsRepo.delete(MODEL_TYPE, r.modelId, "x");

    assertEquals((await r.run(writeResource)).status, "success");
    assertEquals(await r.latestKind(), "resource");
  });
});

Deno.test("data kind: within one workflow run an ephemeral write under a name persisted as a file is refused", async () => {
  await withKindRepo(async (r) => {
    using ephemeral = disposableEphemeral();
    const composite = new CompositeUnifiedDataRepository(
      r.fsRepo,
      ephemeral.repo,
    );
    assertEquals((await r.run(writeFile, composite)).status, "success");

    const second = await r.run(writeEphemeralResource, composite);

    assertEquals(second.status, "error");
    assertEquals(
      second.error?.startsWith(
        "Duplicate data instance name 'x' (version 1 was written as file 'blob'",
      ),
      true,
    );
    assertEquals(await r.latestKind(), "file");
  });
});

function disposableEphemeral() {
  const catalog = new CatalogStore(":memory:");
  const repo = new InMemoryUnifiedDataRepository(catalog);
  return {
    repo,
    [Symbol.dispose]() {
      repo.dispose();
      catalog.close();
    },
  };
}
