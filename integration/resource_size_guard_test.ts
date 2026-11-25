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

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { z } from "zod";
import { RunSensitiveValues } from "../src/domain/secrets/mod.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";
import { ExpressionEvaluationService } from "../src/domain/expressions/expression_evaluation_service.ts";
import {
  InvalidExpressionError,
  MissingModelDataError,
  UnboundExpressionError,
} from "../src/domain/expressions/errors.ts";
import {
  createResourceWriter,
  repoResourceSizePolicy,
} from "../src/domain/models/data_writer.ts";
import type { ResourceOutputSpec } from "../src/domain/models/model.ts";
import {
  createDataRepositoryAttributeReader,
  liveStepOutputs,
  StepOutputResolver,
} from "../src/domain/workflows/step_output_resolver.ts";
import type { StepRun } from "../src/domain/workflows/workflow_run.ts";
import { fromResourceHandle } from "../src/domain/data/data_record_mapper.ts";
import type { DataHandle } from "../src/domain/models/model.ts";
import { attachStepOutputSources } from "../src/domain/expressions/step_output_sources.ts";
import { CelEvaluator } from "../src/infrastructure/cel/cel_evaluator.ts";
import {
  ResourceLoadGuard,
  ResourceTooLargeToLoadError,
} from "../src/domain/data/resource_load_guard.ts";
import { ResourceTooLargeError } from "../src/domain/data/resource_size_policy.ts";
import { parseQuerySort } from "../src/domain/data/query_sort.ts";

const type = ModelType.create("repro/bigdata");

const resources: Record<string, ResourceOutputSpec> = {
  blob: {
    schema: z.object({ items: z.array(z.string()) }),
    lifetime: "infinite",
    garbageCollection: 5,
  },
};

interface Fixture {
  repoDir: string;
  dataRepo: FileSystemUnifiedDataRepository;
  catalog: CatalogStore;
  definitionRepo: YamlDefinitionRepository;
  big: Definition;
  write: (name: string, bytes: number) => Promise<unknown>;
  /** empty strings: few bytes each, a slot each once parsed */
  writeDense: (name: string, items: number) => Promise<unknown>;
}

