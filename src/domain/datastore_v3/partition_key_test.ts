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
  type AggregateIdentity,
  MAX_PARTITION_KEY_LENGTH,
  PartitionKey,
  partitionOf,
} from "./partition_key.ts";

const ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const RUN = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

Deno.test("partitionOf: a model key percent-encodes the normalized type", () => {
  const key = partitionOf({
    kind: "model",
    type: ModelType.create("swamp/grant"),
    id: ID,
  });
  assertEquals(key.toString(), `model--swamp%2Fgrant--${ID}`);
  assertEquals(key.kind, "model");
  assertEquals(key.identity, { kind: "model", type: "swamp/grant", id: ID });
});

Deno.test("partitionOf: a model key keeps '@' literal", () => {
  const key = partitionOf({
    kind: "model",
    type: ModelType.create("@swamp/aws-ec2"),
    id: ID,
  });
  assertEquals(key.toString(), `model--@swamp%2Faws-ec2--${ID}`);
});

Deno.test("partitionOf: every spelling of one model type gives one key", () => {
  const keys = ["aws::ec2", "AWS.EC2", "aws/ec2", " aws / ec2 "].map((raw) =>
    partitionOf({ kind: "model", type: ModelType.create(raw), id: ID })
      .toString()
  );
  assertEquals(new Set(keys).size, 1);
});

Deno.test("partitionOf: types that flattening would merge stay distinct", () => {
  const a = partitionOf({
    kind: "model",
    type: ModelType.create("a-b/c"),
    id: ID,
  });
  const b = partitionOf({
    kind: "model",
    type: ModelType.create("a/b-c"),
    id: ID,
  });
  assert(!a.equals(b));
});

Deno.test("partitionOf: builds run, config, lockfile and definition keys", () => {
  assertEquals(
    partitionOf({ kind: "run", workflowId: ID, runId: RUN }).toString(),
    `run--${ID}--${RUN}`,
  );
  assertEquals(
    partitionOf({
      kind: "config",
      definitionKind: "model",
      name: "@acme/web--server",
    }).toString(),
    "config--model--@acme%2Fweb--server",
  );
  assertEquals(
    partitionOf({ kind: "lockfile" }).toString(),
    "config--lockfile--upstream_extensions",
  );
  assertEquals(
    partitionOf({ kind: "definition", id: ID }).toString(),
    `definition--${ID}`,
  );
});

Deno.test("partitionOf: rejects ids that are not UUIDs and empty names", () => {
  const invalid: AggregateIdentity[] = [
    { kind: "model", type: ModelType.create("a/b"), id: "not-a-uuid" },
    { kind: "run", workflowId: ID, runId: "x" },
    { kind: "run", workflowId: "x", runId: RUN },
    { kind: "config", definitionKind: "workflow", name: "" },
    { kind: "definition", id: `${ID}--` },
  ];
  for (const identity of invalid) {
    assertThrows(() => partitionOf(identity));
  }
});

Deno.test("partitionOf: rejects an unknown kind and a raw type string", () => {
  assertThrows(() =>
    partitionOf({
      kind: "config",
      definitionKind: "lockfile",
      name: "x",
    } as unknown as AggregateIdentity)
  );
  assertThrows(() =>
    partitionOf({
      kind: "model",
      type: "a/b",
      id: ID,
    } as unknown as AggregateIdentity)
  );
  assertThrows(() =>
    partitionOf({ kind: "grant", id: ID } as unknown as AggregateIdentity)
  );
});

Deno.test("partitionOf: rejects a key longer than the limit", () => {
  assertThrows(
    () =>
      partitionOf({
        kind: "config",
        definitionKind: "vault",
        name: "/".repeat(MAX_PARTITION_KEY_LENGTH),
      }),
    Error,
    "longer than",
  );
});

Deno.test("PartitionKey.fromIdentity: refuses callers without the module token", () => {
  assertThrows(
    () =>
      PartitionKey.fromIdentity(
        Symbol("forged") as never,
        { kind: "lockfile" },
      ),
    Error,
    "partitionOf",
  );
});

Deno.test("PartitionKey.parse: round-trips every kind", () => {
  const keys = [
    partitionOf({ kind: "model", type: ModelType.create("a--b-"), id: ID }),
    partitionOf({ kind: "model", type: ModelType.create("@x/y"), id: ID }),
    partitionOf({ kind: "run", workflowId: ID, runId: RUN }),
    partitionOf({ kind: "config", definitionKind: "vault", name: "my vault" }),
    partitionOf({ kind: "lockfile" }),
    partitionOf({ kind: "definition", id: ID }),
  ];
  for (const key of keys) {
    const parsed = PartitionKey.parse(key.toString());
    assert(parsed.equals(key));
    assertEquals(parsed.identity, key.identity);
  }
});

Deno.test("PartitionKey.parse: rejects keys partitionOf never produces", () => {
  const invalid = [
    "",
    "grant--x",
    `model--swamp/grant--${ID}`, // unencoded '/'
    `model--swamp%2fgrant--${ID}`, // lowercase escape
    `model--swamp%2Dgrant--${ID}`, // '-' needlessly encoded
    `model--%40swamp%2Fgrant--${ID}`, // '@' encoded
    `model--Swamp%2Fgrant--${ID}`, // not normalized
    `model--swamp%2Fgrant--nope`,
    `model----${ID}`,
    `model--%E0%A4%A--${ID}`, // malformed escape
    `run--${ID}-${RUN}`,
    `run--${ID}--${RUN}x`,
    "config--secret--x",
    "config--model--",
    "config--lockfile--other",
    "definition--x",
  ];
  for (const value of invalid) {
    assertThrows(() => PartitionKey.parse(value), Error, undefined, value);
  }
});

Deno.test("PartitionKey.toJSON: serializes as the key string", () => {
  const key = partitionOf({ kind: "lockfile" });
  assertEquals(JSON.stringify({ key }), `{"key":"${key}"}`);
});
