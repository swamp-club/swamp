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
import { Definition } from "../definitions/definition.ts";
import { RunSensitiveValues, vaultReferenceText } from "../secrets/mod.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import {
  mayHoldPlaintextSensitiveValues,
  persistEvaluatedDefinition,
  rehydrateEvaluatedDefinition,
} from "./persisted_evaluation.ts";

const SECRET = "Pl41n-s3cret";
const SOURCE = { vaultName: "prod", key: "api-token" };
const REF = vaultReferenceText(SOURCE);

function recorded(): RunSensitiveValues {
  const values = new RunSensitiveValues();
  values.addSecret(SECRET, SOURCE);
  return values;
}

/** The executed copy: a sentinel where the value was spliced, raw in a tag. */
function executed(bag: VaultSecretBag): Definition {
  const sentinel = bag.addDataSecret(SECRET);
  return Definition.create({
    name: "consumer",
    tags: { owner: SECRET },
    globalArguments: { token: `Bearer ${sentinel}` },
    methods: { run: { arguments: { run: `echo ${sentinel}` } } },
  });
}

Deno.test("persistEvaluatedDefinition: sentinels become references and tags placeholders", () => {
  const bag = new VaultSecretBag();
  const persisted = persistEvaluatedDefinition(
    executed(bag),
    [],
    Definition.create({ name: "consumer" }),
    recorded(),
    bag,
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
  const bag = new VaultSecretBag();
  const persisted = persistEvaluatedDefinition(
    Definition.create({ name: "consumer" }),
    [{
      id: "11111111-1111-4111-8111-111111111111",
      expression: "${{ inputs.token }}",
      bindings: { inputs: { token: SECRET } },
    }],
    Definition.create({ name: "consumer" }),
    recorded(),
    bag,
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
  const bag = new VaultSecretBag();
  const persisted = persistEvaluatedDefinition(
    executed(bag),
    [],
    Definition.create({ name: "consumer" }),
    recorded(),
    bag,
  );
  const values = new RunSensitiveValues();
  const stepBag = new VaultSecretBag();
  const restored = await rehydrateEvaluatedDefinition(
    persisted,
    () => Promise.resolve(SECRET),
    values,
    stepBag,
  );
  assertEquals(restored.definition.globalArguments, {
    token: `Bearer ${SECRET}`,
  });
  const executedToken = restored.executedDefinition.globalArguments
    .token as string;
  assertEquals(executedToken.includes(SECRET), false);
  assertEquals(stepBag.resolveRaw(executedToken), `Bearer ${SECRET}`);
  assertEquals(values.list().map((e) => e.value), [SECRET]);
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
