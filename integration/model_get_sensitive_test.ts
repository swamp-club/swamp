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

/**
 * Integration test for sensitive-argument redaction in `swamp model get`.
 *
 * Exercises the full read path: a literal sensitive global argument is persisted
 * to disk via the real YamlDefinitionRepository, loaded back through the libswamp
 * modelGet application service (which applies the shared redactSensitiveValues
 * primitive), and projected by both the log and JSON renderers. Confirms the
 * secret never reaches output in either mode, while non-sensitive values do.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";
import {
  consumeStream,
  modelGet,
  type ModelGetData,
  type ModelGetDeps,
  type ModelGetEvent,
} from "../src/libswamp/mod.ts";
import { createModelGetRenderer } from "../src/presentation/renderers/model_get.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { YamlDefinitionRepository } from "../src/infrastructure/persistence/yaml_definition_repository.ts";
import { findDefinitionByIdOrName } from "../src/domain/models/model_lookup.ts";
import { initializeTestRepo } from "./test_helpers.ts";

const SECRET = "SUPERSECRET123";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-model-get-sensitive-" });
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

/** A minimal model type whose global args carry one sensitive field. */
const modelDef = {
  type: ModelType.create("test/sensitive-get"),
  version: "2026.05.28.1",
  globalArguments: z.object({
    apiKey: z.string().meta({ sensitive: true }),
    region: z.string(),
  }),
  methods: {},
};

async function captureRender(
  data: ModelGetData,
  mode: "log" | "json",
): Promise<string> {
  async function* stream(): AsyncGenerator<ModelGetEvent> {
    yield { kind: "resolving" };
    yield { kind: "completed", data };
  }

  const logs: string[] = [];
  const originalLog = console.log;
  // Both the log renderer (via writeOutput) and the JSON renderer emit through
  // console.log, so capturing it covers both modes.
  console.log = (msg: string) => logs.push(msg);
  try {
    const renderer = createModelGetRenderer(mode);
    await consumeStream(stream(), renderer.handlers());
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n");
}

Deno.test("Integration: model get redacts a literal sensitive global argument in both output modes", async () => {
  await withTempDir(async (repoDir) => {
    await initializeTestRepo(repoDir);

    // Persist a definition with a literal sensitive value (not a vault.get expr).
    const definitionRepo = new YamlDefinitionRepository(repoDir);
    const definition = Definition.create({
      name: "leaky-model",
      globalArguments: { apiKey: SECRET, region: "us-east-1" },
      methods: {},
    });
    await definitionRepo.save(modelDef.type, definition);

    // Real lookup from disk; the model type schema supplies the sensitive flag.
    const deps: ModelGetDeps = {
      lookupDefinition: (idOrName) =>
        findDefinitionByIdOrName(definitionRepo, idOrName),
      getModelDef: () => modelDef,
    };

    const events: ModelGetEvent[] = [];
    await consumeStream(
      modelGet(createLibSwampContext(), deps, "leaky-model"),
      {
        resolving: () => {},
        completed: (e) => {
          events.push(e);
        },
        error: (e) => {
          throw new Error(`unexpected error: ${e.error.message}`);
        },
      },
    );

    const completed = events[0];
    if (!completed || completed.kind !== "completed") {
      throw new Error("expected a completed event");
    }

    // The read model carries the redacted value, not the secret.
    assertEquals(completed.data.globalArguments, {
      apiKey: "***",
      region: "us-east-1",
    });

    // The secret still lives unredacted in the persisted definition — redaction
    // happens at the read layer, so reloading the stored definition still shows
    // the literal value.
    const reloaded = await findDefinitionByIdOrName(
      definitionRepo,
      "leaky-model",
    );
    assertEquals(reloaded?.definition.globalArguments.apiKey, SECRET);

    // Neither renderer emits the secret; both show "***" and the region.
    for (const mode of ["log", "json"] as const) {
      const output = await captureRender(completed.data, mode);
      assertStringIncludes(output, "***");
      assertStringIncludes(output, "us-east-1");
      assertEquals(
        output.includes(SECRET),
        false,
        `${mode} output leaked the secret`,
      );
    }
  });
});
