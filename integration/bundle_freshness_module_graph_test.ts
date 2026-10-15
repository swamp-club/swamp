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
// Bundle freshness over the real module graph (swamp-club#3385). A model in
// extensions/models that imports ../lib/msg.ts, and side-effect imports
// ./side.ts, is bundled by the real loader with the real `deno bundle` and
// `deno info`. Editing either module must make the warm scan find the model
// stale, which the relative-import walk bounded at extensions/models never
// did; editing an unrelated file must not, and a scan with no edits must
// read no module graph. A graph that cannot be read is retried once
// (swamp-club#3487).

import { assertEquals } from "@std/assert";
import { basename, join } from "@std/path";
import { ensureDir } from "@std/fs";
import { ExtensionLoader } from "../src/domain/extensions/extension_loader.ts";
import { findStaleFiles } from "../src/domain/extensions/bundle_freshness.ts";
import type { ModuleGraphReaderFactory } from "../src/domain/extensions/extension_source_graph.ts";
import { modelKindAdapter } from "../src/domain/extensions/model_kind_adapter.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import { createDenoInfoModuleGraphReader } from "../src/infrastructure/runtime/deno_info_module_graph_reader.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";

import "../src/domain/models/models.ts";

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
  getDenoEnv: () => Deno.env.toObject(),
};

