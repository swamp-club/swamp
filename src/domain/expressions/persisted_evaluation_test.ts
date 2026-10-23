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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { z } from "zod";
import { Definition } from "../definitions/definition.ts";
import {
  RunSensitiveValues,
  vaultReferenceText,
  type WrittenReference,
} from "../secrets/mod.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import {
  holdsValue,
  SecretBagRegistry,
} from "../vaults/secret_bag_registry.ts";
import { UserError } from "../errors.ts";
import { keyPath, ProvenanceMap } from "./provenance_map.ts";
import { deferredExpressionReference } from "./deferred_expression.ts";
import {
  type ArgumentSchemas,
  evaluatedCacheHoldsSensitiveArgumentsMessage,
  findPlaintextSensitiveArguments,
  isNewerSensitiveFormat,
  maskSensitiveArgumentsForDisplay,
  mayHoldPlaintextSensitiveValues,
  persistEvaluatedDefinition,
  plaintextSensitiveArgumentsMessage,
  rehydrateEvaluatedDefinition,
  withWrittenReferenceRanges,
} from "./persisted_evaluation.ts";
import { SENSITIVE_FORMAT_VERSION } from "../secrets/persisted_sensitive_form.ts";

const SECRET = "Pl41n-s3cret";
const SOURCE = { vaultName: "prod", key: "api-token" };
const REF = vaultReferenceText(SOURCE);
/** A type that marks nothing sensitive. */
const NO_SCHEMAS: ArgumentSchemas = { methods: {} };

function recorded(): RunSensitiveValues {
  const values = new RunSensitiveValues();
  values.addSecret(SECRET, SOURCE);
  return values;
}

Deno.test("persistEvaluatedDefinition: an empty deferred scope does not prevent replacement of a masked argument", () => {
  const schemas = {
    methods: {
      run: {
        arguments: z.object({
          token: z.string().meta({ sensitive: true }),
          note: z.string(),
        }),
      },
    },
  };
  for (const bindings of [{}, { workflowRunId: crypto.randomUUID() }]) {
    const id = crypto.randomUUID();
    const definition = Definition.create({
      name: "safe-deferred",
      methods: {
        run: {
          arguments: { token: SECRET, note: deferredExpressionReference(id) },
        },
      },
    });
    const persisted = persistEvaluatedDefinition(
      definition,
      [{ id, expression: "${{ env.NOTE }}", bindings }],
      definition,
      new RunSensitiveValues(),
      schemas,
    );
    assertEquals(persisted.deferredExpressions[0].bindings, bindings);
    assertEquals(persisted.maskedPaths, [[
      "methods",
      "run",
      "arguments",
      "token",
    ]]);
    assertEquals(
      findPlaintextSensitiveArguments(
        schemas,
        persisted.definition.toData(),
        [],
        {
          recordedMasks: persisted.maskedPaths,
          method: { name: "run", replaced: ["token"] },
        },
      ),
      [],
    );
  }
});

Deno.test("persistEvaluatedDefinition: recorded masks never read inherited argument properties", () => {
  const definition = Definition.create({
    name: "own-arguments",
    globalArguments: {},
  });
  const persisted = persistEvaluatedDefinition(
    definition,
    [],
    definition,
    new RunSensitiveValues(),
    NO_SCHEMAS,
    ProvenanceMap.authored(),
    [],
    [["globalArguments", "toString"]],
  );
  assertEquals(persisted.maskedPaths, []);
  assertEquals(
    Object.hasOwn(persisted.definition.globalArguments, "toString"),
    false,
  );
});

Deno.test("persistEvaluatedDefinition: captured input object keys are sensitive even with null leaves", () => {
  const id = crypto.randomUUID();
  const definition = Definition.create({
    name: "deferred-keys",
    globalArguments: { token: deferredExpressionReference(id) },
  });
  const persisted = persistEvaluatedDefinition(
    definition,
    [{
      id,
      expression: "${{ inputs.creds.keys()[0] + env.SUFFIX }}",
      bindings: { inputs: { creds: { [SECRET]: null } } },
      provenance: ProvenanceMap.authored().withWholeData("inputs.creds")
        .toData(),
    }],
    definition,
    new RunSensitiveValues(),
    {
      globalArguments: z.object({
        token: z.string().meta({ sensitive: true }),
      }),
      methods: {},
    },
  );
  assertEquals(persisted.definition.globalArguments.token, "***");
  assertEquals(persisted.deferredExpressions[0].bindings, {});
  assertEquals(
    JSON.stringify([
      persisted.definition.toData(),
      persisted.deferredExpressions,
      persisted.persistedProvenance.toData(),
      persisted.maskedPaths,
    ]).includes(SECRET),
    false,
  );
});

Deno.test("persistEvaluatedDefinition: input arrays preserve vault references but mask data object keys", () => {
  const values = recorded();
  const sentinel = new VaultSecretBag(values.sentinels).addDataSecret(
    SECRET,
    SOURCE,
  );
  const schemas = {
    globalArguments: z.object({
      tokens: z.array(z.unknown()).meta({ sensitive: true }),
    }),
    methods: {},
  };
  for (const tokens of [[sentinel], [{ [INPUT_VALUE]: null }]]) {
    const definition = Definition.create({
      name: "input-array",
      globalArguments: { tokens },
    });
    const persisted = persistEvaluatedDefinition(
      definition,
      [],
      definition,
      values,
      schemas,
      ProvenanceMap.authored().withWholeData("globalArguments.tokens"),
    );
    assertEquals(
      persisted.definition.globalArguments.tokens,
      typeof tokens[0] === "string" ? [REF] : "***",
    );
    assertEquals(
      persisted.maskedPaths,
      typeof tokens[0] === "string" ? [] : [["globalArguments", "tokens"]],
    );
  }
});

Deno.test("persistEvaluatedDefinition: a sensitive whole-input map removes forwarded key names too", () => {
  const source = Definition.create({
    name: "input-map",
    globalArguments: { creds: "${{ inputs }}" },
  });
  const executed = Definition.create({
    name: "input-map",
    globalArguments: { creds: { [SECRET]: null } },
    methods: { run: { arguments: { [SECRET]: null } } },
  });
  const persisted = persistEvaluatedDefinition(
    executed,
    [],
    source,
    new RunSensitiveValues(),
    {
      globalArguments: z.object({
        creds: z.record(z.string(), z.unknown()).meta({ sensitive: true }),
      }),
      methods: { run: { arguments: z.record(z.string(), z.unknown()) } },
    },
    ProvenanceMap.authored().withWholeData("globalArguments.creds"),
    [["methods", "run", "arguments", SECRET]],
  );
  assertEquals(persisted.definition.globalArguments, { creds: "***" });
  assertEquals(persisted.definition.getMethodArguments("run"), {});
  assertEquals(persisted.maskedPaths, [["globalArguments", "creds"], [
    "methods",
    "run",
    "arguments",
  ]]);
  assertEquals(
    JSON.stringify([
      persisted.definition.toData(),
      persisted.maskedPaths,
      persisted.persistedProvenance.toData(),
    ]).includes(SECRET),
    false,
  );
});

