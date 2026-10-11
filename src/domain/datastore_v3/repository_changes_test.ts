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
import type { TypedChange } from "./commit_log_unit_of_work.ts";
import { intentPartition } from "./intent.ts";
import { ModelChanges } from "./repository_changes.ts";
import { metadata, MODEL_ID, MODEL_TYPE } from "./v3_test_helpers.ts";

const changes = new ModelChanges(MODEL_TYPE, MODEL_ID);
const PREFIX = `data/${MODEL_TYPE.normalized}/${MODEL_ID}`;

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Each change's kind, key and intent, as plain data for comparison. */
function shape(change: TypedChange): Record<string, unknown> {
  const plain = (intent: unknown): unknown =>
    JSON.parse(JSON.stringify(intent));
  if ("put" in change) {
    return {
      put: change.put.key.toString(),
      intent: plain(change.put.intent),
    };
  }
  const op = change.op;
  return op.kind === "data-version"
    ? { version: op.key.toString(), name: op.metadata.name }
    : op.kind === "lease"
    ? { lease: op.holder }
    : { [op.kind]: op.key.toString(), intent: plain(op.intent) };
}

const MODEL = { type: MODEL_TYPE.normalized, id: MODEL_ID };

Deno.test("ModelChanges: a save puts its content and metadata and records the version", () => {
  const written = changes.writeVersion({ kind: "data.save" }, {
    name: "vpc",
    version: 2,
    metadata: metadata("vpc", 2),
    metadataBytes: bytes("name: vpc"),
    raw: bytes("{}"),
  });
  const intent = { kind: "data.save", model: MODEL, name: "vpc", version: 2 };
  assertEquals(written.map(shape), [
    { put: `${PREFIX}/vpc/2/raw`, intent },
    { put: `${PREFIX}/vpc/2/metadata.yaml`, intent },
    { version: `${PREFIX}/vpc/2/metadata.yaml`, name: "vpc" },
  ]);
  for (const change of written) {
    assert(change.partition.equals(changes.partition));
  }
});

Deno.test("ModelChanges: a rename's writes carry the rename intent, naming both names", () => {
  const written = changes.writeVersion(
    { kind: "data.rename", from: "old", to: "new" },
    {
      name: "new",
      version: 1,
      metadata: metadata("new", 1),
      metadataBytes: bytes("name: new"),
      raw: bytes("{}"),
    },
  );
  const latest = changes.latestPut(
    { kind: "data.rename", from: "old", to: "new" },
    "old",
    3,
    bytes("3"),
  );
  const intent = { kind: "data.rename", model: MODEL, name: "old", to: "new" };
  assertEquals(shape(written[0]), { put: `${PREFIX}/new/1/raw`, intent });
  assertEquals(shape(latest), { put: `${PREFIX}/old/latest`, intent });
});

Deno.test("ModelChanges: removals tombstone both files with the version, and a marker without one", () => {
  const intent = { kind: "data.gc", model: MODEL, name: "vpc", version: 4 };
  assertEquals(changes.removeVersion("data.gc", "vpc", 4).map(shape), [
    { tombstone: `${PREFIX}/vpc/4/raw`, intent },
    { tombstone: `${PREFIX}/vpc/4/metadata.yaml`, intent },
  ]);
  assertEquals(shape(changes.removeLatest("data.gc", "vpc")), {
    tombstone: `${PREFIX}/vpc/latest`,
    intent: { kind: "data.gc", model: MODEL, name: "vpc" },
  });
  // A marker lowered by a delete carries no version either.
  assertEquals(
    shape(changes.latestPut({ kind: "data.delete" }, "vpc", 1, bytes("1"))),
    {
      put: `${PREFIX}/vpc/latest`,
      intent: { kind: "data.delete", model: MODEL, name: "vpc" },
    },
  );
});

Deno.test("ModelChanges: an append and a save's marker name the version", () => {
  assertEquals(
    shape(changes.latestPut({ kind: "data.append" }, "s", 1, bytes("1"))),
    {
      put: `${PREFIX}/s/latest`,
      intent: { kind: "data.append", model: MODEL, name: "s", version: 1 },
    },
  );
  assertEquals(
    shape(changes.writeContent({ kind: "data.save" }, "s", 2, bytes("x"))),
    {
      put: `${PREFIX}/s/2/raw`,
      intent: { kind: "data.save", model: MODEL, name: "s", version: 2 },
    },
  );
});

Deno.test("ModelChanges: output records are keyed under outputs by type, method and file", () => {
  const intent = { kind: "output.save", model: MODEL, outputId: "o-1" };
  assertEquals(
    shape(changes.writeOutput("o-1", "create", "x.yaml", bytes("id: o-1"))),
    { put: `outputs/${MODEL_TYPE.normalized}/create/x.yaml`, intent },
  );
  assertEquals(shape(changes.removeOutput("o-1", "create", "x.yaml")), {
    tombstone: `outputs/${MODEL_TYPE.normalized}/create/x.yaml`,
    intent: { ...intent, kind: "output.delete" },
  });
});

Deno.test("ModelChanges: the partition is the model's, whatever the id's case", () => {
  const upper = new ModelChanges(MODEL_TYPE, MODEL_ID.toUpperCase());
  assert(upper.partition.equals(changes.partition));
  const [put] = upper.removeVersion("data.delete", "a", 1);
  assert("op" in put && put.op.kind === "tombstone");
  assert(intentPartition(put.op.intent).equals(changes.partition));
  // The key keeps the directory's own spelling.
  assertEquals(
    upper.dataKey("a", 1, "raw").toString(),
    `data/${MODEL_TYPE.normalized}/${MODEL_ID.toUpperCase()}/a/1/raw`,
  );
});

Deno.test("ModelChanges: refuses a name or version that could not be a data key", () => {
  assertThrows(() => changes.removeVersion("data.gc", "../escape", 1));
  assertThrows(() => changes.removeVersion("data.gc", "a", 0));
  assertThrows(() => new ModelChanges(ModelType.create("a/b"), "not-a-uuid"));
});
