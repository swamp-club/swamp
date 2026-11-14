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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { z } from "zod";
import { type ModelDefinition, modelRegistry } from "../domain/models/model.ts";
import { ModelType } from "../domain/models/model_type.ts";
import { findDefinitionByIdOrName } from "../domain/models/model_lookup.ts";
import { YamlDefinitionRepository } from "../infrastructure/persistence/yaml_definition_repository.ts";
import { createDirectTypeResolver } from "./direct_type_resolver.ts";

interface Fixture {
  type: string;
  resolve: ReturnType<typeof createDirectTypeResolver>;
  storedGlobals: (name: string) => Promise<Record<string, unknown>>;
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-direct-resolver-" });
  const type = `test/direct-resolver-${crypto.randomUUID()}`;
  modelRegistry.register({
    type: ModelType.create(type),
    version: "2026.01.01.1",
    globalArguments: z.object({ repoPath: z.string().default(".") }),
    resources: {},
    methods: {
      status: {
        description: "status",
        arguments: z.object({ verbose: z.boolean().optional() }),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  } as unknown as ModelDefinition);
  const autoDefinitionsDir = join(repoDir, ".swamp", "auto-definitions");
  const repoFor = () =>
    new YamlDefinitionRepository(
      repoDir,
      undefined,
      undefined,
      autoDefinitionsDir,
    );
  try {
    await fn({
      type,
      resolve: createDirectTypeResolver(repoDir, {
        definitionRepo: repoFor(),
        autoDefinitionsDir,
        markDirty: undefined,
      }),
      storedGlobals: async (name) => {
        const found = await findDefinitionByIdOrName(repoFor(), name);
        if (!found) throw new Error(`no stored definition ${name}`);
        return found.definition.globalArguments as Record<string, unknown>;
      },
    });
  } finally {
    modelRegistry.invalidateType(type);
    const cleanup = Deno.remove(repoDir, { recursive: true });
    await (Deno.build.os === "windows" ? cleanup.catch(() => {}) : cleanup);
  }
}

Deno.test("createDirectTypeResolver: a new definition is created with the step's globalArgs", async () => {
  await withFixture(async (f) => {
    const result = await f.resolve(
      f.type,
      "probe",
      "status",
      {},
      { repoPath: "/checkouts/a" },
      "unrestricted",
    );
    assertEquals(result.created, true);
    assertEquals(result.definition.globalArguments, {
      repoPath: "/checkouts/a",
    });
    assertEquals(await f.storedGlobals("probe"), { repoPath: "/checkouts/a" });
  });
});

Deno.test("createDirectTypeResolver: globalArgs replace a stored definition's older values", async () => {
  await withFixture(async (f) => {
    await f.resolve(f.type, "probe", "status", {}, {
      repoPath: "/checkouts/b",
    }, "unrestricted");
    const result = await f.resolve(
      f.type,
      "probe",
      "status",
      {},
      { repoPath: "/checkouts/a" },
      "unrestricted",
    );
    assertEquals(result.created, false);
    assertEquals(result.definition.globalArguments, {
      repoPath: "/checkouts/a",
    });
    assertEquals(await f.storedGlobals("probe"), { repoPath: "/checkouts/a" });
  });
});

Deno.test("createDirectTypeResolver: without globalArgs, inputs are routed by schema", async () => {
  await withFixture(async (f) => {
    const result = await f.resolve(
      f.type,
      "probe",
      "status",
      { repoPath: "/checkouts/a", verbose: true },
      undefined,
      "unrestricted",
    );
    assertEquals(result.definition.globalArguments, {
      repoPath: "/checkouts/a",
    });
    assertEquals(result.routedMethodInputs, { verbose: true });
  });
});

Deno.test("createDirectTypeResolver: refuses an unknown behavior type", async () => {
  await withFixture(async (f) => {
    await assertRejects(
      () =>
        f.resolve(
          `test/missing-${crypto.randomUUID()}`,
          "probe",
          "status",
          {},
          undefined,
          "unrestricted",
        ),
      Error,
      "Unknown behavior type",
    );
  });
});

Deno.test("createDirectTypeResolver: a leading @ resolves to the type registered without it", async () => {
  await withFixture(async (f) => {
    const result = await f.resolve(
      `@${f.type}`,
      "probe",
      "status",
      {},
      { repoPath: "/checkouts/a" },
      "unrestricted",
    );
    assertEquals(result.modelType.normalized, f.type);
    assertEquals(result.definition.globalArguments, {
      repoPath: "/checkouts/a",
    });
  });
});
