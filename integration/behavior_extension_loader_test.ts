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

// Loading behavior-spelled extensions (swamp-club#3338): export const
// behavior is loaded exactly as export const model, extensions/behaviors/
// loads beside extensions/models/ at the same local tier, and a pulled
// extension whose bundle keeps export const behavior loads like any other.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { ExtensionLoader } from "../src/domain/extensions/extension_loader.ts";
import { modelKindAdapter } from "../src/domain/extensions/model_kind_adapter.ts";
import { DuplicateTypeUserError } from "../src/domain/extensions/duplicate_type_user_error.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import type { MethodContext } from "../src/domain/models/model.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import { bundleNamespace } from "../src/infrastructure/persistence/paths.ts";
import { existingBehaviorsDir } from "../src/infrastructure/persistence/resolve_models_dir.ts";
import { withMockedEnv } from "../src/infrastructure/persistence/path_test_helpers.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";

import "../src/domain/models/models.ts";

const testDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve(Deno.execPath()),
  getDenoEnv: () => Deno.env.toObject(),
};

/** A model source spelled with `exportName`, whose `run` records `marker`. */
function modelSource(
  exportName: "model" | "behavior",
  type: string,
  marker = "",
): string {
  return `import { z } from "npm:zod@4";
export const ${exportName} = {
  type: "${type}",
  version: "2026.10.13.1",
  methods: {
    run: {
      description: "Record that the method ran",
      arguments: z.object({}),
      execute: async () => {
        (globalThis as Record<string, unknown>)["${marker}"] = "ran";
        return { dataHandles: [] };
      },
    },
  },
};
`;
}

interface Repo {
  repoDir: string;
  modelsDir: string;
  behaviorsDir: string;
  repository: ExtensionRepository;
  loader: ExtensionLoader;
}

