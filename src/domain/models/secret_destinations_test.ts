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

import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import { UserError } from "../errors.ts";
import { SECRET_DESTINATION_REFUSED } from "../expressions/errors.ts";
import { SecretBagRegistry } from "../vaults/secret_bag_registry.ts";
import { secretOccurrencesOf } from "../vaults/secret_occurrences.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import type {
  MethodDefinition,
  ModelDefinition,
  SecretDestinationArgs,
} from "./model.ts";
import { ModelType } from "./model_type.ts";
import {
  assertModelSecretsMetadataValid,
  assertNoSensitiveRefuseConflict,
  refuseSecretDestinations,
  refuseSecretsInRefusingFields,
  refusesSecrets,
  SecretDestinationRefusedError,
} from "./secret_destinations.ts";

const REF = { vaultName: "v", key: "k" };
const DATA_REF = { vaultName: "w", key: "j" };

/** A typed run that issued one vault.get() reference and one data reference. */
function issued(): {
  registry: SecretBagRegistry;
  sentinel: string;
  data: string;
} {
  const registry = new SecretBagRegistry({ typedSecrets: true });
  const bag = new VaultSecretBag(registry);
  return {
    registry,
    sentinel: bag.addSecret(REF, "methods.run.arguments.x"),
    data: bag.addDataReference(DATA_REF, "db/main.password"),
  };
}

const refusing = z.string().meta({ secrets: "refuse" });

Deno.test("refusesSecrets: only the exact value refuse marks a field", () => {
  assertEquals(refusesSecrets({ secrets: "refuse" }), true);
  assertEquals(refusesSecrets({ secrets: "allow" }), false);
  assertEquals(refusesSecrets({ secrets: true }), false);
  assertEquals(refusesSecrets({ secrets: ["refuse"] }), false);
  assertEquals(refusesSecrets({ sensitive: true }), false);
  assertEquals(refusesSecrets({}), false);
});

Deno.test("refuseSecretsInRefusingFields: a sentinel anywhere under a refusing field is refused: scalar, nested, list, map, union and composed text", () => {
  const { registry, sentinel, data } = issued();
  const secrets = secretOccurrencesOf(registry);
  const schema = z.object({
    path: refusing.optional(),
    nested: z.object({ dir: refusing }).optional(),
    list: z.array(refusing).optional(),
    map: z.record(z.string(), refusing).optional(),
    union: z.union([refusing, z.number()]).optional(),
    free: z.string().optional(),
  });
  const cases: [string, Record<string, unknown>][] = [
    ["path", { path: sentinel }],
    ["path", { path: `prefix-${sentinel}-suffix` }],
    ["path", { path: `${sentinel}${data}` }],
    ["nested.dir", { nested: { dir: data } }],
    ["list[1]", { list: ["ok", sentinel] }],
    ["map.a", { map: { a: sentinel } }],
    ["union", { union: sentinel }],
  ];
  for (const [path, args] of cases) {
    const error = assertThrows(
      () =>
        refuseSecretsInRefusingFields(schema, args, secrets, "method argument"),
      SecretDestinationRefusedError,
    );
    assertEquals(error.destination, `method argument '${path}'`);
    assertEquals(error.code, "secret_destination_refused");
    assertEquals(error.message.includes(sentinel), false);
    assertEquals(error.message.includes(data), false);
  }
  // A secret in a field that takes secrets, text the run did not issue, and
  // plain text pass.
  refuseSecretsInRefusingFields(
    schema,
    { free: sentinel },
    secrets,
    "method argument",
  );
  refuseSecretsInRefusingFields(
    schema,
    { path: `__SWAMP_VSEC_${"ab".repeat(16)}_0__` },
    secrets,
    "method argument",
  );
  refuseSecretsInRefusingFields(
    schema,
    { path: "plain", nested: { dir: "/tmp" }, list: ["a"], map: { k: "v" } },
    secrets,
    "method argument",
  );
});

Deno.test("refuseSecretsInRefusingFields: names the reference and where it was read, never a value", () => {
  const { registry, data } = issued();
  const error = assertThrows(
    () =>
      refuseSecretsInRefusingFields(
        z.object({ dir: refusing }),
        { dir: data },
        secretOccurrencesOf(registry),
        "method argument",
      ),
    SecretDestinationRefusedError,
  );
  assertEquals(error.reference, DATA_REF);
  assertEquals(
    error.message,
    "Refused to deliver secret 'j' in vault 'w' to method argument 'dir' " +
      "(at db/main.password): the field refuses secrets " +
      "(secret_destination_refused)",
  );
});

