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
import { ModelType } from "../models/model_type.ts";
import { CONTROL_PLANE_MODEL_TYPES } from "../models/control_plane_types.ts";
import {
  ACCESS_CONTROL_MODEL_TYPES,
  forwardedCommitClass,
  SHARED_INTENT_KINDS,
} from "./forwarded_commit_class.ts";
import { type Intent, INTENT_KINDS, intentPartition } from "./intent.ts";
import type { Op } from "./op.ts";
import { partitionOf } from "./partition_key.ts";
import { bindKey, LOCKFILE_RECORD_KEY } from "./intent_key_paths.ts";
import { RecordKey } from "./record_key.ts";
import { MODEL_ID, MODEL_TYPE, sampleIntent } from "./v3_test_helpers.ts";

function opOf(intent: Intent): Op {
  // the class reads only an op's kind and intent
  return { kind: "tombstone", intent } as unknown as Op;
}

Deno.test("forwardedCommitClass: only the listed intents are shared, outside access-control partitions", () => {
  for (const kind of INTENT_KINDS) {
    const intent = sampleIntent(kind);
    const partition = intentPartition(intent);
    const identity = partition.identity;
    const accessControl = identity.kind === "model" &&
      ACCESS_CONTROL_MODEL_TYPES.has(identity.type.replace(/^@/, ""));
    assertEquals(
      forwardedCommitClass(partition, [opOf(intent)]),
      SHARED_INTENT_KINDS.has(kind) && !accessControl ? "shared" : "exclusive",
      kind,
    );
  }
});

Deno.test("forwardedCommitClass: one exclusive op makes the commit exclusive", () => {
  const data = sampleIntent("data.save");
  const partition = intentPartition(data);
  assertEquals(forwardedCommitClass(partition, [opOf(data)]), "shared");
  assertEquals(
    forwardedCommitClass(partition, [
      opOf(data),
      opOf(sampleIntent("definition.edit")),
    ]),
    "exclusive",
  );
});

Deno.test("forwardedCommitClass: any write to an access-control partition is exclusive", () => {
  for (const type of ACCESS_CONTROL_MODEL_TYPES) {
    for (const spelling of [type, `@${type}`]) {
      const partition = partitionOf({
        kind: "model",
        type: ModelType.create(spelling),
        id: MODEL_ID,
      });
      const data = {
        ...sampleIntent("data.save"),
        model: { type: spelling, id: MODEL_ID },
      } as Intent;
      assertEquals(
        forwardedCommitClass(partition, [opOf(data)]),
        "exclusive",
        spelling,
      );
    }
  }
});

Deno.test("forwardedCommitClass: fleet records stay shared", () => {
  for (const type of ["swamp/step-lease", "swamp/pending-dispatch"]) {
    const partition = partitionOf({
      kind: "model",
      type: ModelType.create(type),
      id: MODEL_ID,
    });
    const data = {
      ...sampleIntent("data.save"),
      model: { type, id: MODEL_ID },
    } as Intent;
    assertEquals(forwardedCommitClass(partition, [opOf(data)]), "shared");
  }
});

Deno.test("forwardedCommitClass: no shared intent can write a record a resolver reads", () => {
  const sampleName = "web";
  const resolverRead = [
    `config/models/${MODEL_TYPE.normalized}/${sampleName}.yaml`,
    `config/workflows/workflow-${sampleName}.yaml`,
    `config/vaults/${sampleName}.yaml`,
    `auto-definitions/${MODEL_TYPE.normalized}/${MODEL_ID}.yaml`,
    LOCKFILE_RECORD_KEY,
  ];
  for (const kind of SHARED_INTENT_KINDS) {
    const intent = sampleIntent(kind);
    for (const key of resolverRead) {
      for (const opKind of ["put", "tombstone"] as const) {
        assertEquals(
          bindKey(intent, opKind, RecordKey.create(key)).ok,
          false,
          `${kind} ${opKind} ${key}`,
        );
      }
    }
  }
});

Deno.test("forwardedCommitClass: every control-plane type is classed as access control or as fleet", () => {
  // a new control-plane type fails here until it is placed: an access-control
  // type left out would be judged shared
  const fleet = new Set([
    "swamp/worker",
    "swamp/step-lease",
    "swamp/pending-dispatch",
    "swamp/fleet-probe",
  ]);
  for (const type of CONTROL_PLANE_MODEL_TYPES) {
    assertEquals(
      ACCESS_CONTROL_MODEL_TYPES.has(type) !== fleet.has(type),
      true,
      type,
    );
  }
  for (const type of ACCESS_CONTROL_MODEL_TYPES) {
    assertEquals(CONTROL_PLANE_MODEL_TYPES.includes(type), true, type);
  }
});
