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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { z } from "zod";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import type {
  MethodContext,
  MethodDefinition,
  ModelDefinition,
} from "../src/domain/models/model.ts";
import { DefaultMethodExecutionService } from "../src/domain/models/method_execution_service.ts";
import { buildMethodContext } from "../src/domain/models/method_context.ts";
import { DataQueryService } from "../src/domain/data/data_query_service.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { FileSystemUnifiedDataRepository } from "../src/infrastructure/persistence/unified_data_repository.ts";
import { CatalogStore } from "../src/infrastructure/persistence/catalog_store.ts";
import { createExtensionCelEnvironment } from "../src/infrastructure/cel/cel_evaluator.ts";

const TYPE = ModelType.create("test/spec-name-clash");
const Signals = z.object({ count: z.number() });

function writes(
  specName: string,
  dataName: string,
  rollbackOnFailure = false,
): MethodDefinition {
  return {
    description: `writes ${dataName} under ${specName}`,
    arguments: z.object({}),
    rollbackOnFailure,
    execute: async (_args, context) => {
      const handle = await context.writeResource!(specName, dataName, {
        count: 0,
      });
      return { dataHandles: [handle] };
    },
  };
}

const model: ModelDefinition = {
  type: TYPE,
  version: "2026.01.01.1",
  resources: {
    signals: {
      description: "signals",
      schema: Signals,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    host: {
      description: "one item per host",
      schema: Signals,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    named: writes("signals", "signals"),
    watch: writes("signals", "pattern-watch-signals"),
    watchDeferred: writes("signals", "pattern-watch-signals", true),
    watchThenFail: {
      ...writes("signals", "pattern-watch-signals"),
      execute: async (_args, context) => {
        await context.writeResource!("signals", "pattern-watch-signals", {
          count: 0,
        });
        throw new Error("failed after writing");
      },
    },
    hostA: writes("host", "host-a"),
    hostB: writes("host", "host-b"),
  },
};

function captureWarnings(sink: string[]): MethodContext["logger"] {
  const record = (keep: boolean) =>
  (
    strings: TemplateStringsArray | string,
    ...values: unknown[]
  ): void => {
    if (!keep) return;
    sink.push(
      typeof strings === "string" ? strings : strings.reduce(
        (acc, part, i) =>
          acc + part + (i < values.length ? String(values[i]) : ""),
        "",
      ),
    );
  };
  return new Proxy({}, {
    get(_target, property) {
      if (property === "getChild") return () => captureWarnings(sink);
      return record(property === "warn");
    },
  }) as unknown as MethodContext["logger"];
}

async function withRepo(
  fn: (run: (method: string) => Promise<string[]>) => Promise<void>,
  QueryService: typeof DataQueryService = DataQueryService,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-spec-clash-test-" });
  await ensureDir(join(dir, ".swamp", "data"));
  const catalog = new CatalogStore(join(dir, ".swamp", "data", "_catalog.db"));
  try {
    catalog.markPopulated();
    const dataRepository = new FileSystemUnifiedDataRepository(
      dir,
      undefined,
      catalog,
    );
    const definitionRepository = new YamlDefinitionRepository(
      dir,
      undefined,
      undefined,
      false,
    );
    const definition = Definition.create({
      name: "grafana",
      typeVersion: model.version,
      methods: Object.fromEntries(
        Object.keys(model.methods).map((m) => [m, { arguments: {} }]),
      ),
    });
    await definitionRepository.save(TYPE, definition);
    const dataQueryService = new QueryService(catalog, dataRepository);

    await fn(async (methodName) => {
      const warnings: string[] = [];
      const context = buildMethodContext(
        {
          dataRepository,
          definitionRepository,
          dataQueryService,
          createCelEnvironment: createExtensionCelEnvironment,
        },
        {
          signal: new AbortController().signal,
          repoDir: dir,
          modelType: TYPE,
          modelId: definition.id,
          globalArgs: {},
          definition: {
            id: definition.id,
            name: definition.name,
            version: definition.version,
            tags: definition.tags,
          },
          methodName,
          logger: captureWarnings(warnings),
        },
      );
      try {
        await new DefaultMethodExecutionService().executeWorkflow(
          definition,
          model,
          methodName,
          context,
        );
      } catch (error) {
        if (!methodName.endsWith("ThenFail")) throw error;
      }
      return warnings.filter((w) => w.includes("now fails as ambiguous"));
    });
  } finally {
    catalog.close();
    if (Deno.build.os === "windows") {
      // EBUSY can fire on windows before V8 frees native sqlite handles; the
      // temp dir is ephemeral
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("spec name clash: the run that first writes the clashing data name warns, with both fixes", async () => {
  await withRepo(async (run) => {
    assertEquals(await run("named"), []);
    const warnings = await run("watch");
    assertEquals(warnings.length, 1);
    assertStringIncludes(
      warnings[0],
      'Data item "pattern-watch-signals" was written under spec "signals"',
    );
    assertStringIncludes(
      warnings[0],
      'data.latest("grafana", "signals") now fails as ambiguous ' +
        "(pattern-watch-signals, signals)",
    );
    assertStringIncludes(
      warnings[0],
      `data.query('modelName == "grafana" && name == "signals" && ns == ""')[0]`,
    );
  });
});

Deno.test("spec name clash: a later run of the same data name does not warn again", async () => {
  await withRepo(async (run) => {
    await run("named");
    assertEquals((await run("watch")).length, 1);
    assertEquals(await run("watch"), []);
  });
});

Deno.test("spec name clash: writing the item named after the spec warns when siblings already exist", async () => {
  await withRepo(async (run) => {
    assertEquals(await run("watch"), []);
    assertEquals((await run("named")).length, 1);
  });
});

Deno.test("spec name clash: a spec with many items and none named after it does not warn", async () => {
  await withRepo(async (run) => {
    assertEquals(await run("hostA"), []);
    assertEquals(await run("hostB"), []);
  });
});

Deno.test("spec name clash: a rollbackOnFailure run warns once its writes are promoted", async () => {
  await withRepo(async (run) => {
    await run("named");
    assertEquals((await run("watchDeferred")).length, 1);
  });
});

Deno.test("spec name clash: a run that writes the clashing item and then fails still warns", async () => {
  await withRepo(async (run) => {
    await run("named");
    assertEquals((await run("watchThenFail")).length, 1);
    assertEquals(await run("watch"), []);
  });
});

Deno.test("spec name clash: a failing check never fails the run", async () => {
  class FailingQueryService extends DataQueryService {
    override specNameClash(): string[] | null {
      throw new Error("catalog unavailable");
    }
  }
  await withRepo(async (run) => {
    await run("named");
    assertEquals(await run("watch"), []);
  }, FailingQueryService);
});
