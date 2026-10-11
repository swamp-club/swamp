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
import {
  AutoDefinitionChanges,
  ConfigChanges,
  ModelChanges,
  recordKeyOf,
  RunSnapshotChanges,
} from "./repository_changes.ts";
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

const NAME_PATH = "config/models/aws-ec2/vpc.yaml";
const ID = "3F0E7D1C-2B4A-4C6D-8E9F-0A1B2C3D4E5F";
const RUN = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

/** A change's precondition, if any. */
function expectOf(change: TypedChange): unknown {
  return "put" in change
    ? change.put.expect
    : change.op.kind === "tombstone"
    ? change.op.expect
    : undefined;
}

Deno.test("ConfigChanges: a definition's writes and removals carry the precondition they are given", () => {
  const config = new ConfigChanges("model", "vpc");
  assertEquals(config.partition.toString(), "config--model--vpc");
  const key = recordKeyOf(NAME_PATH.split("/"));
  const create = config.write("definition.create", key, bytes("a"), "absent");
  const edit = config.write("definition.edit", key, bytes("b"), {
    sha256: "a".repeat(64),
  });
  const moved = config.remove("definition.edit", key, "present");
  const deleted = config.remove("definition.delete", key);
  const definition = { kind: "model", name: "vpc" };
  assertEquals(shape(create), {
    put: NAME_PATH,
    intent: { kind: "definition.create", definition },
  });
  assertEquals(expectOf(create), "absent");
  assertEquals(expectOf(edit), { sha256: "a".repeat(64) });
  assertEquals(shape(moved), {
    tombstone: NAME_PATH,
    intent: { kind: "definition.edit", definition },
  });
  assertEquals(expectOf(moved), "present");
  assertEquals(expectOf(deleted), undefined);
  for (const change of [create, edit, moved, deleted]) {
    const intent = "put" in change
      ? change.put.intent
      : (change.op as { intent: Parameters<typeof intentPartition>[0] })
        .intent;
    assert(intentPartition(intent).equals(config.partition));
  }
});

Deno.test("ConfigChanges: a rename puts under the new name expecting absent and tombstones the old expecting present", () => {
  const key = recordKeyOf(["config", "workflows", `${ID}.yaml`]);
  const to = new ConfigChanges("workflow", "Deploy.Prod").renameTo(
    "Deploy.Old",
    key,
    bytes("w"),
  );
  const from = new ConfigChanges("workflow", "Deploy.Old").renameFrom(
    "Deploy.Prod",
    key,
  );
  assertEquals(shape(to), {
    put: key.toString(),
    intent: {
      kind: "definition.rename-to",
      definition: { kind: "workflow", name: "Deploy.Prod" },
      from: "Deploy.Old",
    },
  });
  assertEquals(expectOf(to), "absent");
  assertEquals(shape(from), {
    tombstone: key.toString(),
    intent: {
      kind: "definition.rename-from",
      definition: { kind: "workflow", name: "Deploy.Old" },
      to: "Deploy.Prod",
    },
  });
  assertEquals(expectOf(from), "present");
  assertEquals(to.partition.toString(), "config--workflow--Deploy.Prod");
});

Deno.test("ConfigChanges: an evaluated workflow carries no precondition, and only a workflow has one", () => {
  const key = recordKeyOf(["workflows-evaluated", "workflow-deploy.yaml"]);
  const workflow = new ConfigChanges("workflow", "deploy");
  const saved = workflow.write("evaluated-workflow.save", key, bytes("e"));
  assertEquals(expectOf(saved), undefined);
  assertEquals(
    shape(workflow.remove("evaluated-workflow.delete", key)).tombstone,
    key.toString(),
  );
  assertThrows(
    () =>
      new ConfigChanges("model", "deploy").write(
        "evaluated-workflow.save",
        key,
        bytes("e"),
      ),
    Error,
    "needs a workflow definition",
  );
});

Deno.test("AutoDefinitionChanges: saves and deletes in the id's partition, without a precondition", () => {
  const auto = new AutoDefinitionChanges(ID);
  assertEquals(auto.partition.toString(), `definition--${ID.toLowerCase()}`);
  const key = recordKeyOf(["auto-definitions", "aws-ec2", "vpc.yaml"]);
  const saved = auto.write(key, bytes("a"));
  const removed = auto.remove(key);
  assertEquals(shape(saved), {
    put: key.toString(),
    intent: {
      kind: "auto-definition.save",
      autoDefinition: { id: ID.toLowerCase() },
    },
  });
  assertEquals(shape(removed).intent, {
    kind: "auto-definition.delete",
    autoDefinition: { id: ID.toLowerCase() },
  });
  assertEquals([expectOf(saved), expectOf(removed)], [undefined, undefined]);
});

Deno.test("RunSnapshotChanges and evaluated definitions land in the run's and the model's partitions", () => {
  const snapshot = new RunSnapshotChanges(ID, RUN);
  assertEquals(
    snapshot.partition.toString(),
    `run--${ID.toLowerCase()}--${RUN}`,
  );
  const key = recordKeyOf([
    "workflows-evaluated",
    "runs",
    RUN,
    "evaluated-workflow.yaml",
  ]);
  assertEquals(shape(snapshot.write(key, bytes("s"))).intent, {
    kind: "run-snapshot.save",
    run: { workflowId: ID.toLowerCase(), runId: RUN },
  });
  assertEquals(shape(snapshot.remove(key)).intent, {
    kind: "run-snapshot.delete",
    run: { workflowId: ID.toLowerCase(), runId: RUN },
  });
  const evaluated = recordKeyOf([
    "definitions-evaluated",
    "aws-ec2",
    "vpc.yaml",
  ]);
  const saved = changes.writeEvaluatedDefinition(evaluated, bytes("d"));
  assert(saved.partition.equals(changes.partition));
  assertEquals(shape(saved), {
    put: evaluated.toString(),
    intent: { kind: "evaluated-definition.save", model: MODEL },
  });
  assertEquals(expectOf(saved), undefined);
  assertEquals(
    shape(changes.removeEvaluatedDefinition(evaluated)).intent,
    { kind: "evaluated-definition.delete", model: MODEL },
  );
});

Deno.test("recordKeyOf: refuses a segment holding a separator, and an unsafe key", () => {
  assertEquals(
    recordKeyOf(["config", "models", "a.yaml"]).toString(),
    "config/models/a.yaml",
  );
  assertThrows(
    () => recordKeyOf(["config", "models/a.yaml"]),
    Error,
    "separator",
  );
  assertThrows(() => recordKeyOf(["config", "a\\b.yaml"]), Error, "separator");
  assertThrows(() => recordKeyOf(["config", ".."]), Error);
  assertThrows(() => recordKeyOf(["config", ""]), Error);
});