// a heap of 1000 bytes refuses any item past a third of it
async function withFixture(
  fn: (f: Fixture) => Promise<void>,
  loadGuard = new ResourceLoadGuard({
    heapLimitBytes: () => 1000,
    heapUsedBytes: () => 0,
  }, 50),
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-resource-size-" });
  const catalog = new CatalogStore(join(repoDir, "_catalog.db"));
  try {
    await ensureDir(join(repoDir, ".swamp", "data"));
    await ensureDir(join(repoDir, "models"));
    await Deno.writeTextFile(
      join(repoDir, ".swamp.yaml"),
      `swampVersion: "1.2.3"
initializedAt: "2024-01-15T10:30:00.000Z"
resourceSize:
  warnBytes: 100
  maxBytes: 2000
`,
    );
    const dataRepo = new FileSystemUnifiedDataRepository(
      repoDir,
      undefined,
      catalog,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      false,
      {},
      loadGuard,
    );
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const big = Definition.create({ name: "big", globalArguments: {} });
    await definitionRepo.save(type, big);
    const { writeResource } = createResourceWriter(
      dataRepo,
      type,
      big.id,
      resources,
      undefined,
      undefined,
      undefined,
      undefined,
      "big",
      undefined,
      "write",
      undefined,
      undefined,
      false,
      Deno.build.os,
      undefined,
      undefined,
      repoResourceSizePolicy(dataRepo),
    );
    const write = (name: string, bytes: number) =>
      writeResource("blob", name, { items: ["x".repeat(bytes)] });
    const writeDense = (name: string, items: number) =>
      writeResource("blob", name, { items: Array(items).fill("") });
    await fn({
      repoDir,
      dataRepo,
      catalog,
      definitionRepo,
      big,
      write,
      writeDense,
    });
  } finally {
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

Deno.test("resource size: a write past the repo's resourceSize.maxBytes is refused and nothing is stored", async () => {
  await withFixture(async (f) => {
    const error = await assertRejects(
      () => f.write("huge", 3000),
      ResourceTooLargeError,
    );
    assertStringIncludes(
      error.message,
      "resource blob/huge written by big.write",
    );
    assertEquals(await f.dataRepo.findByName(type, f.big.id, "huge"), null);
  });
});

Deno.test("resource size: a CEL reference to an oversized resource fails with its name and size, never as data not produced yet", async () => {
  await withFixture(async (f) => {
    await f.write("blob-0", 400);
    await f.write("blob-1", 400);
    const reader = Definition.create({
      name: "reader",
      globalArguments: {
        n: '${{ size(model.big.resource.blob["blob-0"].attributes.items) }}',
      },
    });
    await f.definitionRepo.save(type, reader);
    const evalService = new ExpressionEvaluationService(
      f.definitionRepo,
      f.repoDir,
      { dataRepo: f.dataRepo },
    );

    const error = await assertRejects(() =>
      evalService.evaluateDefinition(reader, type, new RunSensitiveValues())
    );
    assertInstanceOf(error, Error);
    assertStringIncludes(error.message, "Cannot load big/blob-");
    assert(!(error instanceof UnboundExpressionError));
    assert(!(error instanceof MissingModelDataError));
  });
});

Deno.test("resource size: data query refuses to hydrate oversized matches, while a size-only select sorted by size lists them", async () => {
  await withFixture(async (f) => {
    await f.write("blob-0", 400);
    await f.write("blob-1", 600);
    await f.write("small", 10);
    const dqs = new DataQueryService(f.catalog, f.dataRepo);

    const error = await assertRejects(
      () => dqs.query('modelName == "big" && specName == "blob"'),
      ResourceTooLargeToLoadError,
    );
    assertStringIncludes(error.message, "--sort size:desc");

    const listed = await dqs.query('modelName == "big" && specName == "blob"', {
      select: "name",
      sort: parseQuerySort("size:desc"),
    });
    assertEquals(listed, ["blob-1", "blob-0", "small"]);
  });
});

Deno.test("resource size: a workflow step output read refuses an oversized resource on its byte length", async () => {
  await withFixture(async (f) => {
    const handle = await f.write("blob-0", 400) as {
      dataId: string;
      name: string;
      version: number;
    };
    const read = createDataRepositoryAttributeReader(f.dataRepo);
    await assertRejects(
      () =>
        read({
          dataId: handle.dataId,
          modelType: type.normalized,
          modelId: f.big.id,
          modelName: "big",
          specName: "blob",
          contentType: "application/json",
          name: handle.name,
          version: handle.version,
          tags: {},
        }),
      ResourceTooLargeToLoadError,
      "big/blob-0@v1",
    );
  });
});

Deno.test("resource size: a refusal for a row the caller may not read is dropped, never named, in hydration and in the predicate", async () => {
  await withFixture(async (f) => {
    await f.write("secret", 400);
    await f.write("small", 10);
    const dqs = new DataQueryService(f.catalog, f.dataRepo);
    const hidesSecret = (record: { name: string }) =>
      Promise.resolve(record.name !== "secret");

    assertEquals(
      await dqs.query('modelName == "big"', { include: hidesSecret }).then((
        records,
      ) => (records as { name: string }[]).map((r) => r.name)),
      ["small"],
    );
    assertEquals(
      await dqs.query(
        'modelName == "big" && attributes.items.size() > 0',
        { include: hidesSecret, select: "name" },
      ),
      ["small"],
    );

    await assertRejects(
      () =>
        dqs.query('modelName == "big"', {
          include: () => Promise.resolve(true),
        }),
      ResourceTooLargeToLoadError,
      "big/secret@v1",
    );
    await assertRejects(
      () =>
        dqs.query('modelName == "big" && attributes.items.size() > 0', {
          include: () => Promise.resolve(true),
        }),
      ResourceTooLargeToLoadError,
      "big/secret@v1",
    );
  });
});

Deno.test("resource size: a step that wrote a resource past the text-length limit keeps a marker, and reading its outputs or its model resource fails by name, live and on resume", async () => {
  await withFixture(
    async (f) => {
      const evaluator = new CelEvaluator();
      const message =
        "Cannot load big/blob-0@v1: it is 314 bytes, more than swamp can load as text";
      const big = await f.write("blob-0", 300) as DataHandle;
      const small = await f.write("small", 10) as DataHandle;
      const bigRecord = await fromResourceHandle(
        big,
        type,
        f.big.id,
        "big",
        f.dataRepo,
      );
      const smallRecord = await fromResourceHandle(
        small,
        type,
        f.big.id,
        "big",
        f.dataRepo,
      );
      assertEquals(bigRecord.tooLargeToLoad, {
        bytes: 314,
        reason: "text-length",
      });
      assertEquals(smallRecord.attributes, { items: ["x".repeat(10)] });
      const output = {
        type: "model_method",
        resources: { blob: { "blob-0": bigRecord, small: smallRecord } },
      };

      const live = liveStepOutputs(output, f.dataRepo.namespace);
      const liveContext = {
        steps: {
          write: attachStepOutputSources(
            { status: "succeeded", outputs: live.outputs },
            live.sources,
          ),
        },
      };
      assertThrows(
        () => evaluator.evaluate("steps.write.outputs.items", liveContext),
        InvalidExpressionError,
        message,
      );

      const modelContext = {
        model: { big: { resource: { blob: { "blob-0": bigRecord } } } },
      };
      assertThrows(
        () =>
          evaluator.evaluate(
            'model.big.resource.blob["blob-0"].attributes.items',
            modelContext,
          ),
        InvalidExpressionError,
        message,
      );

      // without the marker too, so the resumed read must find it from storage
      const stripped = JSON.parse(JSON.stringify(output));
      for (const record of Object.values(stripped.resources.blob)) {
        const r = record as Record<string, unknown>;
        r.attributes = null;
        r.content = null;
        delete r.tooLargeToLoad;
      }
      const resolver = new StepOutputResolver({
        readAttributes: createDataRepositoryAttributeReader(f.dataRepo),
        namespace: f.dataRepo.namespace,
      });
      const resumed = await resolver.resolve(
        { output: stripped } as unknown as StepRun,
      );
      assertEquals(resumed.outputs, { items: ["x".repeat(10)] });
      const resumedContext = {
        steps: {
          write: attachStepOutputSources(
            { status: "succeeded", outputs: resumed.outputs },
            resumed.sources,
          ),
        },
      };
      await assertRejects(
        () =>
          evaluator.evaluateAsync("steps.write.outputs.items", resumedContext),
        InvalidExpressionError,
        message,
      );
    },
    new ResourceLoadGuard(
      {
        heapLimitBytes: () => 1_000_000,
        heapUsedBytes: () => 0,
      },
      50,
      200,
    ),
  );
});

// about 300 bytes each: three times that fits the 1000-byte heap, the dense
// one's parsed slots do not
const DENSE_ITEMS = 100;
const SPARSE_BYTES = 290;

Deno.test("resource size: a dense resource the byte factor would load is refused on its parsed structure, a sparse one of its size loads", async () => {
  await withFixture(async (f) => {
    await f.writeDense("dense", DENSE_ITEMS);
    await f.write("sparse", SPARSE_BYTES);
    const sizes = await new DataQueryService(f.catalog, f.dataRepo).query(
      'modelName == "big" && specName == "blob"',
      { select: "size", sort: parseQuerySort("size:desc") },
    ) as number[];
    for (const size of sizes) {
      assert(size * 3 <= 1000, `size ${size} must pass the byte factor`);
    }
    const dqs = new DataQueryService(f.catalog, f.dataRepo);

    await assertRejects(
      () =>
        dqs.query('modelName == "big" && name == "dense"', {
          select: "content",
        }),
      ResourceTooLargeToLoadError,
      "big/dense",
    );
    const sparse = await dqs.query('modelName == "big" && name == "sparse"', {
      select: "content",
    }) as { items: string[] }[];
    assertEquals(sparse[0].items[0].length, SPARSE_BYTES);
  });
});

Deno.test("resource size: a CEL reference to a dense resource fails on its parsed structure", async () => {
  await withFixture(async (f) => {
    await f.writeDense("dense", DENSE_ITEMS);
    const reader = Definition.create({
      name: "reader",
      globalArguments: {
        n: '${{ size(model.big.resource.blob["dense"].attributes.items) }}',
      },
    });
    await f.definitionRepo.save(type, reader);
    const evalService = new ExpressionEvaluationService(
      f.definitionRepo,
      f.repoDir,
      { dataRepo: f.dataRepo },
    );
    const error = await assertRejects(() =>
      evalService.evaluateDefinition(reader, type, new RunSensitiveValues())
    );
    assertInstanceOf(error, Error);
    assertStringIncludes(error.message, "Cannot load big/dense");
  });
});

Deno.test("resource size: a workflow step output read refuses a dense resource on its parsed structure", async () => {
  await withFixture(async (f) => {
    const handle = await f.writeDense("dense", DENSE_ITEMS) as {
      dataId: string;
      name: string;
      version: number;
    };
    const read = createDataRepositoryAttributeReader(f.dataRepo);
    await assertRejects(
      () =>
        read({
          dataId: handle.dataId,
          modelType: type.normalized,
          modelId: f.big.id,
          modelName: "big",
          specName: "blob",
          contentType: "application/json",
          name: handle.name,
          version: handle.version,
          tags: {},
        }),
      ResourceTooLargeToLoadError,
      "big/dense@v1",
    );
  });
});
