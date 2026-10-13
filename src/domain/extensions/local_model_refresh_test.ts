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
  assertEquals,
  assertNotStrictEquals,
  assertStrictEquals,
  assertStringIncludes,
} from "@std/assert";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { withMockedCommand } from "@swamp-club/swamp-testing";
import { join } from "@std/path";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";
import { modelRegistry } from "../models/model.ts";
import { ExtensionLoader } from "./extension_loader.ts";
import {
  clearAttachedExtensions,
  modelKindAdapter,
} from "./model_kind_adapter.ts";
import { refreshLocalModels } from "./local_model_refresh.ts";

const stubDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve("/nonexistent/swamp-test/deno"),
  getDenoEnv: () => Deno.env.toObject(),
};

const modelCode = (type: string, description: string) =>
  `const { z } = globalThis.__swamp_zod;
export const model = {
  type: "${type}",
  version: "2026.10.13.1",
  globalArguments: z.object({}),
  resources: {
    data: {
      description: "x",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 1,
    },
  },
  methods: {
    run: {
      description: "${description}",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

const addOnCode = (type: string, description: string, method = "extra") => `
export const extension = {
  type: "${type}",
  methods: [{
    ${method}: {
      description: "${description}",
      arguments: globalThis.__swamp_zod.z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }],
};
`;

/** Mock `deno bundle`: copies the source to the `-o` output path. */
let bundleFails = false;
let bundleCalls = 0;
const copyingBundler = async (_cmd: string, args: string[]) => {
  bundleCalls++;
  if (bundleFails) {
    return { stdout: "", stderr: "bundle failed", code: 1 };
  }
  const out = args[args.indexOf("-o") + 1];
  await Deno.writeTextFile(out, await Deno.readTextFile(args[args.length - 1]));
  return { stdout: "", stderr: "", code: 0 };
};

interface Fixture {
  repoDir: string;
  modelsDir: string;
  pulledModelsDir: string;
  loader: ExtensionLoader;
  /** Runs one refresh pass over the dirs the fixture indexed. */
  refresh: () => Promise<void>;
  type: (suffix: string) => string;
}

/**
 * A repo with a local models dir and one pulled extension, indexed as a
 * fresh process indexes it, with the registry's type loader wired to the
 * fixture's loader. Types are unique per run (`--repeats`).
 */
async function withRepo(
  fn: (f: Fixture) => Promise<void>,
  setup: (f: Omit<Fixture, "loader" | "refresh">) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_3284_" });
  const id = crypto.randomUUID().slice(0, 8);
  const extName = `@test/pulled-${id}`;
  const modelsDir = join(repoDir, "extensions", "models");
  const pulledModelsDir = join(
    repoDir,
    ".swamp",
    "pulled-extensions",
    extName,
    "models",
  );
  const lockfilePath = join(modelsDir, "upstream_extensions.json");
  await Deno.mkdir(modelsDir, { recursive: true });
  await Deno.mkdir(pulledModelsDir, { recursive: true });
  await Deno.writeTextFile(
    lockfilePath,
    JSON.stringify({ [extName]: { version: "1.0.0", files: [] } }),
  );
  const type = (suffix: string) => `@test/edit-${id}-${suffix}`;
  const base = { repoDir, modelsDir, pulledModelsDir, type };
  await setup(base);
  const catalog = new ExtensionCatalogStore(
    join(repoDir, ".swamp", "catalog.db"),
  );
  const loader = new ExtensionLoader(
    stubDenoRuntime,
    modelKindAdapter,
    repoDir,
    undefined,
    new ExtensionRepository({
      catalog,
      lockfileRepository: await LockfileRepository.create(lockfilePath),
      repoRoot: repoDir,
    }),
  );
  const additionalDirs = [pulledModelsDir];
  try {
    await withMockedCommand(copyingBundler, async () => {
      modelRegistry.setTypeLoader((t, entry) =>
        loader.loadSingleType(t, entry)
      );
      // Cold pass populates the catalog, a warm pass registers it lazily,
      // as two CLI commands in a row would.
      await loader.buildIndex(modelsDir, { additionalDirs, indexOnly: true });
      await loader.buildIndex(modelsDir, { additionalDirs, indexOnly: true });
      await fn({
        ...base,
        loader,
        refresh: () => refreshLocalModels(loader, modelsDir, additionalDirs),
      });
    });
  } finally {
    bundleFails = false;
    for (const suffix of ["a", "b", "new", "pulled"]) {
      modelRegistry.invalidateType(type(suffix));
    }
    clearAttachedExtensions();
    modelRegistry.clearLoadersForTesting();
    catalog.close();
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
}

async function loaded(type: string) {
  await modelRegistry.ensureTypeLoaded(type);
  return modelRegistry.get(type);
}

Deno.test("refreshLocalModels: an edited local model runs its new code, and its dispatch bundle changes", async () => {
  await withRepo(async ({ modelsDir, refresh, type }) => {
    const before = await loaded(type("a"));
    assertEquals(before?.methods.run.description, "v1");
    const bundleBefore = await before!.bundleSourceFactory!();

    await Deno.writeTextFile(
      join(modelsDir, "a.ts"),
      modelCode(type("a"), "v2"),
    );
    await refresh();

    const after = modelRegistry.get(type("a"));
    assertEquals(after?.methods.run.description, "v2");
    assertNotStrictEquals(after, before);
    const bundleAfter = await after!.bundleSourceFactory!();
    assertStringIncludes(bundleAfter, '"v2"');
    assertEquals(bundleAfter === bundleBefore, false);
  }, async ({ modelsDir, type }) => {
    await Deno.writeTextFile(
      join(modelsDir, "a.ts"),
      modelCode(type("a"), "v1"),
    );
  });
});

Deno.test("refreshLocalModels: an unchanged model keeps its definition and is not rebundled", async () => {
  await withRepo(async ({ refresh, type }) => {
    const before = await loaded(type("a"));
    const calls = bundleCalls;

    await refresh();

    assertStrictEquals(modelRegistry.get(type("a")), before);
    assertEquals(bundleCalls, calls);
  }, async ({ modelsDir, type }) => {
    await Deno.writeTextFile(
      join(modelsDir, "a.ts"),
      modelCode(type("a"), "v1"),
    );
  });
});

Deno.test("refreshLocalModels: an edited pulled model is left to hot-reload", async () => {
  await withRepo(async ({ pulledModelsDir, refresh, type }) => {
    const before = await loaded(type("pulled"));

    await Deno.writeTextFile(
      join(pulledModelsDir, "p.ts"),
      modelCode(type("pulled"), "v2"),
    );
    await refresh();

    assertStrictEquals(modelRegistry.get(type("pulled")), before);
  }, async ({ pulledModelsDir, type }) => {
    await Deno.writeTextFile(
      join(pulledModelsDir, "p.ts"),
      modelCode(type("pulled"), "v1"),
    );
  });
});

Deno.test("refreshLocalModels: an edit that no longer validates unregisters the type until it is fixed", async () => {
  await withRepo(async ({ modelsDir, refresh, type }) => {
    await loaded(type("a"));
    const source = join(modelsDir, "a.ts");

    await Deno.writeTextFile(
      source,
      `export const model = { type: "${type("a")}" };\n`,
    );
    await refresh();
    assertEquals(await loaded(type("a")), undefined);

    await Deno.writeTextFile(source, modelCode(type("a"), "v3"));
    await refresh();
    assertEquals((await loaded(type("a")))?.methods.run.description, "v3");
  }, async ({ modelsDir, type }) => {
    await Deno.writeTextFile(
      join(modelsDir, "a.ts"),
      modelCode(type("a"), "v1"),
    );
  });
});

Deno.test("refreshLocalModels: a failed deno bundle keeps the previous code, as a local run does", async () => {
  await withRepo(async ({ modelsDir, refresh, type }) => {
    await loaded(type("a"));

    await Deno.writeTextFile(
      join(modelsDir, "a.ts"),
      modelCode(type("a"), "v2"),
    );
    bundleFails = true;
    await refresh();

    assertEquals((await loaded(type("a")))?.methods.run.description, "v1");
  }, async ({ modelsDir, type }) => {
    await Deno.writeTextFile(
      join(modelsDir, "a.ts"),
      modelCode(type("a"), "v1"),
    );
  });
});

Deno.test("refreshLocalModels: a model file added or deleted after startup appears or goes", async () => {
  await withRepo(async ({ modelsDir, refresh, type }) => {
    await loaded(type("a"));

    await Deno.writeTextFile(
      join(modelsDir, "new.ts"),
      modelCode(type("new"), "fresh"),
    );
    await Deno.remove(join(modelsDir, "a.ts"));
    await refresh();

    assertEquals(
      (await loaded(type("new")))?.methods.run.description,
      "fresh",
    );
    assertEquals(await loaded(type("a")), undefined);
  }, async ({ modelsDir, type }) => {
    await Deno.writeTextFile(
      join(modelsDir, "a.ts"),
      modelCode(type("a"), "v1"),
    );
  });
});

Deno.test("refreshLocalModels: an edited local add-on replaces the members it attached", async () => {
  await withRepo(async ({ modelsDir, refresh, type }) => {
    const before = await loaded(type("b"));
    assertEquals(before?.methods.extra?.description, "a1");

    await Deno.writeTextFile(
      join(modelsDir, "b_extra.ts"),
      addOnCode(type("b"), "a2"),
    );
    await refresh();

    assertEquals(
      (await loaded(type("b")))?.methods.extra?.description,
      "a2",
    );
  }, async ({ modelsDir, type }) => {
    await Deno.writeTextFile(
      join(modelsDir, "b.ts"),
      modelCode(type("b"), "base"),
    );
    await Deno.writeTextFile(
      join(modelsDir, "b_extra.ts"),
      addOnCode(type("b"), "a1"),
    );
  });
});

Deno.test("refreshLocalModels: a member an edited local add-on no longer declares is detached", async () => {
  await withRepo(async ({ modelsDir, refresh, type }) => {
    await loaded(type("b"));

    await Deno.writeTextFile(
      join(modelsDir, "b_extra.ts"),
      addOnCode(type("b"), "a2", "renamed"),
    );
    await refresh();

    const after = await loaded(type("b"));
    assertEquals(after?.methods.renamed?.description, "a2");
    assertEquals(after?.methods.extra, undefined);
  }, async ({ modelsDir, type }) => {
    await Deno.writeTextFile(
      join(modelsDir, "b.ts"),
      modelCode(type("b"), "base"),
    );
    await Deno.writeTextFile(
      join(modelsDir, "b_extra.ts"),
      addOnCode(type("b"), "a1"),
    );
  });
});

Deno.test("refreshLocalModels: a local add-on that no longer loads leaves its base model registered", async () => {
  await withRepo(async ({ modelsDir, refresh, type }) => {
    await loaded(type("b"));

    await Deno.writeTextFile(
      join(modelsDir, "b_extra.ts"),
      `export const extension = { type: "${type("b")}", methods: [\n`,
    );
    await refresh();

    assertEquals((await loaded(type("b")))?.methods.run.description, "base");
  }, async ({ modelsDir, type }) => {
    await Deno.writeTextFile(
      join(modelsDir, "b.ts"),
      modelCode(type("b"), "base"),
    );
    await Deno.writeTextFile(
      join(modelsDir, "b_extra.ts"),
      addOnCode(type("b"), "a1"),
    );
  });
});

Deno.test("refreshLocalModels: a broken model warns once, not on every later refresh", async () => {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      { category: ["swamp"], lowestLevel: "warning", sinks: ["capture"] },
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: [] },
    ],
    reset: true,
  });
  try {
    await withRepo(async ({ modelsDir, refresh, type }) => {
      await loaded(type("a"));
      await Deno.writeTextFile(
        join(modelsDir, "a.ts"),
        `export const model = { type: "${type("a")}" };\n`,
      );

      await refresh();
      assertEquals(records.length, 1);
      assertStringIncludes(String(records[0].message), "no longer loads");

      await refresh();
      await refresh();
      assertEquals(records.length, 1);
    }, async ({ modelsDir, type }) => {
      await Deno.writeTextFile(
        join(modelsDir, "a.ts"),
        modelCode(type("a"), "v1"),
      );
    });
  } finally {
    await reset();
  }
});
