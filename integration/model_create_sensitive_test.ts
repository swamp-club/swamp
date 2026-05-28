// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

/**
 * Integration test for the secrets-at-rest guard (swamp-club#480).
 *
 * Exercises the real create path end-to-end against a real
 * YamlDefinitionRepository on disk: a literal value for a `{ sensitive: true }`
 * global argument is refused (and nothing is written), while a `vault.get(...)`
 * expression is persisted verbatim. Also drives the persistence chokepoint
 * directly to prove that an out-of-band writer (e.g. a different command or a
 * datastore sync) cannot land a literal secret on disk either.
 */

import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { z } from "zod";
import {
  consumeStream,
  createLibSwampContext,
  modelCreate,
  type ModelCreateDeps,
  type ModelCreateEvent,
} from "../src/libswamp/mod.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { defineModel } from "../src/domain/models/model.ts";
import { UserError } from "../src/domain/errors.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import type { ModelDefinition } from "../src/domain/models/model.ts";
import { initializeTestRepo } from "./test_helpers.ts";

const SENSITIVE_CREATE_TYPE = ModelType.create("test/sensitive-create");

// Registered in the global registry so the persistence chokepoint
// (YamlDefinitionRepository.save) can resolve the sensitive-field schema.
const modelDef = defineModel({
  type: SENSITIVE_CREATE_TYPE,
  version: "2026.05.29.1",
  globalArguments: z.object({
    apiKey: z.string().meta({ sensitive: true }),
    token: z.string().min(20).meta({ sensitive: true }).optional(),
    region: z.string(),
  }),
  methods: {},
}) as unknown as ModelDefinition;

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({
    prefix: "swamp-model-create-sensitive-",
  });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** Wires the real YamlDefinitionRepository into ModelCreateDeps. */
function realDeps(repo: YamlDefinitionRepository): ModelCreateDeps {
  return {
    resolveModelType: () => Promise.resolve(modelDef),
    findByNameGlobal: async (name) =>
      (await repo.findByNameGlobal(name)) !== null,
    getModelDef: () => modelDef,
    createAndSave: async (type, name, typeVersion, globalArguments) => {
      const definition = Definition.create({
        name,
        type: type.normalized,
        typeVersion,
        globalArguments,
      });
      await repo.save(type, definition);
      return definition;
    },
    getPath: (type, id) => repo.getPath(type, id),
    listAvailableTypes: () => [SENSITIVE_CREATE_TYPE.normalized],
  };
}

async function runCreate(
  deps: ModelCreateDeps,
  name: string,
  globalArguments: Record<string, unknown>,
): Promise<ModelCreateEvent[]> {
  const events: ModelCreateEvent[] = [];
  await consumeStream(
    modelCreate(createLibSwampContext(), deps, {
      typeArg: SENSITIVE_CREATE_TYPE.normalized,
      name,
      globalArguments,
    }),
    {
      creating: () => {},
      completed: (e) => {
        events.push(e);
      },
      error: (e) => {
        events.push(e);
      },
    },
  );
  return events;
}

Deno.test("Integration: model create refuses a literal sensitive global arg and writes no YAML", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const repo = new YamlDefinitionRepository(repoDir);

    const events = await runCreate(realDeps(repo), "leaky", {
      apiKey: "SUPERSECRET123",
      region: "us-east-1",
    });

    const last = events[events.length - 1];
    assertEquals(last.kind, "error");

    // Nothing was persisted — the secret never reached disk.
    assertEquals(await repo.findByNameGlobal("leaky"), null);
  });
});

Deno.test("Integration: model create persists a vault.get expression verbatim", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const repo = new YamlDefinitionRepository(repoDir);
    const expr = "${{ vault.get('creds', 'apiKey') }}";

    const events = await runCreate(realDeps(repo), "vaulted", {
      apiKey: expr,
      region: "us-east-1",
    });

    assertEquals(events[events.length - 1].kind, "completed");

    const stored = await repo.findByNameGlobal("vaulted");
    assertNotEquals(stored, null);
    assertEquals(stored!.definition.globalArguments.apiKey, expr);
  });
});

Deno.test("Integration: model create accepts a vault.get expression for a constrained sensitive field (ADV-3)", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const repo = new YamlDefinitionRepository(repoDir);
    // The sentinel is shorter than the field's min(20); it must be accepted
    // because expression fields are not schema-validated at create time.
    const events = await runCreate(realDeps(repo), "constrained", {
      apiKey: "${{ vault.get('creds', 'apiKey') }}",
      token: "${{ vault.get('creds', 'token') }}",
      region: "us-east-1",
    });

    assertEquals(events[events.length - 1].kind, "completed");
    assertNotEquals(await repo.findByNameGlobal("constrained"), null);
  });
});

Deno.test("Integration: the persistence chokepoint blocks an out-of-band writer", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);
    const repo = new YamlDefinitionRepository(repoDir);

    // Simulate a writer that bypasses model create's early check (e.g. a
    // different command path). The save() chokepoint must still refuse it.
    const definition = Definition.create({
      name: "smuggled",
      type: SENSITIVE_CREATE_TYPE.normalized,
      globalArguments: { apiKey: "SUPERSECRET123", region: "us-east-1" },
    });

    await assertRejects(
      () => repo.save(SENSITIVE_CREATE_TYPE, definition),
      UserError,
    );
    assertEquals(await repo.findByNameGlobal("smuggled"), null);
  });
});