Deno.test("persistEvaluatedDefinition: a raw input of a preprocessor into a sensitive output is masked where it holds data, without running the transform; an authored literal there is the type's own text and replays (swamp-club#3681)", () => {
  const schemas = {
    methods: {
      run: {
        arguments: z.preprocess(() => {
          throw new Error("must not execute during persistence");
        }, z.object({ token: z.string().meta({ sensitive: true }) })),
      },
    },
  };
  const definition = Definition.create({
    name: "preprocessed",
    methods: { run: { arguments: { alias: SECRET } } },
  });
  // From data (an --input, a step input): masked at the leaf, and refused.
  const data = ProvenanceMap.authored().withWholeData(
    "methods.run.arguments.alias",
  );
  const persisted = persistEvaluatedDefinition(
    definition,
    [],
    definition,
    new RunSensitiveValues(),
    schemas,
    data,
  );
  assertEquals(persisted.definition.getMethodArguments("run"), {
    alias: "***",
  });
  assertEquals(persisted.maskedPaths, [[
    "methods",
    "run",
    "arguments",
    "alias",
  ]]);
  assertEquals(
    findPlaintextSensitiveArguments(schemas, definition.toData(), [], {
      provenance: data,
    }),
    ["methods.run.arguments.alias"],
  );
  assertEquals(
    findPlaintextSensitiveArguments(
      schemas,
      persisted.definition.toData(),
      [],
      { recordedMasks: persisted.maskedPaths, method: { name: "run" } },
    ),
    ["methods.run.arguments.alias"],
  );
  // Replaced by a fresh input, the cached value never executes.
  assertEquals(
    findPlaintextSensitiveArguments(
      schemas,
      persisted.definition.toData(),
      [],
      {
        recordedMasks: persisted.maskedPaths,
        method: { name: "run", replaced: ["alias"] },
      },
    ),
    [],
  );
  // Authored in the definition, the literal is already the type's own text
  // on disk: it is left as it is, and the cache replays.
  const authored = persistEvaluatedDefinition(
    definition,
    [],
    definition,
    new RunSensitiveValues(),
    schemas,
  );
  assertEquals(authored.definition.getMethodArguments("run"), {
    alias: SECRET,
  });
  assertEquals(authored.maskedPaths, []);
  assertEquals(
    findPlaintextSensitiveArguments(
      schemas,
      authored.definition.toData(),
      [],
      { recordedMasks: authored.maskedPaths, method: { name: "run" } },
    ),
    [],
  );
});

Deno.test("persistEvaluatedDefinition: an authored literal under a pipe with no transform into a sensitive field is still the mask, since both sides of such a pipe describe one value (swamp-club#3751)", () => {
  const schemas = {
    methods: {
      run: {
        arguments: z.object({
          key: z.string().pipe(z.string().meta({ sensitive: true })),
        }),
      },
    },
  };
  const definition = Definition.create({
    name: "piped",
    methods: { run: { arguments: { key: SECRET } } },
  });
  const persisted = persistEvaluatedDefinition(
    definition,
    [],
    definition,
    new RunSensitiveValues(),
    schemas,
  );
  assertEquals(persisted.definition.getMethodArguments("run"), {
    key: "***",
  });
  assertEquals(persisted.maskedPaths, [["methods", "run", "arguments", "key"]]);
  assertEquals(
    findPlaintextSensitiveArguments(schemas, definition.toData(), []),
    ["methods.run.arguments.key"],
  );
});

Deno.test("persistEvaluatedDefinition: under a pipe whose input side reshapes the value, an authored literal at a field the schema marks itself, or beside a sibling's own transform, is still the mask and refused on replay (swamp-club#3751)", () => {
  const sensitive = z.string().meta({ sensitive: true });
  const cases: [string, z.ZodTypeAny, Record<string, unknown>, string][] = [
    [
      "a field both sides mark",
      z.object({ token: sensitive, alias: z.string() }).transform((x) => ({
        token: x.token,
      })).pipe(z.object({ token: sensitive })),
      { token: SECRET, alias: "a" },
      "a",
    ],
    [
      "a sibling's own transform",
      z.object({ token: z.string(), n: z.string().transform(Number) }).pipe(
        z.object({ token: sensitive, n: z.number() }),
      ),
      { token: SECRET, n: "1" },
      "1",
    ],
  ];
  for (const [label, schema, args, plain] of cases) {
    const schemas = { methods: { run: { arguments: schema } } };
    const definition = Definition.create({
      name: "reshaped",
      methods: { run: { arguments: args } },
    });
    const persisted = persistEvaluatedDefinition(
      definition,
      [],
      definition,
      new RunSensitiveValues(),
      schemas,
    );
    const cached = persisted.definition.getMethodArguments("run");
    assertEquals(cached.token, "***", label);
    // The other input is the type's own authored text at a position that is
    // only potentially sensitive, so it stays.
    assertEquals(Object.values(cached).includes(plain), true, label);
    assertEquals(
      persisted.maskedPaths,
      [["methods", "run", "arguments", "token"]],
      label,
    );
    assertEquals(
      findPlaintextSensitiveArguments(
        schemas,
        persisted.definition.toData(),
        persisted.writtenReferences,
        { recordedMasks: persisted.maskedPaths, method: { name: "run" } },
      ),
      ["methods.run.arguments.token"],
      label,
    );
  }
});

Deno.test("persistEvaluatedDefinition: resolved sensitive text beside a pending expression or written reference is masked", () => {
  const schemas = {
    globalArguments: z.object({ token: z.string().meta({ sensitive: true }) }),
    methods: {},
  };
  const values = recorded();
  const sentinel = new VaultSecretBag(values.sentinels).addDataSecret(
    SECRET,
    SOURCE,
  );
  for (
    const text of [
      "INPUT-CANARY${{ env.SUFFIX }}",
      "${{ env.TOKEN }}",
      "${{ vault.get('untrusted', 'literal-input') }}",
      `${sentinel}INPUT-CANARY`,
    ]
  ) {
    const definition = Definition.create({
      name: "mixed-data",
      globalArguments: { token: text },
    });
    const provenance = ProvenanceMap.authored().withWholeData(
      "globalArguments.token",
    );
    const persisted = persistEvaluatedDefinition(
      definition,
      [],
      definition,
      values,
      schemas,
      provenance,
    );
    assertEquals(persisted.definition.globalArguments.token, "***");
    assertEquals(persisted.maskedPaths, [["globalArguments", "token"]]);
    assertEquals(persisted.writtenReferences, []);
    if (!text.includes(sentinel)) {
      assertEquals(
        findPlaintextSensitiveArguments(schemas, definition.toData(), [], {
          provenance,
        }),
        ["globalArguments.token"],
      );
    }
  }
  const text = `Bearer ${sentinel}`;
  const definition = Definition.create({
    name: "authored-prefix",
    globalArguments: { token: text },
  });
  const persisted = persistEvaluatedDefinition(
    definition,
    [],
    definition,
    values,
    schemas,
    ProvenanceMap.authored().withRanges("globalArguments.token", [[
      7,
      text.length,
    ]]),
  );
  assertEquals(persisted.definition.globalArguments.token, `Bearer ${REF}`);
  assertEquals(persisted.maskedPaths, []);
  assertEquals(
    findPlaintextSensitiveArguments(
      schemas,
      persisted.definition.toData(),
      persisted.writtenReferences,
      {
        provenance: ProvenanceMap.authored().withRanges(
          "globalArguments.token",
          [[7, text.length]],
        ),
        persistedProvenance: persisted.persistedProvenance,
      },
    ),
    [],
  );
  const leaky = Definition.create({
    name: "legacy",
    globalArguments: { token: `INPUT-CANARY${REF}` },
  });
  const reference: WrittenReference = {
    path: ["globalArguments", "token"],
    occurrence: 0,
    vaultName: SOURCE.vaultName,
    key: SOURCE.key,
    encoding: "raw",
    dataOrigin: true,
  };
  const prefix = ProvenanceMap.authored().withRanges("globalArguments.token", [[
    0,
    "INPUT-CANARY".length,
  ]]);
  for (const persistedProvenance of [undefined, prefix]) {
    assertEquals(
      findPlaintextSensitiveArguments(schemas, leaky.toData(), [reference], {
        provenance: prefix,
        persistedProvenance,
      }),
      ["globalArguments.token"],
    );
  }
});

Deno.test("persistEvaluatedDefinition: method sensitivity covers global fallbacks at their source, honoring overrides and records", () => {
  const schema = z.object({ password: z.string().meta({ sensitive: true }) });
  const definition = Definition.create({
    name: "fallback",
    globalArguments: { password: "INPUT-CANARY" },
  });
  const schemas = {
    globalArguments: z.object({ password: z.string() }),
    methods: { execute: { arguments: schema } },
  };
  const persisted = persistEvaluatedDefinition(
    definition,
    [],
    definition,
    new RunSensitiveValues(),
    schemas,
  );
  assertEquals(persisted.definition.globalArguments.password, "***");
  assertEquals(persisted.maskedPaths, [["globalArguments", "password"]]);
  assertEquals(
    findPlaintextSensitiveArguments(schemas, definition.toData(), []),
    ["globalArguments.password"],
  );
  assertEquals(
    findPlaintextSensitiveArguments(schemas, definition.toData(), [], {
      method: { name: "execute", replaced: ["password"] },
    }),
    [],
  );
  definition.setMethodArgument("execute", "password", "${{ env.PASSWORD }}");
  assertEquals(
    findPlaintextSensitiveArguments(schemas, definition.toData(), []),
    [],
  );
  assertEquals(
    findPlaintextSensitiveArguments(
      {
        methods: {
          execute: {
            arguments: z.record(
              z.string(),
              z.string().meta({ sensitive: true }),
            ),
          },
        },
      },
      definition.toData(),
      [],
    ),
    [],
  );
});

