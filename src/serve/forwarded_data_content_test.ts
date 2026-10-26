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

import { assert, assertEquals } from "@std/assert";
import { createIntent, type Intent } from "../domain/datastore_v3/intent.ts";
import {
  type Op,
  type PutOp,
  putOp,
  tombstoneOp,
} from "../domain/datastore_v3/op.ts";
import { partitionOf } from "../domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../domain/datastore_v3/record_key.ts";
import { ModelType } from "../domain/models/model_type.ts";
import type {
  ContentCheckContext,
  PriorRecord,
} from "./forwarded_content_authorization.ts";
import { checkDataPut } from "./forwarded_data_content.ts";

const TYPE = ModelType.create("acme/web");
const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BASE = `data/${TYPE.normalized}/${ID}`;
const encoder = new TextEncoder();

/** A context over stored records by key; inline puts read as themselves. */
function context(stored: Record<string, string>): ContentCheckContext {
  return {
    deps: {
      partition: partitionOf({ kind: "model", type: TYPE, id: ID }),
    } as ContentCheckContext["deps"],
    authority: { allows: () => true, allowsAll: () => true },
    bytesOf: (op: PutOp) =>
      Promise.resolve(
        Uint8Array.from(
          atob((op.content as { inline: string }).inline),
          (c) => c.charCodeAt(0),
        ),
      ),
    prior: (_partition, key): Promise<PriorRecord> =>
      Promise.resolve(
        key in stored
          ? { kind: "present", bytes: encoder.encode(stored[key]) }
          : { kind: "absent" },
      ),
    digest: () => Promise.resolve(null),
    holdsRecordsUnder: () => Promise.resolve(false),
    recheckUnderLock: () => {},
    now: () => new Date(),
  };
}

function marker(intent: Intent, version: string): Promise<PutOp> {
  return putOp({
    intent: createIntent(intent),
    key: RecordKey.create(`${BASE}/vpc/latest`),
    inline: btoa(version),
  });
}

const remove: Intent = {
  kind: "data.delete",
  model: { type: TYPE.normalized, id: ID },
  name: "vpc",
};

Deno.test("checkDataPut: a removal may lower or keep the latest marker to a stored version, never raise it or name an absent one", async () => {
  const stored = {
    [`${BASE}/vpc/latest`]: "2",
    [`${BASE}/vpc/1/metadata.yaml`]: "x",
    [`${BASE}/vpc/2/metadata.yaml`]: "x",
  };
  const judged = async (version: string, commit: Op[] = []) => {
    const op = await marker(remove, version);
    return await checkDataPut(context(stored), op, [op, ...commit]);
  };
  assertEquals(await judged("1"), undefined);
  assertEquals(await judged("2"), undefined);
  assert(await judged("3") !== undefined);
  assert(await judged("01") !== undefined);
  assert(await judged("1 ") !== undefined);
  // Lowered to a version the same commit removes.
  assert(
    await judged("1", [
      tombstoneOp({
        intent: createIntent({ ...remove, version: 1 }),
        key: RecordKey.create(`${BASE}/vpc/1/metadata.yaml`),
      }),
    ]) !== undefined,
  );
});

Deno.test("checkDataPut: a removal may not write a version's bytes", async () => {
  const op = await putOp({
    intent: createIntent({ ...remove, version: 1 }),
    key: RecordKey.create(`${BASE}/vpc/1/raw`),
    inline: btoa("chosen"),
  });
  assert(await checkDataPut(context({}), op, [op]) !== undefined);
});

Deno.test("checkDataPut: a rename's markers name only versions the rename writes", async () => {
  const rename: Intent = {
    kind: "data.rename",
    model: { type: TYPE.normalized, id: ID },
    name: "vpc",
    to: "net",
  };
  const stored = {
    [`${BASE}/vpc/latest`]: "1",
    [`${BASE}/vpc/1/metadata.yaml`]: [
      "name: vpc",
      `id: ${ID}`,
      "version: 1",
      "contentType: application/json",
      "lifetime: infinite",
      "garbageCollection: 10",
      "streaming: false",
      "tags:",
      "  type: resource",
      "ownerDefinition:",
      "  ownerType: manual",
      "  ownerRef: test",
      'createdAt: "2026-10-26T00:00:00.000Z"',
    ].join("\n"),
  };
  const written = await putOp({
    intent: createIntent(rename),
    key: RecordKey.create(`${BASE}/net/1/metadata.yaml`),
    inline: btoa("x"),
  });
  const latest = (version: string) =>
    putOp({
      intent: createIntent(rename),
      key: RecordKey.create(`${BASE}/net/latest`),
      inline: btoa(version),
    });
  const good = await latest("1");
  assertEquals(
    await checkDataPut(context(stored), good, [written, good]),
    undefined,
  );
  const stray = await latest("7");
  assert(
    await checkDataPut(context(stored), stray, [written, stray]) !== undefined,
  );
});
