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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { stringify as stringifyYaml } from "@std/yaml";
import { BlobRef } from "../domain/datastore_v3/blob_ref.ts";
import { Definition } from "../domain/definitions/definition.ts";
import { createIntent } from "../domain/datastore_v3/intent.ts";
import { putOp } from "../domain/datastore_v3/op.ts";
import { partitionOf } from "../domain/datastore_v3/partition_key.ts";
import { ReadModelIncompleteError } from "../domain/datastore_v3/read_model.ts";
import { RecordKey } from "../domain/datastore_v3/record_key.ts";
import type { V3Datastore } from "../infrastructure/datastore_v3/v3_datastore.ts";
import {
  ForwardedContentAuthority,
  type ForwardedContentDeps,
} from "./forwarded_content_authorization.ts";
import type { ConnectionContext } from "./handlers/shared.ts";

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
        runRecordGuarded: () => Promise.resolve(false),
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

const RENAMED_ID = "1c6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a12";

async function renameRefusal(
  stored: Record<string, Record<string, string>>,
  options: { incomplete?: boolean; read?: string[] } = {},
): Promise<string | undefined> {
  const { deps: base } = deps(true);
  const encoder = new TextEncoder();
  const record = (partition: { toString(): string }, key: string) =>
    stored[partition.toString()]?.[key];
  const v3 = {
    ...base.v3,
    readModel: {
      liveRecord: (_ns: string, partition: unknown, key: string) => {
        const text = record(partition as { toString(): string }, key);
        return Promise.resolve(
          text === undefined ? undefined : { sha256: "b".repeat(64) },
        );
      },
      recordBytes: (_ns: string, partition: unknown, key: string) => {
        options.read?.push(key);
        const text = record(partition as { toString(): string }, key);
        return Promise.resolve(
          text === undefined ? undefined : {
            bytes: encoder.encode(text),
            record: { sha256: "b".repeat(64) },
          },
        );
      },
      liveRecords: (_ns: string, partition: unknown) => {
        if (options.incomplete) {
          return Promise.reject(new ReadModelIncompleteError());
        }
        const keys = Object.keys(stored[String(partition)] ?? {});
        return Promise.resolve(
          keys.map((key) => ({ key: RecordKey.create(key) })),
        );
      },
      holdsRecordsUnder: () => Promise.resolve(false),
    },
  } as unknown as V3Datastore;
  const op = await putOp({
    intent: createIntent({
      kind: "definition.rename-to",
      definition: { kind: "model", name: "producer-renamed" },
      from: "producer",
    }),
    key: RecordKey.create("config/models/acme/web/producer-renamed.yaml"),
    inline: btoa(definitionYaml(RENAMED_ID, "producer-renamed")),
  });
  const refusal = await new ForwardedContentAuthority({
    ...base,
    v3,
    partition: partitionOf({
      kind: "config",
      definitionKind: "model",
      name: "producer-renamed",
    }),
  }).check(op, [op]);
  return refusal?.message;
}

const PRODUCER = partitionOf({
  kind: "config",
  definitionKind: "model",
  name: "producer",
}).toString();

const OTHER = partitionOf({
  kind: "config",
  definitionKind: "model",
  name: "other",
}).toString();

function definitionYaml(
  id: string,
  name: string,
  type = "acme/web",
): string {
  const data = Definition.create({ id, name, globalArguments: {} }).toData();
  return stringifyYaml(JSON.parse(JSON.stringify({ ...data, type })));
}

Deno.test("ForwardedContentAuthority: a rename whose old name holds no record of its id is refused", async () => {
  const message = await renameRefusal({
    [PRODUCER]: {
      "config/models/acme/web/0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a11.yaml":
        definitionYaml("0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a11", "producer"),
    },
  });
  assertStringIncludes(message ?? "", "cannot be read");
});

Deno.test("ForwardedContentAuthority: a rename never takes a record of its id held under another name", async () => {
  const message = await renameRefusal({
    [OTHER]: {
      [`config/models/acme/web/${RENAMED_ID}.yaml`]: definitionYaml(
        RENAMED_ID,
        "other",
      ),
    },
  });
  assertStringIncludes(message ?? "", "cannot be read");
});

Deno.test("ForwardedContentAuthority: a rename never takes a record of its id of another type under the old name", async () => {
  const read: string[] = [];
  const message = await renameRefusal({
    [PRODUCER]: {
      [`config/models/acme/admin/${RENAMED_ID}.yaml`]: definitionYaml(
        RENAMED_ID,
        "producer",
        "acme/admin",
      ),
    },
  }, { read });
  assertStringIncludes(message ?? "", "cannot be read");
  assertEquals(read, [`config/models/acme/admin/${RENAMED_ID}.yaml`]);
});

Deno.test("ForwardedContentAuthority: a rename whose old name holds two records of its id is refused", async () => {
  const message = await renameRefusal({
    [PRODUCER]: {
      [`config/models/acme/web/${RENAMED_ID}.yaml`]: definitionYaml(
        RENAMED_ID,
        "producer",
      ),
      "config/models/acme/web/copy.yaml": definitionYaml(
        RENAMED_ID,
        "producer",
      ),
    },
  });
  assertStringIncludes(message ?? "", "cannot be read");
});

Deno.test("ForwardedContentAuthority: a rename is refused while the old name's records are not all listed", async () => {
  const message = await renameRefusal({
    [PRODUCER]: {
      [`config/models/acme/web/${RENAMED_ID}.yaml`]: definitionYaml(
        RENAMED_ID,
        "producer",
      ),
    },
  }, { incomplete: true });
  assertStringIncludes(message ?? "", "cannot be read");
});

Deno.test("ForwardedContentAuthority: a rename finds its definition under the old name by id when the key does not carry the name", async () => {
  const read: string[] = [];
  // the stub connection has no repository, so the name check after it throws
  const message = await renameRefusal({
    [PRODUCER]: {
      [`config/models/acme/web/${RENAMED_ID}.yaml`]: definitionYaml(
        RENAMED_ID,
        "producer",
      ),
    },
  }, { read }).catch((error) => String(error));
  assertEquals(read, [`config/models/acme/web/${RENAMED_ID}.yaml`]);
  assert(!(message ?? "").includes("cannot be read"), message);
});