Deno.test("persistEvaluatedDefinition: a method argument record omitted at its root is masked once, though the globals it falls back to are merged back into it (swamp-club#3750)", () => {
  const schemas = {
    globalArguments: z.object({ region: z.string() }),
    methods: {
      run: {
        arguments: z.preprocess(
          (value) => value,
          z.object({
            token: z.string().meta({ sensitive: true }).optional(),
          }),
        ),
      },
    },
  };
  const definition = Definition.create({
    name: "root-record",
    globalArguments: { region: "eu-west-1" },
    methods: { run: { arguments: { [INPUT_VALUE]: "x" } } },
  });
  // The record's keys came from data, so it is omitted at its root. Written
  // as an empty record, the root still holds the merged globals, which
  // found it again on every pass of the masking loop.
  const persisted = persistEvaluatedDefinition(
    definition,
    [],
    definition,
    new RunSensitiveValues(),
    schemas,
    ProvenanceMap.authored().withWholeData("methods.run.arguments"),
  );
  assertEquals(persisted.definition.getMethodArguments("run"), {});
  assertEquals(persisted.definition.globalArguments, { region: "eu-west-1" });
  assertEquals(persisted.maskedPaths, [["methods", "run", "arguments"]]);
  assertEquals(
    JSON.stringify([
      persisted.definition.toData(),
      persisted.maskedPaths,
      persisted.persistedProvenance.toData(),
    ]).includes(INPUT_VALUE),
    false,
  );
});

/** The executed copy: a sentinel where the value was spliced, raw in a tag. */
function executed(bag: VaultSecretBag): Definition {
  const sentinel = bag.addDataSecret(SECRET, SOURCE);
  return Definition.create({
    name: "consumer",
    tags: { owner: SECRET },
    globalArguments: { token: `Bearer ${sentinel}` },
    methods: { run: { arguments: { run: `echo ${sentinel}` } } },
  });
}

Deno.test("persistEvaluatedDefinition: sentinels become references and tags placeholders", () => {
  const values = recorded();
  const bag = new VaultSecretBag(values.sentinels);
  const persisted = persistEvaluatedDefinition(
    executed(bag),
    [],
    Definition.create({ name: "consumer" }),
    values,
    NO_SCHEMAS,
  );
  assertEquals(persisted.definition.globalArguments, {
    token: `Bearer ${REF}`,
  });
  assertEquals(persisted.definition.getMethodArguments("run"), {
    run: `echo ${REF}`,
  });
  assertEquals(persisted.definition.tags, {
    owner: "sensitive-prod.api-token",
  });
  assertEquals(persisted.definition.name, "consumer");
  assertEquals(persisted.writtenReferences.length, 2);
  assertEquals(
    persisted.writtenReferences.every((ref) => ref.dataOrigin),
    true,
  );
});

Deno.test("persistEvaluatedDefinition: deferred binding values are written as references", () => {
  const values = recorded();
  const token = new VaultSecretBag(values.sentinels).addDataReference(
    SOURCE,
    "bindings",
  );
  const persisted = persistEvaluatedDefinition(
    Definition.create({ name: "consumer" }),
    [{
      id: "11111111-1111-4111-8111-111111111111",
      expression: "${{ inputs.token }}",
      bindings: { inputs: { token } },
    }],
    Definition.create({ name: "consumer" }),
    values,
    NO_SCHEMAS,
  );
  assertEquals(persisted.deferredExpressions[0].bindings, {
    inputs: { token: REF },
  });
  assertEquals(
    persisted.deferredExpressions[0].expression,
    "${{ inputs.token }}",
  );
});

Deno.test("rehydrateEvaluatedDefinition: restores the raw and executed copies of a fresh run", async () => {
  const recordedValues = recorded();
  const bag = new VaultSecretBag(recordedValues.sentinels);
  const persisted = persistEvaluatedDefinition(
    executed(bag),
    [],
    Definition.create({ name: "consumer" }),
    recordedValues,
    NO_SCHEMAS,
  );
  const values = new RunSensitiveValues();
  const stepBag = new VaultSecretBag(values.sentinels);
  const restored = await rehydrateEvaluatedDefinition(persisted, stepBag);
  assertEquals(restored.definition, restored.executedDefinition);
  assertEquals(
    JSON.stringify(restored.definition.toData()).includes(SECRET),
    false,
  );
  assertEquals(values.list(), []);
  assertEquals(
    persistEvaluatedDefinition(
      restored.definition,
      [],
      restored.definition,
      values,
      NO_SCHEMAS,
    ).definition.globalArguments,
    persisted.definition.globalArguments,
  );
});

Deno.test("mayHoldPlaintextSensitiveValues: only unmarked caches that read data or step outputs", () => {
  const check = (sensitiveFormat: number | undefined, expressions: string[]) =>
    mayHoldPlaintextSensitiveValues({
      sensitiveFormat,
      authoredExpressions: new Set(expressions),
    });
  assertEquals(check(undefined, ["${{ data.latest('a', 'b') }}"]), true);
  assertEquals(check(undefined, ["${{ steps.build.outputs.x }}"]), true);
  assertEquals(check(undefined, ["${{ steps['build'].outputs.x }}"]), true);
  assertEquals(check(undefined, ["${{ inputs.region }}"]), false);
  assertEquals(check(undefined, []), false);
  assertEquals(check(1, ["${{ data.latest('a', 'b') }}"]), false);
});

Deno.test("isNewerSensitiveFormat: only a marked cache whose format is newer than this swamp's (swamp-club#3681)", () => {
  assertEquals(isNewerSensitiveFormat({ sensitiveFormat: undefined }), false);
  assertEquals(isNewerSensitiveFormat({ sensitiveFormat: 1 }), false);
  assertEquals(
    isNewerSensitiveFormat({ sensitiveFormat: SENSITIVE_FORMAT_VERSION }),
    false,
  );
  assertEquals(
    isNewerSensitiveFormat({ sensitiveFormat: SENSITIVE_FORMAT_VERSION + 1 }),
    true,
  );
  // The masks this swamp writes are version 2, so a version-1 reader would
  // run one as the value: the version is at least 2.
  assertEquals(SENSITIVE_FORMAT_VERSION >= 2, true);
});

/** A type with sensitive global and method arguments. */
const SCHEMAS: ArgumentSchemas = {
  globalArguments: z.object({
    apiKey: z.string().meta({ sensitive: true }).optional(),
    token: z.string().meta({ sensitive: true }).optional(),
    region: z.string().optional(),
  }),
  methods: {
    run: {
      arguments: z.object({
        secret: z.string().meta({ sensitive: true }).optional(),
        attempts: z.number().meta({ sensitive: true }).optional(),
        name: z.string().optional(),
      }),
    },
  },
};
/** What a caller typed on --input: no vault source, so never recorded. */
const INPUT_VALUE = "REPRO-SECRET-7c1e";

function referenceAt(path: (string | number)[]): WrittenReference {
  return {
    path,
    occurrence: 0,
    vaultName: SOURCE.vaultName,
    key: SOURCE.key,
    encoding: "raw",
    dataOrigin: false,
  };
}