Deno.test("refuseSecretsInRefusingFields: a schema that marks nothing is not walked", () => {
  const { registry, sentinel } = issued();
  refuseSecretsInRefusingFields(
    z.object({ a: z.string() }),
    { a: sentinel },
    secretOccurrencesOf(registry),
    "method argument",
  );
});

Deno.test("assertNoSensitiveRefuseConflict: a field marked both sensitive and refuse fails, in either wrapper order and inside containers", () => {
  const both = z.string().meta({ sensitive: true, secrets: "refuse" });
  const conflicts: [string, z.ZodTypeAny][] = [
    ["a", z.object({ a: both })],
    [
      "a",
      z.object({
        a: z.string().meta({ sensitive: true }).optional().meta({
          secrets: "refuse",
        }),
      }),
    ],
    [
      "a",
      z.object({
        a: z.string().meta({ secrets: "refuse" }).optional().meta({
          sensitive: true,
        }),
      }),
    ],
    ["list[]", z.object({ list: z.array(both) })],
    ["map[*]", z.object({ map: z.record(z.string(), both) })],
    ["pair[1]", z.object({ pair: z.tuple([z.string(), both]) })],
    [
      "choice.token",
      z.object({ choice: z.union([z.object({ token: both }), z.string()]) }),
    ],
    ["outer.inner", z.object({ outer: z.object({ inner: both }) })],
  ];
  for (const [path, schema] of conflicts) {
    const error = assertThrows(
      () =>
        assertNoSensitiveRefuseConflict(
          schema,
          "Behavior type 't' method 'm' arguments",
        ),
      Error,
    );
    assertEquals(
      error.message.startsWith(
        `Behavior type 't' method 'm' arguments: field '${path}' is marked ` +
          `both sensitive and secrets: "refuse"`,
      ),
      true,
      error.message,
    );
  }
});

Deno.test("assertNoSensitiveRefuseConflict: sensitive alone, refuse alone, any other secrets value, and no schema pass", () => {
  assertNoSensitiveRefuseConflict(
    z.object({
      a: z.string().meta({ sensitive: true }),
      b: z.string().meta({ secrets: "refuse" }),
      c: z.string().meta({ sensitive: true, secrets: "custom" }),
      d: z.string().meta({ sensitive: true, secrets: ["refuse"] }),
      e: z.array(z.string().meta({ secrets: "refuse" })),
    }),
    "owner",
  );
  assertNoSensitiveRefuseConflict(undefined, "owner");
});

Deno.test("assertModelSecretsMetadataValid: checks the global arguments and every method's arguments", () => {
  const type = ModelType.create("test/conflict");
  const method = (schema: z.ZodTypeAny): MethodDefinition => ({
    description: "m",
    arguments: schema,
    execute: () => Promise.resolve({}),
  });
  assertModelSecretsMetadataValid({
    type,
    globalArguments: z.object({ g: z.string().meta({ sensitive: true }) }),
    methods: { run: method(z.object({ a: refusing })) },
  });
  const bad = z.object({
    a: z.string().meta({ sensitive: true, secrets: "refuse" }),
  });
  const inGlobals = assertThrows(
    () =>
      assertModelSecretsMetadataValid({
        type,
        globalArguments: bad,
        methods: {},
      }),
    Error,
  );
  assertEquals(
    inGlobals.message.startsWith(
      "Behavior type 'test/conflict' global arguments: field 'a'",
    ),
    true,
    inGlobals.message,
  );
  const inMethod = assertThrows(
    () =>
      assertModelSecretsMetadataValid({ type, methods: { run: method(bad) } }),
    Error,
  );
  assertEquals(
    inMethod.message.startsWith(
      "Behavior type 'test/conflict' method 'run' arguments: field 'a'",
    ),
    true,
    inMethod.message,
  );
});

/** A type whose `root` global and `workingDir` method argument refuse secrets. */
function stageModel(
  hook?: (args: SecretDestinationArgs) => void,
): ModelDefinition {
  return {
    type: ModelType.create("test/stage"),
    version: "2026.10.20.1",
    globalArguments: z.object({
      root: refusing.optional(),
      token: z.string().optional(),
    }),
    methods: {
      run: {
        description: "r",
        arguments: z.object({
          workingDir: refusing.optional(),
          command: z.string().optional(),
          token: z.string().optional(),
        }),
        execute: () => Promise.resolve({}),
        ...(hook ? { refuseSecretDestinations: hook } : {}),
      },
    },
  };
}