async function withRepo(fn: (repo: Repo) => Promise<void>): Promise<void> {
  const repoDir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp_3338_loader_" }),
  );
  const modelsDir = join(repoDir, "extensions", "models");
  const behaviorsDir = join(repoDir, "extensions", "behaviors");
  await ensureDir(join(repoDir, ".swamp"));
  await ensureDir(modelsDir);
  const lockfilePath = join(modelsDir, "upstream_extensions.json");
  await Deno.writeTextFile(lockfilePath, "{}");
  const catalog = new ExtensionCatalogStore(
    join(repoDir, ".swamp", "_extension_catalog.db"),
  );
  const repository = new ExtensionRepository({
    catalog,
    lockfileRepository: await LockfileRepository.create(lockfilePath),
    repoRoot: repoDir,
  });
  try {
    await fn({
      repoDir,
      modelsDir,
      behaviorsDir,
      repository,
      loader: new ExtensionLoader(
        testDenoRuntime,
        modelKindAdapter,
        repoDir,
        undefined,
        repository,
      ),
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

const uniqueType = (label: string) =>
  `@test/${label}-${crypto.randomUUID().slice(0, 8)}`;

async function runMethod(type: string): Promise<void> {
  const def = modelRegistry.get(type);
  assert(def !== undefined, `${type} is registered`);
  const result = await def.methods.run.execute(
    {},
    { signal: new AbortController().signal } as unknown as MethodContext,
  );
  assertEquals(result.dataHandles, []);
}

Deno.test("loader: export const behavior in extensions/behaviors/ indexes, loads and runs a method", async () => {
  await withRepo(async ({ modelsDir, behaviorsDir, loader }) => {
    const type = uniqueType("spelled");
    const marker = `__swamp3338_${crypto.randomUUID().slice(0, 8)}`;
    await ensureDir(join(behaviorsDir, "nested"));
    await Deno.writeTextFile(
      join(behaviorsDir, "nested", "echo.ts"),
      modelSource("behavior", type, marker),
    );
    // A test file beside it is not an entry point, as in extensions/models/.
    await Deno.writeTextFile(
      join(behaviorsDir, "nested", "echo_test.ts"),
      modelSource("behavior", uniqueType("test-file")),
    );
    try {
      const result = await loader.buildIndex(modelsDir, {
        localDirs: [behaviorsDir],
        indexOnly: true,
      });
      assertEquals(result.failed, []);
      assertEquals(result.loaded, [join("nested", "echo.ts")]);
      await loader.loadSingleType(type);
      await runMethod(type);
      assertEquals(
        (globalThis as Record<string, unknown>)[marker],
        "ran",
      );
    } finally {
      modelRegistry.invalidateType(type);
      delete (globalThis as Record<string, unknown>)[marker];
    }
  });
});

Deno.test("loader: one type in extensions/models/ and extensions/behaviors/ is a DuplicateTypeUserError", async () => {
  await withRepo(async ({ modelsDir, behaviorsDir, loader }) => {
    const type = uniqueType("twice");
    await ensureDir(behaviorsDir);
    await Deno.writeTextFile(
      join(modelsDir, "a.ts"),
      modelSource("model", type),
    );
    await Deno.writeTextFile(
      join(behaviorsDir, "b.ts"),
      modelSource("behavior", type),
    );
    for (
      const run of [
        () =>
          loader.buildIndex(modelsDir, {
            localDirs: [behaviorsDir],
            indexOnly: true,
          }),
        () => loader.load(modelsDir, { localDirs: [behaviorsDir] }),
      ]
    ) {
      const error = await assertRejects(run, DuplicateTypeUserError);
      assertEquals(error.typeNormalized, type);
      assertStringIncludes(error.message, join(modelsDir, "a.ts"));
      assertStringIncludes(error.message, join(behaviorsDir, "b.ts"));
      assertStringIncludes(error.message, "defined in both");
    }
    assertEquals(modelRegistry.has(type), false);
  });
});

Deno.test("loader: a module exporting both model and behavior is refused", async () => {
  await withRepo(async ({ modelsDir, behaviorsDir, loader }) => {
    const type = uniqueType("both");
    await ensureDir(behaviorsDir);
    await Deno.writeTextFile(
      join(behaviorsDir, "both.ts"),
      modelSource("model", type) +
        "export const behavior = { ...model };\n",
    );
    try {
      const result = await loader.load(modelsDir, {
        localDirs: [behaviorsDir],
        skipAlreadyRegistered: true,
      });
      assertEquals(result.loaded, []);
      assertEquals(result.failed.length, 1);
      assertStringIncludes(
        result.failed[0].error,
        "exports both 'model' and 'behavior'",
      );
      assertEquals(modelRegistry.has(type), false);
    } finally {
      modelRegistry.invalidateType(type);
    }
  });
});

Deno.test("loader: a model file that also exports an unrelated behavior binding loads as before", async () => {
  await withRepo(async ({ modelsDir, loader }) => {
    const type = uniqueType("unrelated");
    await Deno.writeTextFile(
      join(modelsDir, "m.ts"),
      // A config object that happens to have a type, but no methods.
      'export const behavior = { type: "backoff", retries: 3 };\n' +
        modelSource("model", type),
    );
    try {
      const result = await loader.load(modelsDir, {
        skipAlreadyRegistered: true,
      });
      assertEquals(result.failed, []);
      assertEquals(modelRegistry.has(type), true);
    } finally {
      modelRegistry.invalidateType(type);
    }
  });
});

Deno.test("loader: a helper file whose only export is an unrelated behavior config is skipped as before", async () => {
  // Before the alias, a file with no model export was a helper: skipped,
  // never reported as failed. A lone `behavior = { type: ... }` without
  // methods must stay that way.
  await withRepo(async ({ modelsDir, loader }) => {
    const type = uniqueType("beside-helper");
    await Deno.writeTextFile(
      join(modelsDir, "retry_config.ts"),
      'export const behavior = { type: "retry", retries: 3 };\n',
    );
    await Deno.writeTextFile(
      join(modelsDir, "real.ts"),
      modelSource("model", type),
    );
    try {
      const result = await loader.load(modelsDir, {
        skipAlreadyRegistered: true,
      });
      assertEquals(result.failed, []);
      assertEquals(modelRegistry.has(type), true);
    } finally {
      modelRegistry.invalidateType(type);
    }
  });
});

Deno.test("loader: helper configs exporting behavior in both directories are not a duplicate type", async () => {
  await withRepo(async ({ modelsDir, behaviorsDir, loader }) => {
    await ensureDir(behaviorsDir);
    const helper = 'export const behavior = { type: "retry", retries: 3 };\n';
    await Deno.writeTextFile(join(modelsDir, "retry_config.ts"), helper);
    await Deno.writeTextFile(join(behaviorsDir, "retry_config.ts"), helper);
    const result = await loader.load(modelsDir, {
      localDirs: [behaviorsDir],
      skipAlreadyRegistered: true,
    });
    assertEquals(result.failed, []);
  });
});

Deno.test("loader: a malformed type in one file does not abort the duplicate check", async () => {
  await withRepo(async ({ modelsDir, behaviorsDir, loader }) => {
    const type = uniqueType("after-malformed");
    await ensureDir(behaviorsDir);
    await Deno.writeTextFile(
      join(behaviorsDir, "real.ts"),
      modelSource("behavior", type),
    );
    await Deno.writeTextFile(
      join(modelsDir, "broken.ts"),
      'export const model = { type: "  ", version: "2026.01.01.1", methods: {} };\n',
    );
    try {
      // The load reaches the files instead of throwing from the check.
      await loader.load(modelsDir, {
        localDirs: [behaviorsDir],
        skipAlreadyRegistered: true,
      });
      assertEquals(modelRegistry.has(type), true);
    } finally {
      modelRegistry.invalidateType(type);
    }
  });
});

Deno.test({
  name:
    "loader: a symlinked extensions/behaviors/ is found and loaded like a symlinked models dir",
  // Creating a directory symlink needs elevated rights on Windows.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withRepo(async ({ repoDir, modelsDir, behaviorsDir, loader }) => {
      const type = uniqueType("linked");
      const target = join(repoDir, "shared-behaviors");
      await ensureDir(target);
      await Deno.writeTextFile(
        join(target, "linked.ts"),
        modelSource("behavior", type),
      );
      await Deno.symlink(target, behaviorsDir, { type: "dir" });
      const found = await withMockedEnv(
        { SWAMP_MODELS_DIR: undefined, SWAMP_BEHAVIORS_DIR: undefined },
        () => existingBehaviorsDir(repoDir, null),
      );
      assertEquals(found, behaviorsDir);
      try {
        const result = await loader.buildIndex(modelsDir, {
          localDirs: [found!],
          indexOnly: true,
        });
        assertEquals(result.failed, []);
        await loader.loadSingleType(type);
        await runMethod(type);
      } finally {
        modelRegistry.invalidateType(type);
      }
    });
  },
});

