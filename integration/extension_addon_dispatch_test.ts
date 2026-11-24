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

// an add-on's members exist only in serve's registry, so a placed step can call
// them only if serve ships the add-on and the worker merges what serve resolved

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { withMockedCommand } from "@swamp-club/swamp-testing";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { ExtensionLoader } from "../src/domain/extensions/extension_loader.ts";
import {
  detachExtensionSources,
  modelKindAdapter,
  removeAttachedExtensionsForType,
} from "../src/domain/extensions/model_kind_adapter.ts";
import { resolveModelType } from "../src/domain/extensions/extension_auto_resolver.ts";
import type { DenoRuntime } from "../src/domain/runtime/deno_runtime.ts";
import {
  type DispatchParams,
  REMOTE_PROTOCOL_VERSION,
} from "../src/domain/remote/protocol.ts";
import type { RemoteStepRequest } from "../src/domain/remote/remote_dispatch.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import type { RepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { BundleRegistry } from "../src/serve/bundle_registry.ts";
import { DispatchRegistry } from "../src/serve/dispatch_registry.ts";
import {
  type DispatchGateway,
  DispatchService,
} from "../src/serve/dispatch_service.ts";
import type { WorkerSnapshot } from "../src/serve/worker_gateway.ts";
import { WorkerBundleCache } from "../src/worker/bundle_cache.ts";
import type { DataPlaneClient } from "../src/worker/data_plane_client.ts";
import { mergeExtensionMembers } from "../src/worker/extension_merge.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

const SHELL = "command/shell";

const stubDenoRuntime: DenoRuntime = {
  ensureDeno: () => Promise.resolve("/nonexistent/swamp-test/deno"),
  getDenoEnv: () => Deno.env.toObject(),
};

// sources import nothing, so a copy stands in for both the loader's bundle and
// the self-contained one serve ships
const copyingBundler = async (_cmd: string, args: string[]) => {
  const out = args[args.indexOf("-o") + 1];
  await Deno.writeTextFile(out, await Deno.readTextFile(args[args.length - 1]));
  return { stdout: "", stderr: "", code: 0 };
};

const typeSource = (type: string) =>
  `const { z } = globalThis.__swamp_zod;
export const model = {
  type: "${type}",
  version: "2026.11.24.1",
  globalArguments: z.object({}),
  resources: {},
  methods: {
    base: {
      description: "base from the type",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  },
};
`;

const addOnSource = (
  type: string,
  methods: Record<string, string>,
  withAudit = false,
) =>
  `const { z } = globalThis.__swamp_zod;
export const extension = {
  type: "${type}",
${
    withAudit
      ? `  resources: {
    audit: {
      description: "audit",
      schema: z.object({}),
      lifetime: "infinite",
      garbageCollection: 1,
    },
  },
`
      : ""
  }  methods: [${
    Object.entries(methods).map(([name, description]) =>
      `{
    ${name}: {
      description: "${description}",
      arguments: z.object({}),
      execute: async () => ({ dataHandles: [] }),
    },
  }`
    ).join(", ")
  }],
};
`;

interface Repo {
  repoDir: string;
  modelsDir: string;
  type: string;
  hello: string;
}

async function withRepo(fn: (repo: Repo) => Promise<void>): Promise<void> {
  const repoDir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp_addon_dispatch_" }),
  );
  const modelsDir = join(repoDir, "extensions", "models");
  await ensureDir(modelsDir);
  const lockfilePath = join(modelsDir, "upstream_extensions.json");
  await Deno.writeTextFile(lockfilePath, "{}");
  const type = `@test/addon-${crypto.randomUUID().slice(0, 8)}`;
  const hello = `hello_${crypto.randomUUID().slice(0, 8)}`;
  const catalog = new ExtensionCatalogStore(
    join(repoDir, ".swamp", "_extension_catalog.db"),
  );
  try {
    await withMockedCommand(copyingBundler, async () => {
      await Deno.writeTextFile(join(modelsDir, "thing.ts"), typeSource(type));
      await Deno.writeTextFile(
        join(modelsDir, "thing_extra.ts"),
        addOnSource(type, { extra: "extra from the add-on" }, true),
      );
      await Deno.writeTextFile(
        join(modelsDir, "thing_twice_a.ts"),
        addOnSource(type, { twice: "twice from a" }),
      );
      await Deno.writeTextFile(
        join(modelsDir, "thing_twice_b.ts"),
        addOnSource(type, { twice: "twice from b" }),
      );
      await Deno.writeTextFile(
        join(modelsDir, "thing_base_clash.ts"),
        addOnSource(type, { base: "base from an add-on" }),
      );
      await Deno.writeTextFile(
        join(modelsDir, "shell_hello.ts"),
        addOnSource(SHELL, { [hello]: "hello from the add-on" }),
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
      await loader.buildIndex(modelsDir, { indexOnly: true });
      modelRegistry.setTypeLoader((t, entry) =>
        loader.loadSingleType(t, entry)
      );
      modelRegistry.setExtensionAttacher((t) =>
        loader.attachPendingExtensionsForType(t)
      );
      await fn({ repoDir, modelsDir, type, hello });
    });
  } finally {
    modelRegistry.setExtensionAttacher(null);
    detachExtensionSources(SHELL, (path) => path.startsWith(repoDir));
    modelRegistry.invalidateType(type);
    removeAttachedExtensionsForType(type);
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repoDir, { recursive: true });
    }
  }
}

