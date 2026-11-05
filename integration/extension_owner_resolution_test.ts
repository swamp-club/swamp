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
import { join } from "@std/path";
import { z } from "zod";
import { extractExtensionNameFromPath } from "../src/domain/extensions/extension_loader.ts";
import { modelRegistry } from "../src/domain/models/model.ts";
import type { MethodContext } from "../src/domain/models/model.ts";
import type { MethodExecutionService } from "../src/domain/models/method_execution_service.ts";
import type { CommonMethodContextDeps } from "../src/domain/models/method_context.ts";
import {
  ModelInvocationService,
  type ModelInvocationServiceDeps,
} from "../src/domain/models/model_invocation_service.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { VaultSecretBag } from "../src/domain/vaults/vault_secret_bag.ts";
import { SecretBagRegistry } from "../src/domain/vaults/secret_bag_registry.ts";
import { VaultService } from "../src/domain/vaults/vault_service.ts";
import { SecretLoader } from "../src/domain/vaults/secret_loader.ts";
import { ProvenanceMap } from "../src/domain/expressions/provenance_map.ts";
import { ExtensionCatalogStore } from "../src/infrastructure/persistence/extension_catalog_store.ts";
import { ExtensionRepository } from "../src/infrastructure/persistence/extension_repository.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";

type Evaluator = ModelInvocationServiceDeps["evaluationService"];
type RuntimeContext = Awaited<ReturnType<Evaluator["buildRuntimeContext"]>>;

const passthroughEvaluator: Evaluator = {
  hasDefinitionExpressions: () => false,
  evaluateDefinition: () => {
    throw new Error("no expressions to evaluate");
  },
  buildRuntimeContext: () => Promise.resolve({} as RuntimeContext),
  resolveRuntimeExpressionsInDefinition: (definition) =>
    Promise.resolve({
      definition,
      secretBag: new VaultSecretBag(new SecretBagRegistry()),
      provenance: ProvenanceMap.authored(),
    }),
  secretLoader: () =>
    new SecretLoader(() => Promise.resolve(new VaultService())),
};

async function installPackage(
  pulledRoot: string,
  name: string,
  sourceRelative = "models/model.ts",
): Promise<string> {
  const root = join(pulledRoot, ...name.split("/"));
  const source = join(root, ...sourceRelative.split("/"));
  await Deno.mkdir(join(source, ".."), { recursive: true });
  await Deno.writeTextFile(
    join(root, "manifest.yaml"),
    `manifestVersion: 1\nname: "${name}"\nversion: "2026.01.01.1"\nmodels:\n  - model.ts\n`,
  );
  await Deno.writeTextFile(source, "export const model = {};\n");
  return source;
}

interface Fixture {
  repo: string;
  pulledRoot: string;
  ownerOf: (source: string) => string | undefined;
  registerType: (rawType: string, extensionName?: string) => ModelType;
}

async function withInstalledExtensions(
  installed: readonly string[],
  fn: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const repo = await Deno.makeTempDir({ prefix: "swamp_owner_resolution_" });
  await Deno.mkdir(join(repo, ".swamp"), { recursive: true });
  const catalog = new ExtensionCatalogStore(
    join(repo, ".swamp", "_extension_catalog.db"),
  );
  const lockedVersions = Object.fromEntries(
    installed.map((name) => [name, {
      version: "2026.01.01.1",
      pulledAt: "2026-01-01T00:00:00.000Z",
    }]),
  );
  const repository = new ExtensionRepository({
    catalog,
    lockfileRepository: new LockfileRepository(
      join(repo, "upstream_extensions.json"),
      lockedVersions,
    ),
    repoRoot: repo,
  });
  const registered: ModelType[] = [];
  try {
    await fn({
      repo,
      pulledRoot: join(repo, ".swamp", "pulled-extensions"),
      ownerOf: (source) =>
        extractExtensionNameFromPath(
          source,
          repo,
          (name) => repository.isInstalledExtension(name),
        ),
      registerType: (rawType, extensionName) => {
        const type = ModelType.create(rawType);
        modelRegistry.register({
          type,
          version: "2026.01.01.1",
          globalArguments: z.object({}),
          methods: {
            run: {
              description: "owner resolution test method",
              arguments: z.object({}),
              execute: () => Promise.resolve({ dataHandles: [] }),
            },
          },
          extensionName,
        });
        registered.push(type);
        return type;
      },
    });
  } finally {
    for (const type of registered) modelRegistry.invalidateType(type);
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(repo, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repo, { recursive: true });
    }
  }
}