/**
 * A pulled extension as an install lays it out: the archive's models/
 * sources under the pulled root and its bundle, exported as the author
 * wrote it, in the bundle cache.
 */
async function writePulled(
  repoDir: string,
  bundle: string,
): Promise<string> {
  const pulledModels = join(
    repoDir,
    ".swamp",
    "pulled-extensions",
    "@test",
    "spelled",
    "models",
  );
  await ensureDir(pulledModels);
  await Deno.writeTextFile(join(pulledModels, "pulled.ts"), bundle);
  const bundleDir = join(
    repoDir,
    ".swamp",
    "bundles",
    bundleNamespace(pulledModels, repoDir),
  );
  await ensureDir(bundleDir);
  await Deno.writeTextFile(join(bundleDir, "pulled.js"), bundle);
  return pulledModels;
}

Deno.test("loader: a pulled bundle exporting behavior loads and runs", async () => {
  await withRepo(async ({ repoDir, loader }) => {
    const type = uniqueType("pulled");
    const pulledModels = await writePulled(
      repoDir,
      modelSource("behavior", type).replace(" as Record<string, unknown>", ""),
    );
    try {
      const result = await loader.load(pulledModels, {
        skipAlreadyRegistered: true,
      });
      assertEquals(result.failed, []);
      assertEquals(result.loaded, ["pulled.ts"]);
      await runMethod(type);
    } finally {
      modelRegistry.invalidateType(type);
    }
  });
});

Deno.test("loader: a pulled bundle exporting both model and behavior fails clearly", async () => {
  await withRepo(async ({ repoDir, loader }) => {
    const type = uniqueType("pulled-both");
    const pulledModels = await writePulled(
      repoDir,
      modelSource("model", type).replace(" as Record<string, unknown>", "") +
        "export const behavior = { ...model };\n",
    );
    try {
      const result = await loader.load(pulledModels, {
        skipAlreadyRegistered: true,
      });
      assertEquals(result.loaded, []);
      assertEquals(result.failed.length, 1);
      assertStringIncludes(
        result.failed[0].error,
        "exports both 'model' and 'behavior'",
      );
      assertEquals(modelRegistry.has(type), false);
    } finally {
      modelRegistry.invalidateType(type);
    }
  });
});