const modelCode = (type: string) => `
import { z } from "npm:zod@4";
import { MSG } from "../lib/msg.ts";
import "./side.ts";

export const model = {
  type: "${type}",
  version: "2026.10.14.1",
  description: MSG,
  globalArguments: z.object({}),
  resources: {},
  methods: {
    noop: {
      description: "noop",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

Deno.test("bundle freshness: editing a module outside the kind directory or a side-effect import marks the bundle stale (swamp-club#3385)", async () => {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_3385_graph_" });
  const modelsDir = join(repoDir, "extensions", "models");
  const libDir = join(repoDir, "extensions", "lib");
  await ensureDir(modelsDir);
  await ensureDir(libDir);
  await ensureDir(join(repoDir, ".swamp"));
  const type = `@test/graph-${crypto.randomUUID().slice(0, 8)}`;
  const entry = join(modelsDir, "echo.ts");
  const lib = join(libDir, "msg.ts");
  const side = join(modelsDir, "side.ts");
  const unrelated = join(libDir, "unrelated.ts");
  await Deno.writeTextFile(entry, modelCode(type));
  await Deno.writeTextFile(lib, 'export const MSG = "v1";\n');
  await Deno.writeTextFile(side, "export {};\n");
  await Deno.writeTextFile(unrelated, "export const u = 1;\n");

  const catalog = new ExtensionCatalogStore(
    join(repoDir, ".swamp", "_extension_catalog.db"),
  );
  let graphReads = 0;
  const countingReader: ModuleGraphReaderFactory = (denoPath, env) => {
    const reader = createDenoInfoModuleGraphReader(denoPath, env);
    return {
      read: (entryPoint, project) => {
        graphReads++;
        return reader.read(entryPoint, project);
      },
    };
  };
  try {
    const loader = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      new ExtensionRepository({
        catalog,
        lockfileRepository: new LockfileRepository(
          join(repoDir, "upstream_extensions.json"),
        ),
        repoRoot: repoDir,
      }),
      undefined,
      countingReader,
    );
    const staleNow = async () =>
      (await findStaleFiles({
        modelsDir,
        catalog,
        discoverFiles: () => Promise.resolve(["echo.ts", "side.ts"]),
        kinds: ["model"],
        repoDir,
      })).map((s) => s.relativePath).filter((p) => p === "echo.ts");
    const rebuild = async () => {
      await loader.buildIndex(modelsDir);
      assertEquals(await staleNow(), [], "the rebuild leaves it fresh");
    };

    await loader.buildIndex(modelsDir);
    await rebuild();
    assertEquals(graphReads > 0, true, "bundling read the module graph");
    assertEquals(
      (catalog.findSourceModules(entry) ?? []).map((p) => basename(p)).sort(),
      ["echo.ts", "msg.ts", "side.ts"],
      "the recorded graph includes ../lib/msg.ts and the side-effect import",
    );

    const readsBefore = graphReads;
    await rebuild();
    assertEquals(
      graphReads,
      readsBefore,
      "a scan with no edits reads no graph",
    );

    await Deno.writeTextFile(unrelated, "export const u = 2;\n");
    assertEquals(await staleNow(), [], "an unrelated edit");

    await Deno.writeTextFile(lib, 'export const MSG = "v2";\n');
    assertEquals(await staleNow(), ["echo.ts"], "an edit to ../lib/msg.ts");
    await rebuild();

    await Deno.writeTextFile(side, "globalThis.touched = true;\n");
    assertEquals(await staleNow(), ["echo.ts"], "an edit to ./side.ts");
    await rebuild();

    // A catalog an earlier binary wrote has no recorded modules: the source
    // is rebuilt once, then fresh.
    catalog.deleteSourceModules(entry);
    assertEquals(await staleNow(), ["echo.ts"], "an unrecorded local source");
    await rebuild();
    await rebuild();
  } finally {
    catalog.close();
    modelRegistry.invalidateType(type);
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
});

/**
 * Builds the swamp-club#3385 layout and a loader whose module-graph reader
 * fails while `failing(readNumber)` is true, then hands both to `body`.
 */
async function withFlakyGraphReader(
  failing: (readNumber: number) => boolean,
  body: (ctx: {
    loader: ExtensionLoader;
    catalog: ExtensionCatalogStore;
    modelsDir: string;
    entry: string;
    lib: string;
    graphReads: () => number;
    staleNow: () => Promise<string[]>;
  }) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_3487_graph_" });
  const modelsDir = join(repoDir, "extensions", "models");
  const libDir = join(repoDir, "extensions", "lib");
  await ensureDir(modelsDir);
  await ensureDir(libDir);
  await ensureDir(join(repoDir, ".swamp"));
  const type = `@test/graph-${crypto.randomUUID().slice(0, 8)}`;
  const entry = join(modelsDir, "echo.ts");
  const lib = join(libDir, "msg.ts");
  await Deno.writeTextFile(entry, modelCode(type));
  await Deno.writeTextFile(lib, 'export const MSG = "v1";\n');
  await Deno.writeTextFile(join(modelsDir, "side.ts"), "export {};\n");

  const catalog = new ExtensionCatalogStore(
    join(repoDir, ".swamp", "_extension_catalog.db"),
  );
  let graphReads = 0;
  const flakyReader: ModuleGraphReaderFactory = (denoPath, env) => {
    const reader = createDenoInfoModuleGraphReader(denoPath, env);
    return {
      read: (entryPoint, project) => {
        graphReads++;
        if (failing(graphReads)) {
          return Promise.reject(new Error("simulated deno info timeout"));
        }
        return reader.read(entryPoint, project);
      },
    };
  };
  try {
    const loader = new ExtensionLoader(
      testDenoRuntime,
      modelKindAdapter,
      repoDir,
      undefined,
      new ExtensionRepository({
        catalog,
        lockfileRepository: new LockfileRepository(
          join(repoDir, "upstream_extensions.json"),
        ),
        repoRoot: repoDir,
      }),
      undefined,
      flakyReader,
    );
    await body({
      loader,
      catalog,
      modelsDir,
      entry,
      lib,
      graphReads: () => graphReads,
      staleNow: async () =>
        (await findStaleFiles({
          modelsDir,
          catalog,
          discoverFiles: () => Promise.resolve(["echo.ts", "side.ts"]),
          kinds: ["model"],
          repoDir,
        })).map((s) => s.relativePath).filter((p) => p === "echo.ts"),
    });
  } finally {
    catalog.close();
    modelRegistry.invalidateType(type);
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

Deno.test("bundle freshness: a module graph that fails to read once is read again on the next scan (swamp-club#3487)", async () => {
  await withFlakyGraphReader(
    (n) => n === 1,
    async (
      { loader, catalog, modelsDir, entry, lib, graphReads, staleNow },
    ) => {
      await loader.buildIndex(modelsDir);
      assertEquals(graphReads(), 1);
      assertEquals(catalog.isSourceGraphPending(entry), true);
      assertEquals(await staleNow(), ["echo.ts"], "stale for its one retry");

      await loader.buildIndex(modelsDir);
      assertEquals(graphReads(), 2, "the retry read the graph");
      assertEquals(catalog.isSourceGraphPending(entry), false);
      assertEquals(
        (catalog.findSourceModules(entry) ?? []).map((p) => basename(p))
          .sort(),
        ["echo.ts", "msg.ts", "side.ts"],
      );
      assertEquals(await staleNow(), []);

      await Deno.writeTextFile(lib, 'export const MSG = "v2";\n');
      assertEquals(await staleNow(), ["echo.ts"], "an edit to ../lib/msg.ts");
    },
  );
});

Deno.test("bundle freshness: a module graph that never reads is retried once, then the relative imports are kept (swamp-club#3487)", async () => {
  await withFlakyGraphReader(
    () => true,
    async ({ loader, catalog, modelsDir, entry, graphReads, staleNow }) => {
      await loader.buildIndex(modelsDir);
      await loader.buildIndex(modelsDir);
      assertEquals(graphReads(), 2, "the first read and its one retry");
      assertEquals(catalog.isSourceGraphPending(entry), false);
      assertEquals(
        (catalog.findSourceModules(entry) ?? []).map((p) => basename(p)),
        ["echo.ts"],
      );
      assertEquals(await staleNow(), []);

      await loader.buildIndex(modelsDir);
      assertEquals(graphReads(), 2, "no further retry with no edits");
    },
  );
});
