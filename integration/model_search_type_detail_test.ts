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
import { assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { z } from "zod";
import { createModelSearchFetchers } from "../src/cli/commands/model_search.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import {
  PhaseTally,
  withDiagnosticTally,
} from "../src/domain/diagnostics/diagnostic_phase.ts";
import {
  type ModelDefinition,
  modelRegistry,
} from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import {
  createModelGetDeps,
  modelGet,
  type ModelGetData,
} from "../src/libswamp/models/get.ts";
import { modelSearch } from "../src/libswamp/models/search.ts";
import { consumeStream } from "../src/libswamp/stream.ts";
import {
  createModelSearchRenderer,
  type ModelSearchFetchers,
} from "../src/presentation/renderers/model_search.tsx";
import { initializeTestRepo } from "./test_helpers.ts";

await initializeLogging({});

const SECRET = "SUPERSECRET123";

interface SearchResult {
  id: string;
  name: string;
  type: string;
  methods?: unknown;
  globalArgumentsSchema?: unknown;
}

async function withRepo(
  fn: (repoDir: string, repo: YamlDefinitionRepository) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-search-type-detail-" });
  try {
    await initializeTestRepo(dir);
    await fn(dir, new YamlDefinitionRepository(dir));
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

// each type gets a method named after its tag, so a result shows whose
// methods it carries
async function withRegisteredTypes(
  tags: string[],
  fn: (types: ModelType[]) => Promise<void>,
): Promise<void> {
  const run = crypto.randomUUID().slice(0, 8);
  const types = tags.map((tag) =>
    ModelType.create(`@test-search-detail/${tag}-${run}`)
  );
  for (const [i, type] of types.entries()) {
    const def: ModelDefinition = {
      type,
      version: "2026.01.01.1",
      globalArguments: z.object({
        apiKey: z.string().meta({ sensitive: true }),
        region: z.string(),
        [`only_${tags[i]}`]: z.number().optional(),
      }),
      methods: {
        [`run_${tags[i]}`]: {
          description: `runs ${tags[i]}`,
          arguments: z.object({ message: z.string() }),
          execute: () => Promise.resolve({}),
        },
      },
    };
    modelRegistry.register(def);
  }
  try {
    await fn(types);
  } finally {
    for (const type of types) modelRegistry.invalidateType(type);
  }
}

async function searchJson(
  repo: YamlDefinitionRepository,
  fetchers?: ModelSearchFetchers,
): Promise<SearchResult[]> {
  const renderer = createModelSearchRenderer(
    "json",
    fetchers ?? await createModelSearchFetchers(repo, "behavior"),
    "behavior",
  );
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(String(args[0]));
  try {
    await consumeStream(
      modelSearch(
        createLibSwampContext(),
        { findAllGlobal: () => repo.findAllGlobal() },
        { query: "" },
      ),
      renderer.handlers(),
    );
  } finally {
    console.log = originalLog;
  }
  return JSON.parse(logs[0]).results;
}

async function getModel(
  repo: YamlDefinitionRepository,
  idOrName: string,
): Promise<ModelGetData> {
  let data: ModelGetData | undefined;
  await consumeStream(
    modelGet(createLibSwampContext(), await createModelGetDeps(repo), idOrName),
    {
      resolving: () => {},
      completed: (e) => {
        data = e.data;
      },
      error: (e) => {
        throw new Error(e.error.message);
      },
    },
  );
  return data!;
}

async function saveDefinitions(
  repo: YamlDefinitionRepository,
  type: ModelType,
  prefix: string,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await repo.save(
      type,
      Definition.create({
        name: `${prefix}-${i}`,
        type: type.normalized,
        globalArguments: { region: "us-east-1" },
      }),
    );
  }
}

// save refuses what these hold (a taken name, a literal secret), so they are
// written as a hand-edited file would be
async function writeDefinitionYaml(
  dir: string,
  file: string,
  type: ModelType,
  fields: Record<string, unknown>,
): Promise<void> {
  const shared = join(dir, "models", "hand-written");
  await ensureDir(shared);
  await Deno.writeTextFile(
    join(shared, file),
    stringifyYaml({
      type: type.normalized,
      id: crypto.randomUUID(),
      version: 1,
      tags: {},
      globalArguments: {},
      methods: {},
      ...fields,
    }),
  );
}

Deno.test("Integration: behavior search JSON describes every result's type exactly as behavior get does", async () => {
  await withRegisteredTypes(["alpha", "beta", "gamma"], async (types) => {
    await withRepo(async (_dir, repo) => {
      for (const [i, type] of types.entries()) {
        await saveDefinitions(repo, type, `def${i}`, 3);
      }
      await saveDefinitions(repo, ModelType.create("command/shell"), "sh", 2);

      const results = await searchJson(repo);

      assertEquals(results.length, 11);
      for (const result of results) {
        const got = await getModel(repo, result.id);
        assertEquals(got.type, result.type);
        assertEquals(result.methods, got.methods, result.name);
        assertEquals(
          result.globalArgumentsSchema,
          got.globalArgumentsSchema,
          result.name,
        );
        assertEquals(result.methods !== undefined, true, result.name);
      }
    });
  });
});

Deno.test("Integration: behavior search JSON reads each definition file once, however many types it describes", async () => {
  const tags = Array.from({ length: 12 }, (_, i) => `t${i}`);
  await withRegisteredTypes(tags, async (types) => {
    await withRepo(async (_dir, repo) => {
      for (const [i, type] of types.entries()) {
        await saveDefinitions(repo, type, `d${i}`, 10);
      }
      const fetchers = await createModelSearchFetchers(repo, "behavior");

      const tally = new PhaseTally(true);
      const results = await withDiagnosticTally(
        "output_search",
        tally,
        () => searchJson(repo, fetchers),
      );

      assertEquals(results.length, 120);
      assertEquals(results.every((r) => r.methods !== undefined), true);
      const counts = tally.attributes();
      assertEquals(counts["swamp.diagnostic.files_read"], 120);
      assertEquals(counts["swamp.diagnostic.primary_walks"], undefined);
    });
  });
});

Deno.test("Integration: behavior search JSON gives each type its own detail when hand-written definitions share a name", async () => {
  await withRegisteredTypes(["first", "second"], async ([first, second]) => {
    await withRepo(async (dir, repo) => {
      await writeDefinitionYaml(dir, "a.yaml", first, { name: "shared" });
      await writeDefinitionYaml(dir, "b.yaml", second, { name: "shared" });

      const results = await searchJson(repo);

      assertEquals(results.map((r) => r.type), [
        first.normalized,
        second.normalized,
      ]);
      assertEquals(
        results.map((r) => (r.methods as Array<{ name: string }>)[0].name),
        ["run_first", "run_second"],
      );
    });
  });
});

Deno.test("Integration: behavior search JSON lists a definition of an unregistered type without detail and still describes the rest", async () => {
  await withRegisteredTypes(["known"], async ([known]) => {
    await withRepo(async (_dir, repo) => {
      await saveDefinitions(repo, known, "known", 1);
      await saveDefinitions(
        repo,
        ModelType.create(`unregistered/t-${crypto.randomUUID().slice(0, 8)}`),
        "orphan",
        1,
      );

      const results = await searchJson(repo);
      const byName = new Map(results.map((r) => [r.name, r]));

      assertEquals(results.length, 2);
      assertEquals(byName.get("orphan-0")?.methods, undefined);
      assertEquals(byName.get("orphan-0")?.globalArgumentsSchema, undefined);
      assertEquals(
        (byName.get("known-0")?.methods as Array<{ name: string }>)[0].name,
        "run_known",
      );
    });
  });
});

Deno.test("Integration: the behavior search picker preview still shows the selected definition, while JSON output never asks for it", async () => {
  await withRegisteredTypes(["picked"], async ([picked]) => {
    await withRepo(async (dir, repo) => {
      await writeDefinitionYaml(dir, "chosen.yaml", picked, {
        name: "chosen",
        tags: { env: "prod" },
        globalArguments: { apiKey: SECRET, region: "eu-west-1" },
        methods: { run_picked: { arguments: { message: "hello" } } },
      });
      const fetchers = await createModelSearchFetchers(repo, "behavior");
      const [item] = await searchJson(repo, fetchers);

      const preview = await fetchers.preview(item);

      assertEquals(preview.name, "chosen");
      assertEquals(preview.tags, { env: "prod" });
      assertEquals(preview.globalArguments, {
        apiKey: "***",
        region: "eu-west-1",
      });
      assertEquals(preview.configuredMethods, {
        run_picked: { arguments: { message: "hello" } },
      });

      let previews = 0;
      await searchJson(repo, {
        ...fetchers,
        preview: (i) => {
          previews++;
          return fetchers.preview(i);
        },
      });
      assertEquals(previews, 0);
    });
  });
});
