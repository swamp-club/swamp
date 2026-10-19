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

// A pulled extension changed on disk under a running serve, as a
// `--server` pull leaves it (swamp-club#3594). Until serve reloads, its
// dispatch refuses to ship workers the new source while serve still runs
// the old code; the reload a --hot-reload serve runs after the pull makes
// serve and its workers run the new code together. Wires the extension
// loader, catalog, model registry, serve's reload, DispatchService and
// BundleRegistry as `swamp serve` wires them.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { withMockedCommand } from "@swamp-club/swamp-testing";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ExtensionLoader } from "../src/domain/extensions/extension_loader.ts";
import { modelKindAdapter } from "../src/domain/extensions/model_kind_adapter.ts";
import { StaleExtensionSourceError } from "../src/domain/extensions/source_snapshot.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import {
  bundleNamespace,
  swampPath,
} from "../src/infrastructure/persistence/paths.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { EmbeddedDenoRuntime } from "../src/infrastructure/runtime/embedded_deno_runtime.ts";
import { BundleRegistry } from "../src/serve/bundle_registry.ts";
import { DispatchRegistry } from "../src/serve/dispatch_registry.ts";
import {
  type DispatchGateway,
  DispatchService,
} from "../src/serve/dispatch_service.ts";
import {
  reloadAfterExtensionChange,
  reloadPulledExtensions,
} from "../src/serve/extension_reload.ts";
import type { WorkerSnapshot } from "../src/serve/worker_gateway.ts";
import type { ModelDefinition } from "../src/domain/models/model.ts";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

/** Mock `deno bundle`: copies the source to the `-o` output path. */
const copyingBundler = async (_cmd: string, args: string[]) => {
  const out = args[args.indexOf("-o") + 1];
  await Deno.writeTextFile(out, await Deno.readTextFile(args[args.length - 1]));
  return { stdout: "", stderr: "", code: 0 };
};

const modelCode = (type: string, version: string) => `
import { z } from "npm:zod@4";

export const model = {
  type: "${type}",
  version: "2026.10.19.1",
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
      description: "${version}",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

const worker: WorkerSnapshot = {
  name: "w1",
  instanceUuid: "uuid-w1",
  labels: {},
  platform: "linux",
  arch: "x86_64",
  swampVersion: "1.0.0",
  status: "idle",
  connected: true,
  capacity: 1,
  activeDispatchIds: [],
};

/** A DispatchService over one idle worker that records each fingerprint. */
function dispatcher(bundles: BundleRegistry) {
  const shipped: string[] = [];
  const gateway: DispatchGateway = {
    workers: () => [worker],
    worker: () => worker,
    dispatch: (_name, params) => {
      shipped.push(params.bundleFingerprint);
      return Promise.resolve({
        status: "success",
        outputs: [],
        logs: [],
        durationMs: 1,
      });
    },
  };
  const service = new DispatchService({
    repoDir: "/tmp/unused",
    repoContext: {} as RepositoryContext,
    dispatches: new DispatchRegistry(),
    bundles,
    queueTimeoutMs: 2_000,
    runModelMethod: () => Promise.resolve(),
    captureEnvironment: () => ({}),
  });
  service.bindGateway(gateway);
  const run = (modelDef: ModelDefinition) =>
    service.executeRemote({
      placement: { labels: {}, platform: "linux" },
      modelDef,
      modelType: modelDef.type,
      modelId: "m-1",
      methodName: "run",
      definitionName: "def",
      definitionTags: {},
      definitionMeta: { id: "m-1", name: "def", version: 1, tags: {} },
      globalArgs: {},
      methodArgs: {},
      stepName: "step",
      workflowName: "wf",
    });
  return { run, shipped };
}

Deno.test("a pulled extension changed under serve is refused for dispatch until the reload, then ships its new code", async () => {
  const id = crypto.randomUUID().slice(0, 8);
  const extName = `@test/pulled-${id}`;
  const type = `@test/changed-${id}`;
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-3594-" });
  const lockfilePath = join(
    repoDir,
    "extensions",
    "models",
    "upstream_extensions.json",
  );
  const modelsDir = join(
    swampPath(repoDir, "pulled-extensions"),
    extName,
    "models",
  );
  const source = join(modelsDir, "changed.ts");
  // A pull writes the source and its pre-built bundle together.
  const pull = async (version: string) => {
    const code = modelCode(type, version);
    await Deno.writeTextFile(source, code);
    const bundleDir = join(
      swampPath(repoDir, "bundles"),
      bundleNamespace(modelsDir, repoDir),
    );
    await ensureDir(bundleDir);
    await Deno.writeTextFile(join(bundleDir, "changed.js"), code);
  };
  await ensureDir(modelsDir);
  await ensureDir(join(repoDir, "extensions", "models"));
  await Deno.writeTextFile(
    lockfilePath,
    JSON.stringify({ [extName]: { version: "1.0.0", files: [] } }),
  );
  await pull("v1");
  const catalog = new ExtensionCatalogStore(
    swampPath(repoDir, "_extension_catalog.db"),
  );
  try {
    await withMockedCommand(copyingBundler, async () => {
      const loader = new ExtensionLoader(
        new EmbeddedDenoRuntime(),
        modelKindAdapter,
        repoDir,
        undefined,
        new ExtensionRepository({
          catalog,
          lockfileRepository: await LockfileRepository.create(lockfilePath),
          repoRoot: repoDir,
        }),
      );
      modelRegistry.setTypeLoader((t, entry) =>
        loader.loadSingleType(t, entry)
      );
      // Serve's boot: the pulled type is registered.
      await reloadPulledExtensions(repoDir, lockfilePath);
      await modelRegistry.ensureTypeLoaded(type);
      const v1 = modelRegistry.get(type)!;
      assertEquals(v1.methods.run.description, "v1");

      const { run, shipped } = dispatcher(new BundleRegistry());

      // A pull, and no reload yet: serve still runs v1, so it must not
      // ship workers the v2 source.
      await pull("v2");
      await assertRejects(() => run(v1), StaleExtensionSourceError, type);
      assertEquals(shipped, []);

      // The reload a --hot-reload serve runs after the pull.
      const reload = await reloadAfterExtensionChange(repoDir, lockfilePath);
      assertEquals(reload.success, true);
      await modelRegistry.ensureTypeLoaded(type);
      const v2 = modelRegistry.get(type)!;
      assertEquals(v2.methods.run.description, "v2");

      const bundles = new BundleRegistry();
      const after = dispatcher(bundles);
      await after.run(v2);
      assertEquals(after.shipped.length, 1);
      assertStringIncludes(bundles.get(after.shipped[0])!.js, '"v2"');
    });
  } finally {
    modelRegistry.clearLoadersForTesting();
    modelRegistry.invalidateType(type);
    catalog.close();
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
});
