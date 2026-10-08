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

/**
 * Reads of lazily hydrated data on another host's model (swamp-club#3179)
 * and of content a metadata-only pull left stale (swamp-club#3178), through
 * every reader: the model map, `file.contents`, `data.latest`,
 * `data.version`, `data query`, `getContent`, `stream`, and the workflow
 * evaluate path that saves its values.
 *
 * Wired by hand, as `data_query_get_parity_test.ts` is, because the
 * in-memory remote models neither `hydrateFile` nor metadata-only pulls: a
 * writer repository holds the data, a lazy pull copies everything but `raw`
 * into a reader, and the reader's hook copies `raw` from the writer when
 * first read.
 */

import "../src/domain/models/models.ts";
import { assertEquals } from "@std/assert";
import { dirname, join, relative } from "@std/path";
import { copy, ensureDir, exists, walk } from "@std/fs";
import { parse as parseYaml } from "@std/yaml";
import { Data } from "../src/domain/data/data.ts";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelResolver } from "../src/domain/expressions/model_resolver.ts";
import { resolveAvailableExpressions } from "../src/domain/expressions/available_expression_resolver.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { RunSensitiveValues } from "../src/domain/secrets/mod.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import {
  CelEvaluator,
  prepareExpressionsIn,
} from "../src/infrastructure/cel/cel_evaluator.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { YamlWorkflowRepository } from "../src/infrastructure/persistence/yaml_workflow_repository.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { collect } from "../src/libswamp/testing.ts";
import {
  createWorkflowEvaluateDeps,
  workflowEvaluate,
  type WorkflowEvaluateEvent,
} from "../src/libswamp/workflows/evaluate.ts";

await initializeLogging({});

const modelType = ModelType.create("test/lazy-read-paths");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const owner = { ownerType: "manual" as const, ownerRef: "test-user" };

function item(
  name: string,
  kind: "resource" | "file",
  specName: string,
  contentType: string,
  streaming = false,
): Data {
  return Data.create({
    name,
    contentType,
    lifetime: "infinite",
    garbageCollection: 100,
    tags: { type: kind, specName, modelName: "vpc" },
    ownerDefinition: owner,
    streaming,
  });
}

/**
 * Copies the writer's data tree into the reader without `raw` files, as a
 * lazy pull does. A `raw` already in the reader is left as it is, as the
 * S3 and GCS datastores skip every lazily skippable file.
 */
async function lazyPull(writerData: string, readerData: string): Promise<void> {
  for await (const entry of walk(writerData, { includeDirs: false })) {
    const rel = relative(writerData, entry.path);
    await ensureDir(dirname(join(readerData, rel)));
    if (entry.name === "raw" || entry.name.startsWith("_catalog.db")) continue;
    await copy(entry.path, join(readerData, rel), { overwrite: true });
  }
}

interface Hosts {
  writer: FileSystemUnifiedDataRepository;
  readerDir: string;
  reader: FileSystemUnifiedDataRepository;
  readerCatalog: CatalogStore;
  queryService: DataQueryService;
  resolver: ModelResolver;
  vpc: Definition;
  hydrated: string[];
  pull: () => Promise<void>;
  hook: (absPath: string) => Promise<boolean>;
}