Deno.test("persistEvaluatedDefinition: a literal under a sensitive argument becomes the mask; a vault reference and other values stay (swamp-club#3681)", () => {
  const values = recorded();
  const bag = new VaultSecretBag(values.sentinels);
  const sentinel = bag.addDataSecret(SECRET, SOURCE);
  const executed = Definition.create({
    name: "input-svc",
    globalArguments: {
      apiKey: INPUT_VALUE,
      token: sentinel,
      region: "eu-west-1",
    },
    methods: {
      run: { arguments: { secret: INPUT_VALUE, attempts: 3, name: "visible" } },
    },
  });
  const persisted = persistEvaluatedDefinition(
    executed,
    [],
    Definition.create({ name: "input-svc" }),
    values,
    SCHEMAS,
  );
  assertEquals(persisted.definition.globalArguments, {
    apiKey: "***",
    token: REF,
    region: "eu-west-1",
  });
  assertEquals(persisted.definition.getMethodArguments("run"), {
    secret: "***",
    attempts: "***",
    name: "visible",
  });
  assertEquals([...persisted.maskedArguments].sort(), [
    "globalArguments.apiKey",
    "methods.run.arguments.attempts",
    "methods.run.arguments.secret",
  ]);
  assertEquals(
    [...persisted.maskedPaths].sort((a, b) =>
      a.join(".").localeCompare(b.join("."))
    ),
    [
      ["globalArguments", "apiKey"],
      ["methods", "run", "arguments", "attempts"],
      ["methods", "run", "arguments", "secret"],
    ],
  );
  assertEquals(
    JSON.stringify(persisted.definition.toData()).includes(INPUT_VALUE),
    false,
  );
  assertEquals(persisted.writtenReferences.map((r) => r.path), [[
    "globalArguments",
    "token",
  ]]);
  // The copy that executes keeps its values.
  assertEquals(executed.globalArguments.apiKey, INPUT_VALUE);
  assertEquals(executed.getMethodArguments("run").secret, INPUT_VALUE);
});

Deno.test("persistEvaluatedDefinition: a sensitive string holding a written reference is left whole, and schemas that mark nothing mask nothing (swamp-club#3681)", () => {
  const values = recorded();
  const bag = new VaultSecretBag(values.sentinels);
  const sentinel = bag.addDataSecret(SECRET, SOURCE);
  const persisted = persistEvaluatedDefinition(
    Definition.create({
      name: "mixed",
      globalArguments: { apiKey: `${INPUT_VALUE}-${sentinel}` },
    }),
    [],
    Definition.create({ name: "mixed" }),
    values,
    SCHEMAS,
  );
  // The documented limit: text joined to a reference stays as written.
  assertEquals(persisted.definition.globalArguments, {
    apiKey: `${INPUT_VALUE}-${REF}`,
  });
  assertEquals(persisted.maskedArguments, []);

  const plain = persistEvaluatedDefinition(
    Definition.create({
      name: "plain",
      globalArguments: { apiKey: INPUT_VALUE },
    }),
    [],
    Definition.create({ name: "plain" }),
    new RunSensitiveValues(),
    NO_SCHEMAS,
  );
  assertEquals(plain.definition.globalArguments, { apiKey: INPUT_VALUE });
  assertEquals(plain.maskedArguments, []);
});

Deno.test("persistEvaluatedDefinition: an author-written expression joined to text in a sensitive argument is kept as written, and the replay check passes it (swamp-club#3681)", () => {
  // The cache is built before the runtime pass: vault and env expressions,
  // and a data read a workflow deferred, are still expressions here.
  const schemas: ArgumentSchemas = {
    globalArguments: z.object({
      apiKey: z.string().meta({ sensitive: true }).optional(),
    }),
    methods: {
      call: {
        arguments: z.object({
          authorization: z.string().meta({ sensitive: true }).optional(),
          cookie: z.string().meta({ sensitive: true }).optional(),
          session: z.string().meta({ sensitive: true }).optional(),
        }),
      },
    },
  };
  const authored = Definition.create({
    name: "api",
    globalArguments: { apiKey: "${{ vault.get('github', 'token') }}" },
    methods: {
      call: {
        arguments: {
          authorization: "Bearer ${{ vault.get('github', 'token') }}",
          cookie: "token=${{ env.TOKEN }}",
          session: "s-${{ data.latest('sessions', 'current').attributes.id }}",
        },
      },
    },
  });
  const persisted = persistEvaluatedDefinition(
    authored,
    [],
    authored,
    new RunSensitiveValues(),
    schemas,
  );
  assertEquals(persisted.definition.toData(), authored.toData());
  assertEquals(persisted.maskedArguments, []);
  assertEquals(
    findPlaintextSensitiveArguments(
      schemas,
      persisted.definition.toData(),
      [],
      {
        method: { name: "call" },
      },
    ),
    [],
  );
  // Once an input or a data read has produced the text, nothing is pending.
  const resolved = Definition.fromData({
    ...authored.toData(),
    methods: { call: { arguments: { authorization: "Bearer REPRO-7c1e" } } },
  });
  assertEquals(
    persistEvaluatedDefinition(
      resolved,
      [],
      authored,
      new RunSensitiveValues(),
      schemas,
    )
      .maskedArguments,
    ["methods.call.arguments.authorization"],
  );
});

Deno.test("findPlaintextSensitiveArguments: reports the mask and plaintext but not a reference; allowMask leaves the mask out (swamp-club#3681)", () => {
  const data = Definition.create({
    name: "cached",
    globalArguments: { apiKey: "***", token: REF, region: "eu" },
    methods: { run: { arguments: { secret: "plain-value", name: "x" } } },
  }).toData();
  const references = [referenceAt(["globalArguments", "token"])];
  assertEquals(findPlaintextSensitiveArguments(SCHEMAS, data, references), [
    "globalArguments.apiKey",
    "methods.run.arguments.secret",
  ]);
  assertEquals(
    findPlaintextSensitiveArguments(SCHEMAS, data, references, {
      allowMask: true,
    }),
    ["methods.run.arguments.secret"],
  );
  // A reference is an expression; it passes with no written entry.
  assertEquals(
    findPlaintextSensitiveArguments(SCHEMAS, data, []).includes(
      "globalArguments.token",
    ),
    false,
  );
  // A string that still holds a vault expression is not a value yet, with or
  // without a written reference covering it.
  const mixed = Definition.create({
    name: "mixed",
    globalArguments: { apiKey: `pre-${REF}` },
  }).toData();
  assertEquals(findPlaintextSensitiveArguments(SCHEMAS, mixed, []), []);
  assertEquals(
    findPlaintextSensitiveArguments(SCHEMAS, mixed, [
      referenceAt(["globalArguments", "apiKey"]),
    ]),
    [],
  );
  // Text an expression produced, with nothing pending, is plaintext.
  const produced = Definition.create({
    name: "produced",
    globalArguments: { apiKey: "pre-REPRO" },
  }).toData();
  assertEquals(findPlaintextSensitiveArguments(SCHEMAS, produced, []), [
    "globalArguments.apiKey",
  ]);
  // A method the schemas do not declare, and schemas that mark nothing.
  const unknownMethod = Definition.create({
    name: "u",
    methods: { other: { arguments: { secret: "plain" } } },
  }).toData();
  assertEquals(findPlaintextSensitiveArguments(SCHEMAS, unknownMethod, []), []);
  assertEquals(findPlaintextSensitiveArguments(NO_SCHEMAS, data, []), []);
});

Deno.test("persistEvaluatedDefinition and findPlaintextSensitiveArguments: inside a sensitive container a reference sits in, only the leaves the reference covers are left (swamp-club#3681)", () => {
  const schemas: ArgumentSchemas = {
    globalArguments: z.object({
      headers: z.record(z.string(), z.string()).meta({ sensitive: true }),
    }),
    methods: {},
  };
  const values = recorded();
  const bag = new VaultSecretBag(values.sentinels);
  const sentinel = bag.addDataSecret(SECRET, SOURCE);
  const persisted = persistEvaluatedDefinition(
    Definition.create({
      name: "headers",
      globalArguments: {
        headers: { auth: `Bearer ${sentinel}`, key: INPUT_VALUE, empty: "" },
      },
    }),
    [],
    Definition.create({ name: "headers" }),
    values,
    schemas,
  );
  assertEquals(persisted.definition.globalArguments, {
    headers: { auth: `Bearer ${REF}`, key: "***", empty: "" },
  });
  assertEquals(persisted.maskedArguments, ["globalArguments.headers.key"]);
  assertEquals(persisted.maskedPaths, [[
    "globalArguments",
    "headers",
    "key",
  ]]);
  const cached = persisted.definition.toData();
  assertEquals(
    findPlaintextSensitiveArguments(
      schemas,
      cached,
      persisted.writtenReferences,
    ),
    ["globalArguments.headers.key"],
  );
  assertEquals(
    findPlaintextSensitiveArguments(
      schemas,
      cached,
      persisted.writtenReferences,
      { allowMask: true },
    ),
    [],
  );

  // A container is always walked leaf by leaf: a pending expression in one
  // leaf is kept, the plaintext leaf beside it is masked.
  const leaves = persistEvaluatedDefinition(
    Definition.create({
      name: "leaves",
      globalArguments: {
        headers: { key: INPUT_VALUE, auth: `Bearer ${REF}`, empty: "" },
      },
    }),
    [],
    Definition.create({ name: "leaves" }),
    new RunSensitiveValues(),
    schemas,
  );
  assertEquals(leaves.definition.globalArguments, {
    headers: { key: "***", auth: `Bearer ${REF}`, empty: "" },
  });
  assertEquals(leaves.maskedArguments, ["globalArguments.headers.key"]);
});

