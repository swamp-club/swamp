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
import type { AggregateResourceResolver } from "../domain/datastore_v3/commit_authorization.ts";
import type { CommitChange } from "../domain/datastore_v3/commit_store.ts";
import type { Op } from "../domain/datastore_v3/op.ts";
import {
  deleteVersion,
  MODEL_ID,
  MODEL_TYPE,
  modelCommit,
  savePut,
  versionOp,
} from "../domain/datastore_v3/v3_test_helpers.ts";
import type { AccessResource } from "../domain/access/access_decision_service.ts";
import { createIntent, modelRef } from "../domain/datastore_v3/intent.ts";
import { putOp } from "../domain/datastore_v3/op.ts";
import { RecordKey } from "../domain/datastore_v3/record_key.ts";
import { partitionOf } from "../domain/datastore_v3/partition_key.ts";
import { ModelType } from "../domain/models/model_type.ts";
import { Definition } from "../domain/definitions/definition.ts";
import { dataChangesOf } from "./data_change_feed.ts";

const NAME = "web-servers";

const DEFINITION = Definition.create({
  id: MODEL_ID,
  name: NAME,
  globalArguments: {},
});

function resolver(known = true): AggregateResourceResolver {
  return {
    model: (ref) =>
      Promise.resolve(
        known && ref.id === MODEL_ID
          ? { type: MODEL_TYPE, definition: DEFINITION }
          : undefined,
      ),
    definitionTags: () => Promise.resolve(undefined),
    workflow: () => Promise.resolve(undefined),
    keyOwner: () => Promise.resolve(undefined),
    isRestrictedType: () => false,
    runRecordGuarded: () => Promise.resolve(false),
  };
}

function changeOf(cursor: number, ops: readonly Op[]): CommitChange {
  return { cursor, commit: modelCommit(cursor, ops) };
}

const everyone = (_: AccessResource) => true;

Deno.test("dataChangesOf: a save's several keys are one change, with its version", async () => {
  const change = changeOf(7, [await savePut("a", 2), versionOp("a", 2)]);
  const changes = await dataChangesOf(change, "", resolver(), everyone);
  assertEquals(changes, [{
    cursor: 7,
    at: change.commit.at,
    behavior: NAME,
    type: MODEL_TYPE.normalized,
    name: "a",
    version: 2,
    change: "saved",
  }]);
});

Deno.test("dataChangesOf: a delete says which version went", async () => {
  const changes = await dataChangesOf(
    changeOf(8, [deleteVersion("a", 1), deleteVersion("a", 2)]),
    "",
    resolver(),
    everyone,
  );
  assertEquals(
    changes.map((c) => [c.change, c.name, c.version]),
    [["deleted", "a", 1], ["deleted", "a", 2]],
  );
});

Deno.test("dataChangesOf: data the viewer cannot read is left out", async () => {
  const change = changeOf(9, [await savePut("a", 1)]);
  const seen: AccessResource[] = [];
  const changes = await dataChangesOf(change, "", resolver(), (resource) => {
    seen.push(resource);
    return false;
  });
  assertEquals(changes, []);
  assertEquals(seen.map((r) => [r.kind, r.name]), [["data", NAME]]);
});

Deno.test("dataChangesOf: another namespace, or a behavior that no longer resolves, sends nothing", async () => {
  const change = changeOf(10, [await savePut("a", 1)]);
  assertEquals(await dataChangesOf(change, "other", resolver(), everyone), []);
  assertEquals(
    await dataChangesOf(change, "", resolver(false), everyone),
    [],
  );
});

Deno.test("dataChangesOf: a filter keeps only the named behaviors and types", async () => {
  const change = changeOf(11, [await savePut("a", 1)]);
  const count = async (filter: Parameters<typeof dataChangesOf>[4]) =>
    (await dataChangesOf(change, "", resolver(), everyone, filter)).length;
  assertEquals(await count({ behaviors: [NAME] }), 1);
  assertEquals(await count({ behaviors: ["board"] }), 0);
  assertEquals(await count({ types: [MODEL_TYPE.normalized] }), 1);
  assertEquals(await count({ types: ["@kanban/board"] }), 0);
});

Deno.test("dataChangesOf: grant and token data never shows, even to someone who may read everything", async () => {
  const grant = ModelType.create("swamp/grant");
  const op = await putOp({
    intent: createIntent({
      kind: "data.save",
      model: modelRef(grant, MODEL_ID),
      name: "grant-main",
      version: 1,
    }),
    key: RecordKey.create(
      `data/${grant.normalized}/${MODEL_ID}/grant-main/1/raw`,
    ),
    inline: btoa("{}"),
  });
  const change = {
    cursor: 12,
    commit: modelCommit(12, [op], {
      partition: partitionOf({ kind: "model", type: grant, id: MODEL_ID }),
    }),
  };
  assertEquals(await dataChangesOf(change, "", resolver(), everyone), []);
});
