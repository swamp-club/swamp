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
import { BlobRef } from "../domain/datastore_v3/blob_ref.ts";
import { createIntent } from "../domain/datastore_v3/intent.ts";
import { putOp } from "../domain/datastore_v3/op.ts";
import { partitionOf } from "../domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../domain/datastore_v3/record_key.ts";
import type { V3Datastore } from "../infrastructure/datastore_v3/v3_datastore.ts";
import {
  ForwardedContentAuthority,
  type ForwardedContentDeps,
} from "./forwarded_content_authorization.ts";
import type { ConnectionContext } from "./handlers/shared.ts";

/** Deps whose datastore records every chunk read, and holds no records. */
function deps(possessed: boolean): {
  deps: ForwardedContentDeps;
  reads: string[];
} {
  const reads: string[] = [];
  const v3 = {
    namespace: "",
    chunkStore: {
      read: (_ns: unknown, blob: BlobRef) => {
        reads.push(blob.sha256);
        return ReadableStream.from([new TextEncoder().encode("name: web\n")]);
      },
    },
    readModel: {
      liveRecord: () => Promise.resolve(undefined),
      recordBytes: () => Promise.resolve(undefined),
      holdsRecordsUnder: () => Promise.resolve(false),
    },
  } as unknown as V3Datastore;
  return {
    reads,
    deps: {
      ctx: {} as ConnectionContext,
      v3,
      partition: partitionOf({
        kind: "config",
        definitionKind: "model",
        name: "web",
      }),
      caller: {
        principal: { kind: "user", id: "caller" },
        collectives: [],
        groups: [],
        sourceIp: "127.0.0.1",
      },
      requestId: crypto.randomUUID(),
      resolver: {
        model: () => Promise.resolve(undefined),
        definitionTags: () => Promise.resolve(undefined),
        workflow: () => Promise.resolve(undefined),
        keyOwner: () => Promise.resolve(undefined),
        isRestrictedType: () => false,
      },
      possesses: () => Promise.resolve(possessed),
      signal: new AbortController().signal,
    },
  };
}

async function blobPut() {
  return await putOp({
    intent: createIntent({
      kind: "definition.create",
      definition: { kind: "model", name: "web" },
    }),
    key: RecordKey.create("config/models/acme/web/web.yaml"),
    blob: BlobRef.create({ sha256: "a".repeat(64), size: 10 }),
  });
}

Deno.test("ForwardedContentAuthority: content in a chunk the caller does not possess is refused without being read", async () => {
  const { deps: unpossessed, reads } = deps(false);
  const op = await blobPut();
  const refusal = await new ForwardedContentAuthority(unpossessed).check(op, [
    op,
  ]);
  assert(refusal !== undefined);
  assert(refusal.message.includes("neither carries nor may read"));
  // Nothing about the content: it was never read.
  assertEquals(reads, []);
});

Deno.test("ForwardedContentAuthority: a put whose intent it does not check is refused, never passed", async () => {
  const { deps: possessed } = deps(true);
  const op = await putOp({
    intent: createIntent({ kind: "lockfile.write" }),
    key: RecordKey.create("config/upstream_extensions.json"),
    inline: btoa("{}"),
  });
  const refusal = await new ForwardedContentAuthority(possessed).check(op, [
    op,
  ]);
  assert(refusal !== undefined);
});

Deno.test("ForwardedContentAuthority.unchanged: true when nothing was read", async () => {
  const { deps: possessed } = deps(true);
  assert(await new ForwardedContentAuthority(possessed).unchanged());
});