Deno.test("findPlaintextSensitiveArguments: for a replay, checks the global arguments and the replayed method only, less the arguments the caller replaces (swamp-club#3681)", () => {
  const schemas: ArgumentSchemas = {
    ...SCHEMAS,
    methods: {
      ...SCHEMAS.methods,
      deploy: {
        arguments: z.object({
          password: z.string().meta({ sensitive: true }).optional(),
        }),
      },
    },
  };
  const data = Definition.create({
    name: "cached",
    globalArguments: { apiKey: "***" },
    methods: {
      run: { arguments: { secret: "***", name: "x" } },
      deploy: { arguments: { password: "***" } },
    },
  }).toData();
  assertEquals(findPlaintextSensitiveArguments(schemas, data, []), [
    "globalArguments.apiKey",
    "methods.run.arguments.secret",
    "methods.deploy.arguments.password",
  ]);
  assertEquals(
    findPlaintextSensitiveArguments(schemas, data, [], {
      method: { name: "run" },
    }),
    ["globalArguments.apiKey", "methods.run.arguments.secret"],
  );
  assertEquals(
    findPlaintextSensitiveArguments(schemas, data, [], {
      method: { name: "run", replaced: ["secret"] },
    }),
    ["globalArguments.apiKey"],
  );
  assertEquals(
    findPlaintextSensitiveArguments(schemas, data, [], {
      method: { name: "status" },
    }),
    ["globalArguments.apiKey"],
  );
});

Deno.test("findPlaintextSensitiveArguments: a recorded masked position is reported whatever the schemas mark now, within the replayed scope, once (swamp-club#3681)", () => {
  // The type no longer marks anything sensitive: the recorded positions
  // alone keep the mask from running.
  const data = Definition.create({
    name: "drifted",
    globalArguments: { apiKey: "***", region: "eu" },
    methods: {
      run: { arguments: { secret: "***", name: "x" } },
      deploy: { arguments: { password: "***" } },
    },
  }).toData();
  const recorded = [
    ["globalArguments", "apiKey"],
    ["methods", "run", "arguments", "secret"],
    ["methods", "deploy", "arguments", "password"],
    ["tags", "owner"],
  ];
  assertEquals(
    findPlaintextSensitiveArguments(NO_SCHEMAS, data, [], {
      recordedMasks: recorded,
    }),
    [
      "globalArguments.apiKey",
      "methods.run.arguments.secret",
      "methods.deploy.arguments.password",
    ],
  );
  assertEquals(
    findPlaintextSensitiveArguments(NO_SCHEMAS, data, [], {
      recordedMasks: recorded,
      method: { name: "run" },
    }),
    ["globalArguments.apiKey", "methods.run.arguments.secret"],
  );
  assertEquals(
    findPlaintextSensitiveArguments(NO_SCHEMAS, data, [], {
      recordedMasks: recorded,
      method: { name: "run", replaced: ["secret"] },
    }),
    ["globalArguments.apiKey"],
  );
  // Found by the schema and recorded: reported once, spelled the same way.
  assertEquals(
    findPlaintextSensitiveArguments(SCHEMAS, data, [], {
      recordedMasks: [["globalArguments", "apiKey"], [
        "methods",
        "run",
        "arguments",
        "secret",
      ]],
      method: { name: "run" },
    }),
    ["globalArguments.apiKey", "methods.run.arguments.secret"],
  );
  // A recorded position inside a container is spelled like a found one.
  assertEquals(
    findPlaintextSensitiveArguments(NO_SCHEMAS, data, [], {
      recordedMasks: [["globalArguments", "headers", "x-key"], [
        "globalArguments",
        "tokens",
        0,
      ]],
    }),
    ["globalArguments.headers.x-key", "globalArguments.tokens[0]"],
  );
});

Deno.test("evaluatedCacheHoldsSensitiveArgumentsMessage: says the run cannot be replayed and what makes it replayable, per command (swamp-club#3681)", () => {
  const method = evaluatedCacheHoldsSensitiveArgumentsMessage(
    "svc",
    ["globalArguments.apiKey"],
    "method",
  );
  assertStringIncludes(
    method,
    `cached for "svc" holds a value for the sensitive argument 'globalArguments.apiKey'`,
  );
  assertStringIncludes(method, "--last-evaluated cannot replay it");
  assertStringIncludes(method, "Run the method without --last-evaluated.");
  assertStringIncludes(method, "store the value in a vault");
  assertStringIncludes(
    method,
    "or replace a cached method argument with --input only if its name is not a declared definition input",
  );
  const workflow = evaluatedCacheHoldsSensitiveArgumentsMessage(
    "svc",
    ["a.b", "c.d"],
    "workflow",
  );
  assertStringIncludes(workflow, "the sensitive arguments 'a.b', 'c.d'");
  assertStringIncludes(workflow, "Run the workflow without --last-evaluated.");
  assertStringIncludes(
    workflow,
    "or set it as a step input, which replaces the cached method argument",
  );
});

Deno.test("plaintextSensitiveArgumentsMessage: names the paths, singular and plural, and no value", () => {
  assertStringIncludes(
    plaintextSensitiveArgumentsMessage("svc", ["globalArguments.apiKey"]),
    `"svc" holds a plaintext value for the sensitive argument 'globalArguments.apiKey'`,
  );
  assertStringIncludes(
    plaintextSensitiveArgumentsMessage("svc", ["a.b", "c.d"]),
    "the sensitive arguments 'a.b', 'c.d'",
  );
});

Deno.test("persistEvaluatedDefinition and findPlaintextSensitiveArguments: a plaintext leaf inside a container that arrived whole from data is masked at the container, so its keys reach neither the file, the metadata nor the refusal (swamp-club#3681)", () => {
  const schemas: ArgumentSchemas = {
    methods: {
      record: {
        arguments: z.object({
          tokens: z.record(z.string(), z.string().meta({ sensitive: true })),
          nested: z.object({
            creds: z.record(z.string(), z.string().meta({ sensitive: true })),
          }).optional(),
        }),
      },
    },
  };
  const keyed = { [INPUT_VALUE]: INPUT_VALUE };
  const executed = Definition.create({
    name: "record",
    methods: {
      record: { arguments: { tokens: keyed, nested: { creds: keyed } } },
    },
  });
  // The record came whole from an input; the object around `creds` is
  // authored, so only `creds` carries the keys.
  const provenance = ProvenanceMap.authored()
    .withWholeData("methods.record.arguments.tokens")
    .withWholeData("methods.record.arguments.nested.creds");
  const persisted = persistEvaluatedDefinition(
    executed,
    [],
    Definition.create({ name: "record" }),
    new RunSensitiveValues(),
    schemas,
    provenance,
  );
  assertEquals(persisted.definition.getMethodArguments("record"), {
    tokens: "***",
    nested: { creds: "***" },
  });
  assertEquals(persisted.maskedPaths, [
    ["methods", "record", "arguments", "tokens"],
    ["methods", "record", "arguments", "nested", "creds"],
  ]);
  assertEquals(
    JSON.stringify([
      persisted.definition.toData(),
      persisted.maskedPaths,
      persisted.persistedProvenance.toData(),
    ]).includes(INPUT_VALUE),
    false,
  );
  assertEquals(
    findPlaintextSensitiveArguments(schemas, executed.toData(), [], {
      provenance,
    }),
    [
      "methods.record.arguments.tokens",
      "methods.record.arguments.nested.creds",
    ],
  );
  // A leaf under an authored container is still reported on its own.
  const authored = findPlaintextSensitiveArguments(
    schemas,
    executed.toData(),
    [],
    {
      provenance: ProvenanceMap.authored().withWholeData(
        keyPath("methods.record.arguments.tokens", INPUT_VALUE),
      ),
    },
  );
  assertEquals(authored.includes("methods.record.arguments.tokens"), false);
  assertEquals(
    authored.includes(keyPath("methods.record.arguments.tokens", INPUT_VALUE)),
    true,
  );
});