Deno.test("refuseSecretDestinations: refuses a refusing global argument, then a refusing field of the merged arguments wherever it was authored", () => {
  const { registry, sentinel } = issued();
  const model = stageModel();
  const stage = (
    globalArguments: Record<string, unknown>,
    mergedArguments: Record<string, unknown>,
  ) =>
    refuseSecretDestinations({
      modelDef: model,
      method: model.methods.run,
      globalArguments,
      mergedArguments,
      registry,
      localPlacement: true,
    });
  const global = assertThrows(
    () => stage({ root: sentinel }, { root: sentinel }),
    SecretDestinationRefusedError,
  );
  assertEquals(global.destination, "global argument 'root'");
  // workingDir authored under globalArguments reaches the method through the
  // merge, and the global schema does not know the key: the merged walk does.
  const merged = assertThrows(
    () => stage({ workingDir: sentinel }, { workingDir: sentinel }),
    SecretDestinationRefusedError,
  );
  assertEquals(merged.destination, "method argument 'workingDir'");
  // A secret in a field that takes secrets passes.
  stage({ token: sentinel }, { token: sentinel, command: `echo ${sentinel}` });
});

Deno.test("refuseSecretDestinations: the method hook sees the merged arguments and a value-free view, for local placement only, and a run with no sentinel runs nothing", () => {
  const { registry, sentinel } = issued();
  const seen: SecretDestinationArgs[] = [];
  const model = stageModel((args) => {
    seen.push(args);
  });
  const run = (localPlacement: boolean, reg = registry) =>
    refuseSecretDestinations({
      modelDef: model,
      method: model.methods.run,
      globalArguments: { token: sentinel },
      mergedArguments: { token: sentinel, command: `x ${sentinel}` },
      registry: reg,
      localPlacement,
    });
  run(false);
  assertEquals(seen.length, 0);
  run(true);
  assertEquals(seen.length, 1);
  assertEquals(seen[0].arguments, {
    token: sentinel,
    command: `x ${sentinel}`,
  });
  const [occurrence] = seen[0].secrets.occurrencesIn(`x ${sentinel}`);
  assertEquals(occurrence.reference, REF);
  assertEquals("value" in occurrence, false);
  assertEquals(Object.keys(seen[0].secrets).sort(), [
    "occurrencesIn",
    "originOf",
  ]);
  // Nothing issued: nothing to refuse, and the hook is not called.
  run(true, new SecretBagRegistry({ typedSecrets: true }));
  assertEquals(seen.length, 1);
  // A hook refusal propagates as it is.
  const refusingModel = stageModel(() => {
    throw new SecretDestinationRefusedError(
      "the shell command",
      REF,
      undefined,
      "test",
    );
  });
  assertThrows(
    () =>
      refuseSecretDestinations({
        modelDef: refusingModel,
        method: refusingModel.methods.run,
        globalArguments: {},
        mergedArguments: { command: sentinel },
        registry,
        localPlacement: true,
      }),
    SecretDestinationRefusedError,
    "the shell command",
  );
});

Deno.test("SecretDestinationRefusedError: names the destination, the reference and the location, with the stable code and no value", () => {
  const error = new SecretDestinationRefusedError(
    "method argument 'workingDir'",
    { vaultName: "prod", key: "DB_PASS" },
    "methods.execute.arguments.workingDir",
    "the field refuses secrets",
  );
  assertEquals(error instanceof UserError, true);
  assertEquals(error.code, SECRET_DESTINATION_REFUSED);
  assertEquals(error.code, "secret_destination_refused");
  assertEquals(error.name, "SecretDestinationRefusedError");
  assertEquals(error.destination, "method argument 'workingDir'");
  assertEquals(error.reference, { vaultName: "prod", key: "DB_PASS" });
  assertEquals(
    error.message,
    "Refused to deliver secret 'DB_PASS' in vault 'prod' to method argument " +
      "'workingDir' (at methods.execute.arguments.workingDir): the field " +
      "refuses secrets (secret_destination_refused)",
  );
});

Deno.test("SecretDestinationRefusedError: an entry with no reference or location is named as a secret of the run", () => {
  const error = new SecretDestinationRefusedError(
    "an environment variable name",
    undefined,
    undefined,
    "a secret can be a value, never a name",
  );
  assertEquals(
    error.message,
    "Refused to deliver a secret of this run to an environment variable " +
      "name: a secret can be a value, never a name (secret_destination_refused)",
  );
});