async function invoke(
  repo: string,
  callerType: ModelType,
  targetType: ModelType,
) {
  const targetDef = Definition.create({
    name: "target",
    type: targetType.normalized,
  });
  const executionService: MethodExecutionService = {
    execute: () => Promise.resolve({ dataHandles: [] }),
    executeWorkflow: () => Promise.resolve({ dataHandles: [] }),
  };
  const svc = new ModelInvocationService({
    executionService,
    commonDeps: {
      dataRepository: {
        findAllForModel: () => Promise.resolve([]),
        getContent: () => Promise.resolve(null),
      },
      definitionRepository: {
        findByNameGlobal: (name: string) =>
          Promise.resolve(
            name === "target"
              ? { definition: targetDef, type: targetType }
              : null,
          ),
        findById: () => Promise.resolve(null),
        save: () => Promise.resolve(),
      },
      createCelEnvironment: () =>
        ({}) as ReturnType<MethodContext["createCelEnvironment"]>,
    } as unknown as CommonMethodContextDeps,
    evaluationService: passthroughEvaluator,
    repoDir: repo,
  });
  return await svc.invoke(
    { definition: "target", method: "run" },
    {
      signal: AbortSignal.timeout(30_000),
      repoDir: repo,
      modelType: callerType,
      modelId: "caller-def-id",
      globalArgs: {},
      definition: {
        id: "caller-def-id",
        name: "caller",
        version: 1,
        tags: {},
      },
      methodName: "run",
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      } as unknown as MethodContext["logger"],
      dataRepository: {} as MethodContext["dataRepository"],
      definitionRepository: {} as MethodContext["definitionRepository"],
      extensionFile: () => "",
      createCelEnvironment: () =>
        ({}) as ReturnType<MethodContext["createCelEnvironment"]>,
    },
  );
}

const PACKAGES = [
  "@swamp/ssh",
  "@swamp/gcp/gmail",
  "@swamp/gcp/workflows",
  "@swamp/aws",
  "@swamp/aws/ec2",
];

Deno.test("extension owner resolution: every pulled source is owned by the extension whose manifest the runModel check reads", async () => {
  await withInstalledExtensions(PACKAGES, async (f) => {
    const owners = new Map<string, string | undefined>();
    for (const name of PACKAGES) {
      owners.set(name, f.ownerOf(await installPackage(f.pulledRoot, name)));
    }
    for (const name of PACKAGES) assertEquals(owners.get(name), name);

    const id = crypto.randomUUID();
    const result = await invoke(
      f.repo,
      f.registerType(
        `@swamp/gcp/gmail/users-messages-${id}`,
        owners.get("@swamp/gcp/gmail"),
      ),
      f.registerType(`@swamp/ssh/connection-${id}`, owners.get("@swamp/ssh")),
    );
    assertEquals(result, { ok: true, resources: [] });
  });
});

Deno.test("extension owner resolution: a hidden manifest naming a package subdirectory cannot grant that code an undeclared dependency", async () => {
  await withInstalledExtensions(["@evil/tools", "@victim/ops"], async (f) => {
    const hidden = await installPackage(
      f.pulledRoot,
      "@evil/tools",
      "models/sub/x.ts",
    );
    await Deno.writeTextFile(
      join(f.pulledRoot, "@evil", "tools", "models", "sub", "manifest.yaml"),
      'manifestVersion: 1\nname: "@evil/tools/models/sub"\nversion: "2026.01.01.1"\nmodels:\n  - x.ts\ndependencies:\n  - "@victim/ops"\n',
    );
    const victim = await installPackage(f.pulledRoot, "@victim/ops");
    assertEquals(f.ownerOf(hidden), "@evil/tools");

    const id = crypto.randomUUID();
    const result = await invoke(
      f.repo,
      f.registerType(`@evil/sub-${id}`, f.ownerOf(hidden)),
      f.registerType(`@victim/ops-${id}`, f.ownerOf(victim)),
    );
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, `add "@victim/ops"`);
    }
  });
});