Deno.test("persistEvaluatedDefinition and findPlaintextSensitiveArguments: a record whose keys came from data is masked at the record when its sensitive values are objects, and an array of data-keyed objects is masked whole, so no key reaches the file, the metadata nor the refusal (swamp-club#3744)", () => {
  const schemas: ArgumentSchemas = {
    globalArguments: z.object({
      creds: z.record(
        z.string(),
        z.object({ user: z.string(), pass: z.string() }).meta({
          sensitive: true,
        }),
      ),
      lists: z.array(z.record(z.string(), z.string())).meta({
        sensitive: true,
      }).optional(),
    }),
    methods: {},
  };
  const executed = Definition.create({
    name: "object-record",
    globalArguments: {
      creds: { [INPUT_VALUE]: { user: "u", pass: "p" } },
      lists: [{ [INPUT_VALUE]: "x" }],
    },
  });
  // Both arrived whole from the run's inputs, keys included.
  const provenance = ProvenanceMap.authored()
    .withWholeData("globalArguments.creds")
    .withWholeData("globalArguments.lists");
  const persisted = persistEvaluatedDefinition(
    executed,
    [],
    Definition.create({ name: "object-record" }),
    new RunSensitiveValues(),
    schemas,
    provenance,
  );
  assertEquals(persisted.definition.globalArguments, {
    creds: "***",
    lists: "***",
  });
  assertEquals(persisted.maskedPaths, [
    ["globalArguments", "creds"],
    ["globalArguments", "lists"],
  ]);
  assertEquals(
    JSON.stringify([
      persisted.definition.toData(),
      persisted.maskedPaths,
      persisted.maskedArguments,
      persisted.persistedProvenance.toData(),
    ]).includes(INPUT_VALUE),
    false,
  );
  assertEquals(
    findPlaintextSensitiveArguments(schemas, executed.toData(), [], {
      provenance,
    }),
    ["globalArguments.creds", "globalArguments.lists"],
  );
});

Deno.test("findPlaintextSensitiveArguments: with no persistedProvenance a sensitive string holding data and a written reference is data whole, so data after the reference is refused as well as data before it (swamp-club#3744)", () => {
  const schemas: ArgumentSchemas = {
    globalArguments: z.object({ token: z.string().meta({ sensitive: true }) }),
    methods: {},
  };
  const reference: WrittenReference = {
    path: ["globalArguments", "token"],
    occurrence: 0,
    vaultName: SOURCE.vaultName,
    key: SOURCE.key,
    encoding: "raw",
    dataOrigin: true,
  };
  const legacy = Definition.create({
    name: "legacy-suffix",
    globalArguments: { token: `${REF}INPUT-CANARY` },
  });
  // In raw coordinates the suffix follows the secret, which is shorter than
  // its reference text, so this range falls inside the written reference.
  const raw = ProvenanceMap.authored().withRanges("globalArguments.token", [[
    SECRET.length,
    SECRET.length + "INPUT-CANARY".length,
  ]]);
  assertEquals(SECRET.length + "INPUT-CANARY".length < REF.length, true);
  assertEquals(
    findPlaintextSensitiveArguments(schemas, legacy.toData(), [reference], {
      provenance: raw,
    }),
    ["globalArguments.token"],
  );
});

Deno.test("maskSensitiveArgumentsForDisplay: masks what the cache masks — data beside a pending expression, a data container's keys, a pipeline's raw inputs — and keeps a reference and authored mixed text (swamp-club#3681)", () => {
  const sensitive = z.string().meta({ sensitive: true });
  const schemas: ArgumentSchemas = {
    globalArguments: z.object({
      apiKey: sensitive.optional(),
      region: z.string().optional(),
    }),
    methods: {
      run: {
        arguments: z.object({
          mixed: sensitive.optional(),
          authored: sensitive.optional(),
          reference: sensitive.optional(),
          tokens: z.record(z.string(), z.unknown()).meta({ sensitive: true })
            .optional(),
          records: z.record(z.string(), sensitive).optional(),
          plain: z.string().optional(),
        }),
      },
      piped: {
        arguments: z.object({ raw: z.string() }).transform((x) => ({
          token: x.raw,
        })).pipe(z.object({ token: sensitive })),
      },
    },
  };
  const data = Definition.create({
    name: "shown",
    globalArguments: { apiKey: "${{ vault.get('v', 'k') }}", region: "eu" },
    methods: {
      run: {
        arguments: {
          mixed: `${INPUT_VALUE}-\${{ vault.get('v', 'k') }}`,
          authored: "Bearer ${{ vault.get('v', 'k') }}",
          reference: "${{ vault.get('v', 'k') }}",
          tokens: { [INPUT_VALUE]: null },
          records: { [INPUT_VALUE]: "***" },
          plain: INPUT_VALUE,
        },
      },
      piped: { arguments: { raw: INPUT_VALUE } },
    },
  }).toData();
  const provenance = ProvenanceMap.authored()
    .withRanges("methods.run.arguments.mixed", [[0, INPUT_VALUE.length]])
    .withWholeData("methods.run.arguments.tokens")
    .withWholeData("methods.run.arguments.records")
    .withWholeData("methods.run.arguments.plain")
    .withWholeData("methods.piped.arguments.raw");
  const shown = maskSensitiveArgumentsForDisplay(
    schemas,
    data,
    "run",
    provenance,
  );
  assertEquals(shown.globalArguments, {
    apiKey: "${{ vault.get('v', 'k') }}",
    region: "eu",
  });
  assertEquals(shown.methods?.run.arguments, {
    mixed: "***",
    authored: "Bearer ${{ vault.get('v', 'k') }}",
    reference: "${{ vault.get('v', 'k') }}",
    tokens: "***",
    records: "***",
    plain: INPUT_VALUE,
  });
  // A run of the pipeline masks the raw input that holds data, and keeps
  // the reference and the authored literal among the global arguments its
  // transform may consume; another method's run is not read.
  const piped = maskSensitiveArgumentsForDisplay(
    schemas,
    data,
    "piped",
    provenance,
  );
  assertEquals(piped.globalArguments, {
    apiKey: "${{ vault.get('v', 'k') }}",
    region: "eu",
  });
  assertEquals(piped.methods?.piped.arguments, { raw: "***" });
  assertEquals(piped.methods?.run.arguments, data.methods?.run.arguments);
  // The input is left as it was.
  assertEquals(
    JSON.stringify(data.methods?.run.arguments).includes(INPUT_VALUE),
    true,
  );
  // Without provenance the same rules as the cache's: authored text joined
  // to a pending expression stays, a literal under a sensitive field is
  // masked, and a sensitive container's keys are kept as authored.
  const literal = maskSensitiveArgumentsForDisplay(schemas, data, "run")
    .methods?.run.arguments ?? {};
  assertEquals(literal.plain, INPUT_VALUE);
  assertEquals(literal.mixed, `${INPUT_VALUE}-\${{ vault.get('v', 'k') }}`);
  assertEquals(literal.tokens, { [INPUT_VALUE]: null });
  assertEquals(literal.records, { [INPUT_VALUE]: "***" });
});

