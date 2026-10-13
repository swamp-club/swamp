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

// A running serve resolves an edited repo-local model to its new code, for
// steps it runs itself and for the bundle it ships to workers
// (swamp-club#3284). Wires the extension loader, catalog, model registry
// and serve's run deps as `swamp serve` wires them.

import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { withMockedCommand } from "@swamp-club/swamp-testing";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { resolveModelType } from "../src/domain/extensions/extension_auto_resolver.ts";
import { ExtensionLoader } from "../src/domain/extensions/extension_loader.ts";
import { modelKindAdapter } from "../src/domain/extensions/model_kind_adapter.ts";
import { refreshLocalModels } from "../src/domain/extensions/local_model_refresh.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import {
  createModelMethodRunDeps,
  createWorkflowRunDeps,
} from "../src/serve/deps.ts";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const stubDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve("/nonexistent/swamp-test/deno"),
  getDenoEnv: () => Deno.env.toObject(),
};

/** Mock `deno bundle`: copies the source to the `-o` output path. */
const copyingBundler = async (_cmd: string, args: string[]) => {
  const out = args[args.indexOf("-o") + 1];
  await Deno.writeTextFile(out, await Deno.readTextFile(args[args.length - 1]));
  return { stdout: "", stderr: "", code: 0 };
};

const modelCode = (type: string, version: string) =>
  `const { z } = globalThis.__swamp_zod;
export const model = {
  type: "${type}",
  version: "2026.10.13.1",
  globalArguments: z.object({}),
  resources: {
    plan: {
      description: "x",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 1,
    },
  },
  methods: {
    plan: {
      description: "${version}",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.test("serve run deps resolve an edited local model to its new code and a new dispatch bundle", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-3284-serve-" });
  const type = `@test/planner-${crypto.randomUUID().slice(0, 8)}`;
  const modelType = ModelType.create(type);
  const modelsDir = join(dir, "extensions", "models");
  const source = join(modelsDir, "planner.ts");
  const lockfilePath = join(modelsDir, "upstream_extensions.json");
  await Deno.mkdir(modelsDir, { recursive: true });
  await Deno.writeTextFile(lockfilePath, "{}");
  await Deno.writeTextFile(source, modelCode(type, "v1"));
  const catalog = new ExtensionCatalogStore(
    join(dir, ".swamp", "_extension_catalog.db"),
  );
  const repo = createRepositoryContext({ repoDir: dir });
  const datastore = { type: "filesystem" as const, path: join(dir, ".swamp") };
  try {
    await withMockedCommand(copyingBundler, async () => {
      // As cli/mod.ts wires the registry for a serve process.
      const loader = new ExtensionLoader(
        stubDenoRuntime,
        modelKindAdapter,
        dir,
        undefined,
        new ExtensionRepository({
          catalog,
          lockfileRepository: await LockfileRepository.create(lockfilePath),
          repoRoot: dir,
        }),
      );
      modelRegistry.setTypeLoader((t, entry) =>
        loader.loadSingleType(t, entry)
      );
      await loader.buildIndex(modelsDir, { indexOnly: true });
      await loader.buildIndex(modelsDir, { indexOnly: true });
      modelRegistry.setSourceRefresher(() =>
        refreshLocalModels(loader, modelsDir, [])
      );

      const methodDeps = await createModelMethodRunDeps(dir, repo);
      const v1 = await methodDeps.getModelDef(modelType);
      assertEquals(v1?.methods.plan.description, "v1");
      const v1Bundle = await sha256Hex(await v1!.bundleSourceFactory!());

      await Deno.writeTextFile(source, modelCode(type, "v2"));
      await createWorkflowRunDeps(dir, repo, datastore);
      // How a workflow step resolves its model (execution_service.ts).
      const v2 = await resolveModelType(modelType, null);
      assertEquals(v2?.methods.plan.description, "v2");
      const v2Bundle = await sha256Hex(await v2!.bundleSourceFactory!());
      assertNotEquals(v2Bundle, v1Bundle);

      await Deno.writeTextFile(source, modelCode(type, "v3"));
      const again = await createModelMethodRunDeps(dir, repo);
      assertEquals(
        (await again.getModelDef(modelType))?.methods.plan.description,
        "v3",
      );
    });
  } finally {
    modelRegistry.invalidateType(type);
    modelRegistry.clearLoadersForTesting();
    catalog.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