function harness(): {
  service: DispatchService;
  bundles: BundleRegistry;
  frames: DispatchParams[];
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
  const frames: DispatchParams[] = [];
  const gateway: DispatchGateway = {
    workers: () => [worker],
    worker: () => worker,
    dispatch: (_name, params: DispatchParams) => {
      frames.push(params);
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
  return { service, bundles, frames };
}

async function dispatch(
  h: ReturnType<typeof harness>,
  type: string,
  methodName: string,
): Promise<DispatchParams> {
  const modelType = ModelType.create(type);
  const modelDef = (await resolveModelType(type, null))!;
  const request: RemoteStepRequest = {
    placeArguments: (args) => args,
    placement: { labels: {}, platform: "linux" },
    modelDef,
    modelType,
    modelId: "m-1",
    methodName,
    definitionName: "probe",
    definitionTags: {},
    definitionMeta: { id: "m-1", name: "probe", version: 1, tags: {} },
    globalArgs: {},
    methodArgs: {},
    stepName: methodName,
    workflowName: "wf",
  };
  await h.service.executeRemote(request);
  return h.frames[h.frames.length - 1];
}

async function workerDefinition(
  bundles: BundleRegistry,
  frame: DispatchParams,
  cacheDir: string,
) {
  const client = {
    fetchBundle: (fingerprint: string) =>
      Promise.resolve(bundles.get(fingerprint)!.js),
    listAssets: () =>
      Promise.resolve({ files: [], executables: [], withheld: [] }),
  } as unknown as DataPlaneClient;
  const cache = new WorkerBundleCache(cacheDir, client);
  const loaded = await cache.load(frame.bundleFingerprint);
  const shipped = await Promise.all(
    frame.extensionBundles.map(async (bundle) => ({
      bundle,
      extension: await cache.loadExtension(bundle.fingerprint),
    })),
  );
  return {
    base: loaded.modelDef,
    merged: mergeExtensionMembers(
      loaded.modelDef,
      frame.execution.modelType,
      shipped,
    ),
  };
}

Deno.test("add-on dispatch: a local type's add-on methods and resource specs reach the worker, with serve's winner of each collision", async () => {
  await withRepo(async ({ repoDir, type }) => {
    const h = harness();
    const extra = await dispatch(h, type, "extra");
    assertEquals(
      extra.extensionBundles.map(({ methods, resources }) => ({
        methods,
        resources,
      })),
      [{ methods: ["extra"], resources: ["audit"] }],
    );
    const { base, merged } = await workerDefinition(
      h.bundles,
      extra,
      join(repoDir, "worker-cache"),
    );
    assertEquals(Object.keys(base.methods), ["base"]);
    assertEquals(Object.keys(merged.methods).sort(), ["base", "extra"]);
    assertEquals(merged.methods.base.description, "base from the type");
    assertEquals(Object.keys(merged.resources ?? {}), ["audit"]);

    // the winner's file, plus the file whose resource spec the method may write
    const twice = await dispatch(h, type, "twice");
    assertEquals(
      twice.extensionBundles.map((b) => b.methods),
      [["extra"], ["twice"]],
    );
    const fromTwice = await workerDefinition(
      h.bundles,
      twice,
      join(repoDir, "worker-cache"),
    );
    assertEquals(fromTwice.merged.methods.twice.description, "twice from a");

    // a method the type defines itself dispatches as it did before
    const own = await dispatch(h, type, "base");
    assertEquals(own.extensionBundles, []);
  });
});

Deno.test("add-on dispatch: a built-in type keeps its builtin marker and ships its add-on", async () => {
  await withRepo(async ({ repoDir, hello }) => {
    const h = harness();
    const frame = await dispatch(h, SHELL, hello);

    assertEquals(frame.bundleFingerprint, `builtin:${SHELL}`);
    assertEquals(frame.extensionBundles.length, 1);
    assertEquals(frame.extensionBundles[0].methods, [hello]);
    const { merged } = await workerDefinition(
      h.bundles,
      frame,
      join(repoDir, "worker-cache"),
    );
    assertEquals(merged.methods[hello].description, "hello from the add-on");
    // the worker's copy came from the shipped bundle, not serve's registry
    assertEquals(
      merged.methods[hello] === modelRegistry.get(SHELL)!.methods[hello],
      false,
    );
    assertEquals("execute" in merged.methods, true);
  });
});

Deno.test("add-on dispatch: an add-on edited after serve loaded it fails a dispatch of its method", async () => {
  await withRepo(async ({ modelsDir, type }) => {
    await resolveModelType(type, null);
    await Deno.writeTextFile(
      join(modelsDir, "thing_extra.ts"),
      addOnSource(type, { extra: "edited" }, true),
    );
    const h = harness();
    const error = await assertRejects(() => dispatch(h, type, "extra"));
    assertEquals((error as Error).name, "StaleExtensionSourceError");
    assertEquals(h.frames.length, 0);

    await dispatch(h, type, "base");
    assertEquals(h.frames[0].extensionBundles, []);
  });
});