Deno.test("persistEvaluatedDefinition, findPlaintextSensitiveArguments and maskSensitiveArgumentsForDisplay: a sensitive record whose keys came from an input beside an expression the operator typed into it is masked at the record, and nothing of it reaches the file, the metadata or the refusal (swamp-club#3681)", () => {
  const sensitive = z.string().meta({ sensitive: true });
  const schemas: ArgumentSchemas = {
    methods: {
      container: {
        arguments: z.object({
          tokens: z.record(z.string(), z.unknown()).meta({ sensitive: true }),
        }),
      },
      record: {
        arguments: z.object({ tokens: z.record(z.string(), sensitive) }),
      },
    },
  };
  const executed = Definition.create({
    name: "mixed",
    methods: {
      // A vault reference typed beside the key, pending for the runtime pass.
      container: { arguments: { tokens: { [INPUT_VALUE]: null, expr: REF } } },
      // A constant typed beside it, already resolved and authored.
      record: {
        arguments: { tokens: { [INPUT_VALUE]: "ordinary", expr: "public" } },
      },
    },
  });
  const provenance = ProvenanceMap.fromEntries(
    [
      keyPath("methods.container.arguments.tokens", INPUT_VALUE),
      keyPath("methods.record.arguments.tokens", INPUT_VALUE),
    ],
    [],
    ["methods.container.arguments.tokens", "methods.record.arguments.tokens"],
  );
  const persisted = persistEvaluatedDefinition(
    executed,
    [],
    Definition.create({ name: "mixed" }),
    new RunSensitiveValues(),
    schemas,
    provenance,
  );
  assertEquals(persisted.definition.getMethodArguments("container"), {
    tokens: "***",
  });
  assertEquals(persisted.definition.getMethodArguments("record"), {
    tokens: "***",
  });
  assertEquals(persisted.maskedPaths, [
    ["methods", "container", "arguments", "tokens"],
    ["methods", "record", "arguments", "tokens"],
  ]);
  assertEquals(
    JSON.stringify([
      persisted.definition.toData(),
      persisted.maskedPaths,
      persisted.persistedProvenance.toData(),
    ]).includes(INPUT_VALUE),
    false,
  );
  assertEquals(
    findPlaintextSensitiveArguments(schemas, executed.toData(), [], {
      provenance,
    }),
    ["methods.container.arguments.tokens", "methods.record.arguments.tokens"],
  );
  for (const method of ["container", "record"]) {
    const shown = maskSensitiveArgumentsForDisplay(
      schemas,
      executed.toData(),
      method,
      provenance,
    ).methods as Record<string, { arguments: unknown }>;
    assertEquals(shown[method].arguments, { tokens: "***" });
  }
  // The same record authored in the definition keeps its reference and its
  // keys: they are the type's own.
  const authored = persistEvaluatedDefinition(
    executed,
    [],
    executed,
    new RunSensitiveValues(),
    schemas,
    ProvenanceMap.authored(),
  );
  assertEquals(authored.definition.getMethodArguments("container"), {
    tokens: { [INPUT_VALUE]: null, expr: REF },
  });
});

Deno.test("persistEvaluatedDefinition and maskSensitiveArgumentsForDisplay: a record of sensitive values whose keys came from an input is masked at the record even when every value is a vault reference the operator typed, so the keys reach neither the file nor the completed event (swamp-club#3681)", () => {
  const schemas: ArgumentSchemas = {
    methods: {
      record: {
        arguments: z.object({
          tokens: z.record(z.string(), z.string().meta({ sensitive: true })),
        }),
      },
    },
  };
  const executed = Definition.create({
    name: "refs",
    methods: { record: { arguments: { tokens: { [INPUT_VALUE]: REF } } } },
  });
  const provenance = ProvenanceMap.fromEntries([], [], [
    "methods.record.arguments.tokens",
  ]);
  const persisted = persistEvaluatedDefinition(
    executed,
    [],
    Definition.create({ name: "refs" }),
    new RunSensitiveValues(),
    schemas,
    provenance,
  );
  assertEquals(persisted.definition.getMethodArguments("record"), {
    tokens: "***",
  });
  assertEquals(persisted.maskedPaths, [
    ["methods", "record", "arguments", "tokens"],
  ]);
  assertEquals(
    JSON.stringify([
      persisted.definition.toData(),
      persisted.maskedPaths,
      persisted.persistedProvenance.toData(),
    ]).includes(INPUT_VALUE),
    false,
  );
  const shown = maskSensitiveArgumentsForDisplay(
    schemas,
    executed.toData(),
    "record",
    provenance,
  ).methods as Record<string, { arguments: unknown }>;
  assertEquals(shown.record.arguments, { tokens: "***" });
  // The same record authored in the definition keeps its references.
  const authored = persistEvaluatedDefinition(
    executed,
    [],
    executed,
    new RunSensitiveValues(),
    schemas,
    ProvenanceMap.authored(),
  );
  assertEquals(authored.definition.getMethodArguments("record"), {
    tokens: { [INPUT_VALUE]: REF },
  });
});

Deno.test("persistEvaluatedDefinition, findPlaintextSensitiveArguments and maskSensitiveArgumentsForDisplay: a transform anywhere in the type — an unrelated method's, a non-sensitive global's, the replayed method's own pipeline — leaves a vault-only definition's references and authored literals in the cache, so it replays; only data at such a position is masked (swamp-club#3681)", () => {
  const sensitive = z.string().meta({ sensitive: true });
  const globals = { apiKey: REF, region: "eu" };
  const vaultOnly = Definition.create({
    name: "vault-only",
    globalArguments: globals,
    methods: { run: { arguments: { token: REF } } },
  });
  const plainGlobals = z.object({
    apiKey: sensitive.optional(),
    region: z.string().optional(),
  });
  const transformedGlobals = z.object({
    apiKey: sensitive.optional(),
    region: z.string().optional(),
    count: z.string().transform(Number).optional(),
  });
  const cases: [string, ArgumentSchemas, Definition][] = [
    ["an unrelated method's transform", {
      globalArguments: plainGlobals,
      methods: {
        run: { arguments: z.object({ token: sensitive.optional() }) },
        other: {
          arguments: z.object({ token: sensitive.transform((s) => s.trim()) }),
        },
      },
    }, vaultOnly],
    ["a transform on a non-sensitive global", {
      globalArguments: transformedGlobals,
      methods: {
        run: { arguments: z.object({ token: sensitive.optional() }) },
      },
    }, vaultOnly],
    [
      "the replayed method's own pipeline",
      {
        globalArguments: plainGlobals,
        methods: {
          run: {
            arguments: z.object({ raw: z.string() }).transform((x) => ({
              token: x.raw,
            })).pipe(z.object({ token: sensitive })),
          },
        },
      },
      Definition.create({
        name: "piped",
        globalArguments: globals,
        methods: { run: { arguments: { raw: REF } } },
      }),
    ],
  ];
  for (const [label, schemas, definition] of cases) {
    const persisted = persistEvaluatedDefinition(
      definition,
      [],
      definition,
      new RunSensitiveValues(),
      schemas,
    );
    assertEquals(persisted.definition.globalArguments, globals, label);
    assertEquals(
      persisted.definition.getMethodArguments("run"),
      definition.getMethodArguments("run"),
      label,
    );
    assertEquals(persisted.maskedPaths, [], label);
    assertEquals(
      findPlaintextSensitiveArguments(
        schemas,
        persisted.definition.toData(),
        persisted.writtenReferences,
        { method: { name: "run" }, recordedMasks: persisted.maskedPaths },
      ),
      [],
      label,
    );
    assertEquals(
      maskSensitiveArgumentsForDisplay(schemas, definition.toData(), "run")
        .globalArguments,
      globals,
      label,
    );
  }
  // A global an input fed, under a globals schema that transforms, is data
  // at such a position: masked at the leaf, recorded, and refused.
  const fed = Definition.create({
    name: "fed",
    globalArguments: { ...globals, count: INPUT_VALUE },
    methods: { run: { arguments: { token: REF } } },
  });
  const provenance = ProvenanceMap.authored().withWholeData(
    "globalArguments.count",
  );
  const schemas = cases[1][1];
  const persisted = persistEvaluatedDefinition(
    fed,
    [],
    fed,
    new RunSensitiveValues(),
    schemas,
    provenance,
  );
  assertEquals(persisted.definition.globalArguments, {
    ...globals,
    count: "***",
  });
  assertEquals(persisted.maskedPaths, [["globalArguments", "count"]]);
  assertEquals(
    findPlaintextSensitiveArguments(
      schemas,
      persisted.definition.toData(),
      persisted.writtenReferences,
      { method: { name: "run" }, recordedMasks: persisted.maskedPaths },
    ),
    ["globalArguments.count"],
  );
  assertEquals(
    JSON.stringify([persisted.definition.toData(), persisted.maskedPaths])
      .includes(INPUT_VALUE),
    false,
  );
});

// --- typed-secrets 4.4: a typed replay holds references ---

