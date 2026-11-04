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

import { assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { withMockedCommand } from "@swamp-club/swamp-testing";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { ExtensionLoader } from "../src/domain/extensions/extension_loader.ts";
import { modelKindAdapter } from "../src/domain/extensions/model_kind_adapter.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";
import {
  type DispatchParams,
  REMOTE_PROTOCOL_VERSION,
} from "../src/domain/remote/protocol.ts";
import type { RemoteStepRequest } from "../src/domain/remote/remote_dispatch.ts";
import { canonicalizePath } from "../src/infrastructure/persistence/canonicalize_path.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import {
  BundleRegistry,
  hashAssetBytes,
} from "../src/serve/bundle_registry.ts";
import { DispatchRegistry } from "../src/serve/dispatch_registry.ts";
import {
  type DispatchGateway,
  DispatchService,
} from "../src/serve/dispatch_service.ts";
import type { WorkerSnapshot } from "../src/serve/worker_gateway.ts";
import "../src/domain/models/models.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const stubDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve("/nonexistent/swamp-test/deno"),
  getDenoEnv: () => Deno.env.toObject(),
};

const copyingBundler = async (_cmd: string, args: string[]) => {
  const out = args[args.indexOf("-o") + 1];
  await Deno.writeTextFile(out, await Deno.readTextFile(args[args.length - 1]));
  return { stdout: "", stderr: "", code: 0 };
};

const modelCode = (type: string) =>
  `const { z } = globalThis.__swamp_zod;
export const model = {
  type: "${type}",
  version: "2026.11.02.1",
  globalArguments: z.object({}),
  resources: {},
  methods: {
    run: {
      description: "reads a shipped script",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

const manifest = (files: string[]) =>
  [
    "manifestVersion: 1",
    "name: '@test/assets'",
    "version: '2026.11.02.1'",
    "models:",
    "  - runner.ts",
    "additionalFiles:",
    ...files.map((f) => `  - ${f}`),
    "",
  ].join("\n");

function dispatchHarness(): {
  service: DispatchService;
  bundles: BundleRegistry;
  fingerprints: string[];
} {
  const worker: WorkerSnapshot = {
    name: "w1",
    instanceUuid: "uuid-w1",
    labels: {},
    platform: "linux",
    arch: "x86_64",
    swampVersion: "1.0.0",
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    status: "idle",
    connected: true,
    capacity: 1,
    activeDispatchIds: [],
  };
  const fingerprints: string[] = [];
  const gateway: DispatchGateway = {
    workers: () => [worker],
    worker: () => worker,
    dispatch: (_name, params: DispatchParams) => {
      fingerprints.push(params.bundleFingerprint);
      return Promise.resolve({
        status: "success",
        outputs: [],
        logs: [],
        durationMs: 1,
      });
    },
  };
  const bundles = new BundleRegistry();
  const service = new DispatchService({
    repoDir: "/tmp/unused",
    repoContext: {} as RepositoryContext,
    dispatches: new DispatchRegistry(),
    bundles,
    runModelMethod: () => Promise.resolve(),
  });
  service.bindGateway(gateway);
  return { service, bundles, fingerprints };
}

Deno.test("serve ships a file newly declared in a local extension's manifest on the next dispatch, with no reload", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-4282-assets-" });
  const type = `@test/assets-${crypto.randomUUID().slice(0, 8)}`;
  const modelType = ModelType.create(type);
  const modelsDir = join(dir, "extensions", "models");
  const lockfilePath = join(modelsDir, "upstream_extensions.json");
  await Deno.mkdir(join(modelsDir, "scripts"), { recursive: true });
  await Deno.writeTextFile(lockfilePath, "{}");
  await Deno.writeTextFile(join(modelsDir, "runner.ts"), modelCode(type));
  await Deno.writeTextFile(
    join(modelsDir, "manifest.yaml"),
    manifest([
      "scripts/a.py",
    ]),
  );
  await Deno.writeTextFile(join(modelsDir, "scripts", "a.py"), "print('a')");
  await Deno.writeTextFile(join(modelsDir, "scripts", "secret.py"), "nope");
  const catalog = new ExtensionCatalogStore(
    join(dir, ".swamp", "_extension_catalog.db"),
  );
  try {
    await withMockedCommand(copyingBundler, async () => {
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
      const modelDef = await modelRegistry.getOrLoad(modelType);
      assertNotEquals(modelDef, undefined);

      const h = dispatchHarness();
      const request: RemoteStepRequest = {
        placeArguments: (args) => args,
        placement: { labels: {}, platform: "linux" },
        modelDef: modelDef!,
        modelType,
        modelId: "m-1",
        methodName: "run",
        definitionName: "assets",
        definitionTags: {},
        definitionMeta: { id: "m-1", name: "assets", version: 1, tags: {} },
        globalArgs: {},
        methodArgs: {},
        stepName: "build",
        workflowName: "wf",
      };
      await h.service.executeRemote(request);

      await Deno.writeTextFile(
        join(modelsDir, "scripts", "b.py"),
        "print('b')",
      );
      await Deno.writeTextFile(
        join(modelsDir, "manifest.yaml"),
        manifest(["scripts/a.py", "scripts/b.py"]),
      );
      assertEquals(modelRegistry.get(modelType), modelDef);
      await h.service.executeRemote(request);

      const [before, after] = h.fingerprints;
      assertNotEquals(after, before);
      const hash = (text: string) =>
        hashAssetBytes(new TextEncoder().encode(text));
      assertEquals(h.bundles.get(before)?.additionalFiles, ["scripts/a.py"]);
      assertEquals(
        h.bundles.get(before)?.assetHashes,
        new Map([["scripts/a.py", await hash("print('a')")]]),
      );
      const shipped = h.bundles.get(after);
      assertEquals(
        canonicalizePath(shipped?.filesRoot ?? ""),
        canonicalizePath(modelsDir),
      );
      assertEquals(shipped?.additionalFiles, ["scripts/a.py", "scripts/b.py"]);
      assertEquals(
        shipped?.assetHashes,
        new Map([
          ["scripts/a.py", await hash("print('a')")],
          ["scripts/b.py", await hash("print('b')")],
        ]),
      );
    });
  } finally {
    modelRegistry.invalidateType(type);
    modelRegistry.clearLoadersForTesting();
    catalog.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
