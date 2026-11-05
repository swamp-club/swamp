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

import { assertEquals } from "@std/assert";
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
  dependencies: string[] = [],
): Promise<string> {
  const root = join(pulledRoot, ...name.split("/"));
  const source = join(root, "models", "model.ts");
  await Deno.mkdir(join(root, "models"), { recursive: true });
  const deps = dependencies.length === 0
    ? ""
    : `dependencies:\n${dependencies.map((d) => `  - "${d}"`).join("\n")}\n`;
  await Deno.writeTextFile(
    join(root, "manifest.yaml"),
    `manifestVersion: 1\nname: "${name}"\nversion: "2026.01.01.1"\nmodels:\n  - model.ts\n${deps}`,
  );
  await Deno.writeTextFile(source, "export const model = {};\n");
  return source;
}

function registerType(rawType: string, extensionName?: string): ModelType {
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
  return type;
}

function makeCallerContext(
  repo: string,
  modelType: ModelType,
): MethodContext {
  return {
    signal: AbortSignal.timeout(30_000),
    repoDir: repo,
    modelType,
    modelId: "caller-def-id",
    globalArgs: {},
    definition: { id: "caller-def-id", name: "caller", version: 1, tags: {} },
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
  };
}

Deno.test("extension owner resolution: every pulled source is owned by the extension whose manifest the runModel check reads", async () => {
  const repo = await Deno.makeTempDir({ prefix: "swamp_owner_resolution_" });
  const pulledRoot = join(repo, ".swamp", "pulled-extensions");
  const id = crypto.randomUUID();
  const registered: ModelType[] = [];
  try {
    const packages = [
      "@swamp/ssh",
      "@swamp/gcp/gmail",
      "@swamp/gcp/workflows",
      "@swamp/aws",
      "@swamp/aws/ec2",
    ];
    const owners = new Map<string, string | undefined>();
    for (const name of packages) {
      const source = await installPackage(pulledRoot, name);
      owners.set(name, extractExtensionNameFromPath(source, repo));
    }
    for (const name of packages) {
      assertEquals(owners.get(name), name);
    }

    const callerType = registerType(
      `@swamp/gcp/gmail/users-messages-${id}`,
      owners.get("@swamp/gcp/gmail"),
    );
    const targetType = registerType(
      `@swamp/ssh/connection-${id}`,
      owners.get("@swamp/ssh"),
    );
    registered.push(callerType, targetType);
    const targetDef = Definition.create({
      name: "ssh-target",
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
              name === "ssh-target"
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

    const result = await svc.invoke(
      { definition: "ssh-target", method: "run" },
      makeCallerContext(repo, callerType),
    );
    assertEquals(result, { ok: true, resources: [] });
  } finally {
    for (const type of registered) modelRegistry.invalidateType(type);
    if (Deno.build.os === "windows") {
      await Deno.remove(repo, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(repo, { recursive: true });
    }
  }
});