/** A typed run's record and the step's bag over its registry. */
function typedStep(): { values: RunSensitiveValues; bag: VaultSecretBag } {
  const values = new RunSensitiveValues(
    undefined,
    new SecretBagRegistry(),
  );
  return { values, bag: new VaultSecretBag(values.sentinels) };
}

/** A cache a typed run wrote: two references in one argument, one in another. */
function typedCache() {
  const writer = typedStep();
  const first = writer.bag.addSecret(SOURCE, "globalArguments.token");
  const second = writer.bag.addDataReference(
    { vaultName: "prod", key: "db-password" },
    "data",
  );
  const definition = Definition.create({
    name: "consumer",
    globalArguments: { token: `Bearer ${first} ${second}` },
    methods: {
      run: { arguments: { run: `echo ${second} ${"${{ env.X }}"}` } },
    },
  });
  const provenance = ProvenanceMap.authored().withRanges(
    "globalArguments.token",
    [[7, 7 + first.length], [
      8 + first.length,
      8 + first.length + second.length,
    ]],
  ).withRanges("methods.run.arguments.run", [[5, 5 + second.length]]);
  return {
    persisted: persistEvaluatedDefinition(
      definition,
      [],
      Definition.create({ name: "consumer" }),
      writer.values,
      NO_SCHEMAS,
      provenance,
    ),
    first,
    second,
  };
}

Deno.test("rehydrateEvaluatedDefinition: a typed replay restores one sentinel copy with no vault read and no recorded value, its map aligned exactly from the persisted coordinates", async () => {
  const { persisted } = typedCache();
  assertEquals(persisted.writtenReferences.length, 3);
  const { values, bag } = typedStep();
  const reads = 0;
  const restored = await rehydrateEvaluatedDefinition(persisted, bag);
  assertEquals(reads, 0);
  assertEquals(values.isEmpty, true);
  assertEquals(restored.definition, restored.executedDefinition);
  const token = restored.definition.globalArguments.token as string;
  const [a, b] = token.match(VaultSecretBag.SENTINEL_PATTERN)!;
  assertEquals(token, `Bearer ${a} ${b}`);
  const entryOf = (sentinel: string) => {
    const entry = bag.registry.issuedEntryOf(sentinel);
    if (entry === undefined || holdsValue(entry)) {
      throw new Error("expected a reference-only entry");
    }
    return entry;
  };
  assertEquals(entryOf(a).reference, SOURCE);
  assertEquals(entryOf(a).dataOrigin, false);
  assertEquals(entryOf(b).dataOrigin, true);
  assertEquals(entryOf(a).location, "consumer: globalArguments.token");
  const run = restored.definition.getMethodArguments("run").run as string;
  const [c] = run.match(VaultSecretBag.SENTINEL_PATTERN)!;
  assertEquals(run, `echo ${c} ${"${{ env.X }}"}`);
  // The map is in the sentinel copy's coordinates: each sentinel is data,
  // the authored text around it is not, whatever the sentinels' lengths.
  const map = restored.provenance!;
  assertEquals(map.rangesAt("globalArguments.token"), [
    [7, 7 + a.length],
    [8 + a.length, 8 + a.length + b.length],
  ]);
  assertEquals(map.rangesAt("methods.run.arguments.run"), [[5, 5 + c.length]]);
  assertEquals(
    map.overlapsData(
      "methods.run.arguments.run",
      run.indexOf("${{"),
      run.length,
    ),
    false,
  );
  // The restored copy persists back as the cache it came from.
  const again = persistEvaluatedDefinition(
    restored.definition,
    [],
    Definition.create({ name: "consumer" }),
    values,
    NO_SCHEMAS,
    map,
  );
  assertEquals(again.definition.toData(), persisted.definition.toData());
  assertEquals(again.writtenReferences.length, 3);
  assertEquals(
    again.persistedProvenance.toData(),
    persisted.persistedProvenance.toData(),
  );
});

Deno.test("rehydrateEvaluatedDefinition: a typed replay refuses a cache with references and a value-coordinate map only, and replays an unmapped cache as authored", async () => {
  const { persisted } = typedCache();
  const valueMap = ProvenanceMap.authored().withRanges(
    "globalArguments.token",
    [[7, 20]],
  );
  const error = assertThrows(
    () =>
      rehydrateEvaluatedDefinition({
        ...persisted,
        persistedProvenance: undefined,
        provenance: valueMap,
      }, typedStep().bag),
    UserError,
    "not replayed with references",
  );
  assertStringIncludes(error.message, "--last-evaluated");
  // No map at all: authored, as a cache from before provenance replays.
  const unmapped = await rehydrateEvaluatedDefinition({
    ...persisted,
    persistedProvenance: undefined,
    provenance: undefined,
  }, typedStep().bag);
  assertEquals(unmapped.provenance?.isAuthored, true);
  // A value-coordinate map with no references needs no realignment.
  const plain = await rehydrateEvaluatedDefinition({
    definition: Definition.create({
      name: "plain",
      globalArguments: { a: "x" },
    }),
    deferredExpressions: [],
    writtenReferences: [],
    provenance: valueMap,
  }, typedStep().bag);
  assertEquals(plain.provenance, valueMap);
});

Deno.test("withWrittenReferenceRanges: marks each written reference's range as data, keeps other ranges and whole-data paths, and skips a path that is not a string", () => {
  const ref = vaultReferenceText(SOURCE);
  const data = {
    a: `x ${ref} y ${ref} ${"${{ env.X }}"}`,
    whole: ref,
    n: 3,
  };
  const written = (
    path: (string | number)[],
    occurrence: number,
  ): WrittenReference => ({
    path,
    occurrence,
    ...SOURCE,
    encoding: "raw",
    dataOrigin: false,
  });
  const map = ProvenanceMap.authored()
    .withRanges("a", [[0, 1]])
    .withWholeData("whole");
  const out = withWrittenReferenceRanges(map, data, [
    written(["a"], 1),
    written(["a"], 0),
    written(["whole"], 0),
    written(["n"], 0),
  ]);
  assertEquals(out.rangesAt("a"), [
    [0, 1],
    [2, 2 + ref.length],
    [5 + ref.length, 5 + 2 * ref.length],
  ]);
  assertEquals(
    out.overlapsData("a", data.a.lastIndexOf("${{"), data.a.length),
    false,
  );
  assertEquals(out.isWholeDataAt("whole"), true);
  assertEquals(out.hasDataAtOrBelow("n"), false);
});

Deno.test("persistEvaluatedDefinition: two recorded values in one sensitive argument, joined by authored text, are written as their references and replay (untyped write)", () => {
  const values = new RunSensitiveValues();
  const bag = new VaultSecretBag(values.sentinels);
  const user = bag.addDataReference({ vaultName: "prod", key: "user" }, "args");
  const pass = bag.addDataReference({ vaultName: "prod", key: "pass" }, "args");
  values.addSecret(user, { vaultName: "prod", key: "user" });
  values.addSecret(pass, { vaultName: "prod", key: "pass" });
  const definition = Definition.create({
    name: "joined",
    globalArguments: { token: `${user}:${pass}` },
  });
  // Both halves are data; the colon between them is authored.
  const provenance = ProvenanceMap.authored().withRanges(
    "globalArguments.token",
    [[0, user.length], [user.length + 1, user.length + 1 + pass.length]],
  );
  const persisted = persistEvaluatedDefinition(
    definition,
    [],
    Definition.create({ name: "joined" }),
    values,
    SCHEMAS,
    provenance,
  );
  const refUser = vaultReferenceText({ vaultName: "prod", key: "user" });
  const refPass = vaultReferenceText({ vaultName: "prod", key: "pass" });
  assertEquals(
    persisted.definition.globalArguments.token,
    `${refUser}:${refPass}`,
  );
  assertEquals(persisted.maskedPaths, []);
  assertEquals(
    persisted.persistedProvenance.rangesAt("globalArguments.token"),
    [
      [0, refUser.length],
      [refUser.length + 1, refUser.length + 1 + refPass.length],
    ],
  );
  assertEquals(
    findPlaintextSensitiveArguments(
      SCHEMAS,
      persisted.definition.toData(),
      persisted.writtenReferences,
      {
        recordedMasks: persisted.maskedPaths,
        provenance,
        persistedProvenance: persisted.persistedProvenance,
      },
    ),
    [],
  );
});
