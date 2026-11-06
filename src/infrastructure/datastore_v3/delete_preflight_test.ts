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
import { ModelType } from "../../domain/models/model_type.ts";
import { bindKey } from "../../domain/datastore_v3/intent_key_paths.ts";
import type { Op, TombstoneOp } from "../../domain/datastore_v3/op.ts";
import { deleteRemovalCommits } from "./delete_preflight.ts";

function tombstone(op: Op): TombstoneOp {
  if (op.kind !== "tombstone") throw new Error(`not a removal: ${op.kind}`);
  return op;
}

const ID = "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a01";
const type = ModelType.create("aws/ec2");

function plan(dataNames: string[]) {
  return {
    type,
    definition: { id: ID, name: "web" },
    outputs: [{ id: "out-1", methodName: "create" }],
    data: dataNames.flatMap((name) => [
      { name, version: 1 },
      { name, version: 2 },
    ]),
  };
}

Deno.test("deleteRemovalCommits: one removal per data name and one output, then the definition last", () => {
  const commits = deleteRemovalCommits(plan(["vpc", "subnet"]));
  assertEquals(commits.length, 2);
  assertEquals(
    commits[0].ops.map((op) => tombstone(op).intent.kind),
    ["output.delete", "data.delete", "data.delete"],
  );
  assertEquals(commits[1].ops.map((op) => tombstone(op).intent.kind), [
    "definition.delete",
  ]);
  assertEquals(
    tombstone(commits[1].ops[0]).key.toString(),
    "config/models/aws/ec2/web.yaml",
  );
});

Deno.test("deleteRemovalCommits: every key binds to its intent, as serve's check requires", () => {
  for (const commit of deleteRemovalCommits(plan(["vpc"]))) {
    for (const op of commit.ops.map(tombstone)) {
      const bound = bindKey(op.intent, "tombstone", op.key);
      assertEquals(bound.ok, true, `${op.intent.kind} ${op.key}`);
    }
  }
});

Deno.test("deleteRemovalCommits: many names split into commits within serve's caps, the definition still last", () => {
  const names = Array.from({ length: 2000 }, (_, i) => `name-${i}`);
  const commits = deleteRemovalCommits(plan(names));
  assertEquals(commits.length <= 16, true);
  for (const commit of commits) assertEquals(commit.ops.length <= 64, true);
  const last = commits.at(-1);
  assertEquals(last && tombstone(last.ops[0]).intent.kind, "definition.delete");
});

Deno.test("deleteRemovalCommits: long names stay within serve's body cap, the names past it judged at commit", () => {
  const names = Array.from(
    { length: 900 },
    (_, i) => `subnet-0abc123def456-route-assoc-${i}`,
  );
  const scoped = {
    ...plan(names),
    type: ModelType.create("@org/aws/ec2/instance"),
  };
  const commits = deleteRemovalCommits(scoped);
  const body = JSON.stringify({
    commits: commits.map(({ partition, ops }) => ({
      partition: partition.toString(),
      ops: ops.map((op) => op.toJSON()),
    })),
  });
  assertEquals(new TextEncoder().encode(body).byteLength < 256 * 1024, true);
  const last = commits.at(-1);
  assertEquals(last && tombstone(last.ops[0]).intent.kind, "definition.delete");
});
