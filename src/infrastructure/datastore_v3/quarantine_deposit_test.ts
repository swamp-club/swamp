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

import { assertEquals, assertRejects } from "@std/assert";
import { Commit } from "../../domain/datastore_v3/commit.ts";
import type { OutboxEntry } from "../../domain/datastore_v3/commit_outbox.ts";
import { opFromJSON } from "../../domain/datastore_v3/op.ts";
import { partitionOf } from "../../domain/datastore_v3/partition_key.ts";
import { MAX_QUARANTINE_DEPOSIT_BYTES } from "../../domain/datastore_v3/quarantine.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  createQuarantineDeposit,
  QuarantineTooLargeError,
} from "./quarantine_deposit.ts";
import type { CommitChunk } from "./serve_datastore_client.ts";

const TYPE = ModelType.create("aws/ec2");
const MODEL_ID = "2e27d62d-4a9e-4f4d-9ce3-c0822f353578";

async function entryNaming(sha256: string, size: number): Promise<OutboxEntry> {
  const base = `data/${TYPE.normalized}/${MODEL_ID}/vpc/1`;
  const intent = {
    kind: "data.save",
    model: { type: TYPE.normalized, id: MODEL_ID },
    name: "vpc",
    version: 1,
  };
  const commit = Commit.create({
    seq: 3,
    partition: partitionOf({ kind: "model", type: TYPE, id: MODEL_ID }),
    namespace: "",
    txnId: crypto.randomUUID(),
    writer: { host: "h", pid: 1, instance: "i" },
    at: "2026-10-30T12:00:00.000Z",
    ops: [
      await opFromJSON({
        kind: "put",
        intent,
        key: `${base}/raw`,
        blob: { sha256, size },
      }),
    ],
  });
  return {
    commit,
    unitId: "u",
    base: { seq: 2, txnId: "base-txn" },
    sequence: 1,
    createdAt: 0,
    state: "quarantined",
  };
}

Deno.test("createQuarantineDeposit: hands serve the commit, its base and every chunk it names, from the chunk cache", async () => {
  const bytes = new TextEncoder().encode("vpc content");
  const sha256 = "a".repeat(64);
  const entry = await entryNaming(sha256, bytes.length);
  const sent: unknown[] = [];
  const deposit = createQuarantineDeposit({
    client: {
      depositQuarantine: (body) => {
        sent.push(body);
        return Promise.resolve({ duplicate: false });
      },
    },
    chunkCache: {
      get: (_ns, hash) => Promise.resolve(hash === sha256 ? bytes : null),
    },
    signal: () => new AbortController().signal,
  });
  await deposit(entry);
  assertEquals(sent, [{
    commit: entry.commit.toJSON(),
    base: { seq: 2, txnId: "base-txn" },
    chunks: [{ sha256, bytes }] satisfies CommitChunk[],
  }]);
});

Deno.test("createQuarantineDeposit: a change past what serve keeps is refused here, never sent", async () => {
  const sha256 = "b".repeat(64);
  const entry = await entryNaming(sha256, MAX_QUARANTINE_DEPOSIT_BYTES + 1);
  let sent = 0;
  const deposit = createQuarantineDeposit({
    client: {
      depositQuarantine: () => {
        sent++;
        return Promise.resolve({ duplicate: false });
      },
    },
    chunkCache: {
      get: () =>
        Promise.resolve(new Uint8Array(MAX_QUARANTINE_DEPOSIT_BYTES + 1)),
    },
    signal: () => new AbortController().signal,
  });
  await assertRejects(() => deposit(entry), QuarantineTooLargeError);
  assertEquals(sent, 0);
});
