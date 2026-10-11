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

import { assert, assertEquals, assertThrows } from "@std/assert";
import { ModelType } from "../models/model_type.ts";
import {
  CONTROL_PLANE_INTENT_TYPES,
  createIntent,
  INTENT_KINDS,
  intentEquals,
  intentPartition,
  modelRef,
} from "./intent.ts";
import { partitionOf } from "./partition_key.ts";

const ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const RUN = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const MODEL = modelRef(ModelType.create("@swamp/aws-ec2"), ID);

/** A valid intent of every kind, built from its required fields. */
function sampleOf(kind: string): Record<string, unknown> {
  const required = CONTROL_PLANE_INTENT_TYPES[
    kind as keyof typeof CONTROL_PLANE_INTENT_TYPES
  ];
  const model = required === undefined
    ? MODEL
    : modelRef(ModelType.create(required), ID);
  if (kind === "data.save") return { kind, model, name: "vpc", version: 1 };
  if (kind === "data.delete" || kind === "data.gc") {
    return { kind, model, name: "vpc", version: 2 };
  }
  if (kind === "data.rename") return { kind, model, name: "a", to: "b" };
  if (kind.startsWith("output.")) return { kind, model, outputId: "o-1" };
  if (kind.startsWith("run")) {
    return { kind, run: { workflowId: ID, runId: RUN } };
  }
  if (kind === "definition.rename-to") {
    return { kind, definition: { kind: "vault", name: "new" }, from: "old" };
  }
  if (kind === "definition.rename-from") {
    return { kind, definition: { kind: "vault", name: "old" }, to: "new" };
  }
  if (kind.startsWith("evaluated-workflow.")) {
    return { kind, definition: { kind: "workflow", name: "deploy" } };
  }
  if (kind.startsWith("definition.")) {
    return { kind, definition: { kind: "model", name: "web" } };
  }
  if (kind === "auto-definition.save") {
    return { kind, autoDefinition: { id: ID } };
  }
  if (kind === "lockfile.write") return { kind };
  return { kind, model };
}

Deno.test("createIntent: accepts every intent kind and returns a frozen canonical copy", () => {
  for (const kind of INTENT_KINDS) {
    const input = sampleOf(kind);
    const intent = createIntent(input);
    assertEquals(intent, input);
    assert(Object.isFrozen(intent));
    assert(
      intentEquals(intent, createIntent(JSON.parse(JSON.stringify(input)))),
    );
  }
});

Deno.test("intentPartition: maps each aggregate's intents to its partition", () => {
  assert(
    intentPartition(createIntent(sampleOf("data.save"))).equals(
      partitionOf({
        kind: "model",
        type: ModelType.create("@swamp/aws-ec2"),
        id: ID,
      }),
    ),
  );
  assert(
    intentPartition(createIntent(sampleOf("run.update"))).equals(
      partitionOf({ kind: "run", workflowId: ID, runId: RUN }),
    ),
  );
  assert(
    intentPartition(createIntent(sampleOf("definition.edit"))).equals(
      partitionOf({ kind: "config", definitionKind: "model", name: "web" }),
    ),
  );
  assert(
    intentPartition(createIntent(sampleOf("auto-definition.save"))).equals(
      partitionOf({ kind: "definition", id: ID }),
    ),
  );
  assert(
    intentPartition(createIntent(sampleOf("lockfile.write"))).equals(
      partitionOf({ kind: "lockfile" }),
    ),
  );
});

Deno.test("createIntent: a rename's two halves land in the two names' partitions", () => {
  const to = intentPartition(createIntent(sampleOf("definition.rename-to")));
  const from = intentPartition(
    createIntent(sampleOf("definition.rename-from")),
  );
  assertEquals(to.toString(), "config--vault--new");
  assertEquals(from.toString(), "config--vault--old");
});

Deno.test("createIntent: a data delete may omit its version", () => {
  const intent = createIntent({ kind: "data.delete", model: MODEL, name: "x" });
  assertEquals("version" in intent, false);
});

Deno.test("createIntent: control-plane intents need their model type, in either spelling", () => {
  createIntent({
    kind: "grant.revoke",
    model: modelRef(ModelType.create("@swamp/grant"), ID),
  });
  createIntent({
    kind: "grant.revoke",
    model: modelRef(ModelType.create("swamp/grant"), ID),
  });
  assertThrows(
    () => createIntent({ kind: "grant.revoke", model: MODEL }),
    Error,
    "swamp/grant",
  );
  assertThrows(() =>
    createIntent({
      kind: "worker.delete",
      model: modelRef(ModelType.create("swamp/group"), ID),
    })
  );
});

Deno.test("createIntent: rejects malformed intents", () => {
  const invalid: unknown[] = [
    null,
    { kind: "data.explode", model: MODEL },
    { kind: "data.save", model: MODEL, name: "x" },
    { kind: "data.save", model: MODEL, name: "x", version: 0 },
    { kind: "data.save", model: MODEL, name: "x", version: 1.5 },
    { kind: "data.save", model: MODEL, name: "../x", version: 1 },
    { kind: "data.save", model: MODEL, name: "a/b", version: 1 },
    { kind: "data.save", model: MODEL, name: "", version: 1 },
    {
      kind: "data.save",
      model: { type: "AWS.EC2", id: ID },
      name: "x",
      version: 1,
    },
    {
      kind: "data.save",
      model: { type: "aws/ec2", id: "x" },
      name: "x",
      version: 1,
    },
    { kind: "data.save", model: MODEL, name: "x", version: 1, extra: true },
    { kind: "evaluated-definition.save", model: { ...MODEL, extra: 1 } },
    { kind: "run.update", run: { workflowId: ID } },
    { kind: "definition.edit", definition: { kind: "secret", name: "x" } },
    {
      kind: "evaluated-workflow.save",
      definition: { kind: "model", name: "x" },
    },
    { kind: "definition.rename-to", definition: { kind: "model", name: "x" } },
    { kind: "auto-definition.save", autoDefinition: { id: "nope" } },
    { kind: "lockfile.write", name: "other" },
  ];
  for (const value of invalid) {
    assertThrows(
      () => createIntent(value),
      Error,
      undefined,
      JSON.stringify(value),
    );
  }
});

Deno.test("modelRef: keeps only the normalized type", () => {
  assertEquals(modelRef(ModelType.create("AWS::EC2"), ID), {
    type: "aws/ec2",
    id: ID,
  });
  assertThrows(
    () => modelRef("aws/ec2" as unknown as ModelType, ID),
    TypeError,
  );
});