async function withHosts(fn: (hosts: Hosts) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-lazy-read-paths-" });
  const writerDir = join(dir, "writer");
  const readerDir = join(dir, "reader");
  const writerCatalog = new CatalogStore(join(dir, "writer-catalog.db"));
  const readerCatalog = new CatalogStore(join(dir, "reader-catalog.db"));
  try {
    const writerData = join(writerDir, ".swamp", "data");
    const readerData = join(readerDir, ".swamp", "data");
    const vpc = Definition.create({ name: "vpc" });
    for (const repoDir of [writerDir, readerDir]) {
      await ensureDir(repoDir);
      await new YamlDefinitionRepository(repoDir).save(modelType, vpc);
    }
    const writer = new FileSystemUnifiedDataRepository(
      writerDir,
      undefined,
      writerCatalog,
    );
    const hydrated: string[] = [];
    const hook = async (absPath: string): Promise<boolean> => {
      const source = join(writerData, relative(readerData, absPath));
      try {
        await copy(source, absPath, { overwrite: true });
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
      }
      hydrated.push(relative(readerData, absPath));
      return true;
    };
    const reader = new FileSystemUnifiedDataRepository(
      readerDir,
      undefined,
      readerCatalog,
      undefined,
      hook,
    );
    // As repo_context wires a custom datastore.
    const queryService = new DataQueryService(readerCatalog, reader, {
      filterStaleRows: false,
    });
    const resolver = new ModelResolver(
      new YamlDefinitionRepository(readerDir),
      {
        repoDir: readerDir,
        dataRepo: reader,
        dataQueryService: queryService,
      },
    );
    await fn({
      writer,
      readerDir,
      reader,
      readerCatalog,
      queryService,
      resolver,
      vpc,
      hydrated,
      pull: async () => {
        await lazyPull(writerData, readerData);
        readerCatalog.invalidate();
      },
      hook,
    });
  } finally {
    writerCatalog.close();
    readerCatalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function writeVpc(hosts: Hosts): Promise<void> {
  await hosts.writer.save(
    modelType,
    hosts.vpc.id,
    item("main", "resource", "state", "application/json"),
    encoder.encode('{"vpcId":"vpc-0abc123"}'),
  );
  await hosts.writer.save(
    modelType,
    hosts.vpc.id,
    item("log", "file", "log", "text/plain"),
    encoder.encode("line1\n"),
  );
  await hosts.pull();
}

async function evaluate(
  hosts: Hosts,
  cel: string,
  light = false,
): Promise<unknown> {
  const sensitive = new RunSensitiveValues();
  const ctx = light
    ? hosts.resolver.buildLightContext(sensitive)
    : await hosts.resolver.buildContext(sensitive);
  return await new CelEvaluator().evaluateAsync(
    cel,
    ctx as unknown as Record<string, unknown>,
  );
}

Deno.test("lazy hydration: expressions read another host's data a metadata-only pull left out", async () => {
  await withHosts(async (hosts) => {
    await writeVpc(hosts);
    const raw = hosts.reader.getContentPath(modelType, hosts.vpc.id, "main", 1);
    assertEquals(await exists(raw), false);

    for (
      const cel of [
        "model.vpc.resource.state.main.attributes.vpcId",
        'model["vpc"].resource.state.main.attributes.vpcId',
        `model["${hosts.vpc.id}"].resource.state.main.attributes.vpcId`,
        'data.latest("vpc", "main").attributes.vpcId',
        'data.version("vpc", "main", 1).attributes.vpcId',
      ]
    ) {
      assertEquals(await evaluate(hosts, cel), "vpc-0abc123", cel);
    }
    assertEquals(
      await evaluate(
        hosts,
        'data.latest("vpc", "main").attributes.vpcId',
        true,
      ),
      "vpc-0abc123",
    );
    assertEquals(
      await evaluate(hosts, 'file.contents("vpc", "log")'),
      "line1\n",
    );
    assertEquals(await evaluate(hosts, "model.vpc.file.log.log.size"), 6);
  });
});

Deno.test("lazy hydration: the synchronous pass splices current values once prepared", async () => {
  await withHosts(async (hosts) => {
    await writeVpc(hosts);
    const ctx = await hosts.resolver.buildContext(new RunSensitiveValues());
    const context = ctx as unknown as Record<string, unknown>;
    const evaluator = new CelEvaluator();
    const raw = '${{ model["vpc"].resource.state.main.attributes.vpcId }}';
    const task = { inputs: { vpcId: raw, label: `id=${raw}` } };
    await prepareExpressionsIn(task, context);
    const resolved = resolveAvailableExpressions(
      task,
      context,
      (expr, c) => evaluator.evaluate(expr, c),
      new Set([raw]),
    ) as typeof task;
    assertEquals(resolved.inputs, {
      vpcId: "vpc-0abc123",
      label: "id=vpc-0abc123",
    });
  });
});

Deno.test("lazy hydration: workflow evaluate saves the current value, not an empty one", async () => {
  await withHosts(async (hosts) => {
    await writeVpc(hosts);
    const workflowRepo = new YamlWorkflowRepository(hosts.readerDir);
    const cel = 'model["vpc"].resource.state.main.attributes.vpcId';
    await workflowRepo.save(Workflow.fromData({
      id: crypto.randomUUID(),
      name: "reads-vpc",
      inputs: {},
      jobs: [{
        name: "default",
        steps: [{
          name: "step-1",
          task: {
            type: "model_method",
            modelIdOrName: "vpc",
            methodName: "get",
            inputs: { vpcId: `\${{ ${cel} }}` },
          },
        }],
      }],
    }));
    const deps = createWorkflowEvaluateDeps(
      hosts.readerDir,
      workflowRepo,
      undefined,
      undefined,
      hosts.hook,
    );
    const events = await collect<WorkflowEvaluateEvent>(
      workflowEvaluate(createLibSwampContext(), deps, {
        workflowIdOrName: "reads-vpc",
        inputs: {},
      }),
    );
    const completed = events.at(-1) as Extract<
      WorkflowEvaluateEvent,
      { kind: "completed" }
    >;
    const saved = parseYaml(
      await Deno.readTextFile(
        (completed.data as { outputPath: string }).outputPath,
      ),
    ) as { jobs: { steps: { task: { inputs: Record<string, unknown> } }[] }[] };
    assertEquals(saved.jobs[0].steps[0].task.inputs.vpcId, "vpc-0abc123");
  });
});

Deno.test("lazy hydration: content appended on another host is read in full after a metadata-only pull", async () => {
  await withHosts(async (hosts) => {
    await hosts.writer.save(
      modelType,
      hosts.vpc.id,
      item("events", "resource", "events", "text/plain", true),
      encoder.encode("line1\n"),
    );
    await hosts.pull();
    // The reader reads it once, so a local copy exists...
    assertEquals(
      decoder.decode(
        (await hosts.reader.getContent(modelType, hosts.vpc.id, "events"))!,
      ),
      "line1\n",
    );
    // ...then the writer appends and the next pull brings only metadata.
    await hosts.writer.append(
      modelType,
      hosts.vpc.id,
      "events",
      encoder.encode("line2\n"),
    );
    await hosts.pull();

    const full = "line1\nline2\n";
    const chunks: Uint8Array[] = [];
    for await (
      const chunk of hosts.reader.stream(modelType, hosts.vpc.id, "events")
    ) chunks.push(chunk);
    assertEquals(decoder.decode(concat(chunks)), full);

    // Each reader is checked against a fresh copy of the stale state.
    const stale = async () => {
      await Deno.writeFile(
        hosts.reader.getContentPath(modelType, hosts.vpc.id, "events", 1),
        encoder.encode("line1\n"),
      );
    };
    await stale();
    assertEquals(
      await hosts.queryService.query('name == "events"', { select: "content" }),
      [full],
    );
    await stale();
    // data.version() loads JSON attributes only; its path must name the
    // current file.
    const path = await evaluate(hosts, 'data.version("vpc", "events", 1).path');
    assertEquals(decoder.decode(await Deno.readFile(path as string)), full);
    await stale();
    assertEquals(
      await evaluate(hosts, 'data.latest("vpc", "events").content'),
      full,
    );
    await stale();
    assertEquals(
      decoder.decode(
        (await hosts.reader.getContent(modelType, hosts.vpc.id, "events"))!,
      ),
      full,
    );
  });
});

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
