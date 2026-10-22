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
 * The evaluated-definition cache on the real repository, for a sensitive
 * argument whose value came from the run's inputs rather than a vault
 * (swamp-club#3681): the domain builds the persisted form, the repository
 * writes it, and the file holds the mask beside the vault reference of the
 * value that did come from a vault. Read back, the replay predicate names
 * the masked path, the vault value still rehydrates, and a write that skips
 * the domain builder is refused at the repository.
 */

import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { walk } from "@std/fs";
import { z } from "zod";
import { modelRegistry } from "../src/domain/models/model.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Definition } from "../src/domain/definitions/definition.ts";
import { UserError } from "../src/domain/errors.ts";
import {
  RunSensitiveValues,
  vaultReferenceText,
} from "../src/domain/secrets/mod.ts";
import { VaultSecretBag } from "../src/domain/vaults/vault_secret_bag.ts";
import {
  findPlaintextSensitiveArguments,
  persistEvaluatedDefinition,
  rehydrateEvaluatedDefinition,
} from "../src/domain/expressions/persisted_evaluation.ts";
import {
  keyPath,
  ProvenanceMap,
} from "../src/domain/expressions/provenance_map.ts";
import { YamlEvaluatedDefinitionRepository } from "../src/infrastructure/persistence/yaml_evaluated_definition_repository.ts";

const INPUT_VALUE = "REPRO-SECRET-7c1e";
const VAULT_VALUE = "VAULT-CTRL-9a9a";
const SOURCE = { vaultName: "prod", key: "api-token" };

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-evaluated-cache-" });
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

/** A type with two sensitive globals and one sensitive method argument. */
function registerType(): ModelType {
  const type = ModelType.create(
    `@test/sensitive-global-arg-${crypto.randomUUID().slice(0, 8)}`,
  );
  modelRegistry.register({
    type,
    version: "2026.05.29.1",
    globalArguments: z.object({
      apiKey: z.string().meta({ sensitive: true }),
      token: z.string().meta({ sensitive: true }),
      region: z.string(),
    }),
    methods: {
      execute: {
        description: "Uses the key",
        arguments: z.object({
          secret: z.string().meta({ sensitive: true }).optional(),
        }),
        execute: () => Promise.resolve({ dataHandles: [] }),
      },
    },
  });
  return type;
}

async function filesHolding(dir: string, text: string): Promise<string[]> {
  const hits: string[] = [];
  for await (const entry of walk(dir, { includeDirs: false })) {
    if ((await Deno.readTextFile(entry.path)).includes(text)) {
      hits.push(entry.path);
    }
  }
  return hits;
}

Deno.test("evaluated cache: an input-fed sensitive argument is written as the mask beside a vault reference, reads back as not replayable, and the vault value still rehydrates (swamp-club#3681)", async () => {
  await withTempDir(async (dir) => {
    const type = registerType();
    try {
      const modelDef = modelRegistry.get(type);
      if (!modelDef) throw new Error("type not registered");
      const values = new RunSensitiveValues();
      const bag = new VaultSecretBag(values.sentinels);
      const sentinel = bag.addDataSecret(VAULT_VALUE, SOURCE);
      // The copy that executes: the input value in clear, the vault value as
      // the sentinel its sensitive data read issued.
      const executed = Definition.create({
        name: "input-svc",
        type: type.normalized,
        globalArguments: {
          apiKey: INPUT_VALUE,
          token: sentinel,
          region: "eu-west-1",
        },
        methods: { execute: { arguments: { secret: INPUT_VALUE } } },
      });
      const source = Definition.fromData({
        ...executed.toData(),
        globalArguments: {
          apiKey: "${{ inputs.key }}",
          token: "${{ data.latest('db', 'creds').attributes.token }}",
          region: "eu-west-1",
        },
        methods: { execute: { arguments: { secret: "${{ inputs.key }}" } } },
      });
      const persisted = persistEvaluatedDefinition(
        executed,
        [],
        source,
        values,
        modelDef,
      );
      const repo = new YamlEvaluatedDefinitionRepository(dir);
      await repo.save(
        type,
        persisted.definition,
        ProvenanceMap.authored(),
        new Set(["${{ inputs.key }}"]),
        persisted.deferredExpressions,
        persisted.writtenReferences,
        persisted.maskedPaths,
        persisted.persistedProvenance,
      );

      assertEquals(await filesHolding(dir, INPUT_VALUE), []);
      assertEquals(await filesHolding(dir, VAULT_VALUE), []);

      const cached = await repo.findByNameWithProvenance(type, "input-svc");
      if (!cached) throw new Error("evaluated definition not found");
      assertEquals(cached.persistedProvenance === "unreadable", false);
      assertEquals(
        cached.persistedProvenance &&
          cached.persistedProvenance !== "unreadable"
          ? cached.persistedProvenance.toData()
          : undefined,
        persisted.persistedProvenance.toData(),
      );
      assertEquals(cached.definition.globalArguments, {
        apiKey: "***",
        token: vaultReferenceText(SOURCE),
        region: "eu-west-1",
      });
      assertEquals(cached.definition.getMethodArguments("execute"), {
        secret: "***",
      });
      assertEquals(
        findPlaintextSensitiveArguments(
          modelDef,
          cached.definition.toData(),
          cached.writtenReferences,
        ),
        ["globalArguments.apiKey", "methods.execute.arguments.secret"],
      );
      // The file records the masked positions, and they alone refuse a
      // replay under a type that no longer marks the fields.
      assertEquals(cached.maskedPaths, [
        ["globalArguments", "apiKey"],
        ["methods", "execute", "arguments", "secret"],
      ]);
      assertEquals(
        findPlaintextSensitiveArguments(
          { methods: {} },
          cached.definition.toData(),
          cached.writtenReferences,
          { recordedMasks: cached.maskedPaths },
        ),
        ["globalArguments.apiKey", "methods.execute.arguments.secret"],
      );

      const replayValues = new RunSensitiveValues();
      const stepBag = new VaultSecretBag(replayValues.sentinels);
      const restored = await rehydrateEvaluatedDefinition(
        cached,
        () => Promise.resolve(VAULT_VALUE),
        replayValues,
        stepBag,
      );
      assertEquals(restored.definition.globalArguments.token, VAULT_VALUE);
      assertEquals(restored.definition.globalArguments.apiKey, "***");

      // A write that skips persistEvaluatedDefinition is refused at the
      // repository and leaves no file.
      const leaky = Definition.create({
        name: "leaky",
        type: type.normalized,
        globalArguments: { apiKey: INPUT_VALUE, token: "", region: "eu" },
      });
      const error = await assertRejects(
        () => repo.save(type, leaky, ProvenanceMap.authored()),
        UserError,
      );
      assertStringIncludes(error.message, "'globalArguments.apiKey'");
      assertEquals(error.message.includes(INPUT_VALUE), false);
      assertEquals(await repo.findByName(type, "leaky"), null);
      assertEquals(await filesHolding(dir, INPUT_VALUE), []);
      for (
        const apiKey of ["${{ env.TOKEN }}", `${INPUT_VALUE}\${{ env.TOKEN }}`]
      ) {
        const bypass = Definition.create({
          name: "bypass",
          type: type.normalized,
          globalArguments: { apiKey, token: "", region: "eu" },
        });
        await assertRejects(
          () =>
            repo.save(
              type,
              bypass,
              ProvenanceMap.authored().withWholeData("globalArguments.apiKey"),
            ),
          UserError,
        );
        assertEquals(await repo.findByName(type, "bypass"), null);
      }
      const mixedReference = Definition.create({
        name: "mixed-reference",
        globalArguments: {
          apiKey: `${INPUT_VALUE}${vaultReferenceText(SOURCE)}`,
          token: "",
          region: "eu",
        },
      });
      await assertRejects(
        () =>
          repo.save(
            type,
            mixedReference,
            ProvenanceMap.authored().withRanges("globalArguments.apiKey", [[
              0,
              INPUT_VALUE.length,
            ]]),
            undefined,
            [],
            [{
              path: ["globalArguments", "apiKey"],
              occurrence: 0,
              ...SOURCE,
              encoding: "raw",
              dataOrigin: true,
            }],
          ),
        UserError,
      );
      assertEquals(await repo.findByName(type, "mixed-reference"), null);
    } finally {
      modelRegistry.invalidateType(type);
    }
  });
});

Deno.test("evaluated cache: sensitive input keys do not survive in values, provenance, or refusal paths", async () => {
  await withTempDir(async (dir) => {
    const type = ModelType.create(
      `@test/container-keys-${crypto.randomUUID()}`,
    );
    const schemas = {
      globalArguments: z.object({
        creds: z.record(z.string(), z.unknown()).meta({ sensitive: true }),
      }),
      methods: {},
    };
    modelRegistry.register({ type, version: "2026.01.01.1", ...schemas });
    try {
      const executed = Definition.create({
        name: "key-svc",
        type: type.normalized,
        globalArguments: {
          creds: { [INPUT_VALUE]: "${{ vault.get('prod', 'value') }}" },
        },
      });
      const provenance = ProvenanceMap.authored().withWholeData(
        keyPath("globalArguments.creds", INPUT_VALUE),
      );
      const persisted = persistEvaluatedDefinition(
        executed,
        [],
        executed,
        new RunSensitiveValues(),
        schemas,
        provenance,
      );
      assertEquals(persisted.definition.globalArguments, { creds: "***" });
      assertEquals(persisted.maskedPaths, [["globalArguments", "creds"]]);
      const repo = new YamlEvaluatedDefinitionRepository(dir);
      await repo.save(
        type,
        persisted.definition,
        provenance,
        undefined,
        persisted.deferredExpressions,
        persisted.writtenReferences,
        persisted.maskedPaths,
        persisted.persistedProvenance,
      );
      assertEquals(await filesHolding(dir, INPUT_VALUE), []);
      const cache = await repo.findByNameWithProvenance(type, executed.name);
      assertExists(cache);
      assertEquals(
        findPlaintextSensitiveArguments(
          schemas,
          cache.definition.toData(),
          cache.writtenReferences,
          {
            recordedMasks: cache.maskedPaths,
          },
        ),
        ["globalArguments.creds"],
      );
      const error = await assertRejects(
        () => repo.save(type, executed, provenance),
        UserError,
      );
      assertEquals(error.message.includes(INPUT_VALUE), false);
    } finally {
      modelRegistry.invalidateType(type);
    }
  });
});
