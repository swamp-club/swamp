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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { BlobRef } from "../../domain/datastore_v3/blob_ref.ts";
import { type Op, putOp } from "../../domain/datastore_v3/op.ts";
import { WriterFencedError } from "../../domain/datastore_v3/writer_lease.ts";
import {
  base64,
  dataKey,
  modelIntent,
  modelPartition,
  savePut,
  versionOp,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { StaleSeqError } from "./commit_log_unit_of_work.ts";
import {
  ChunksMissingError,
  commitForwarded,
  type ForwardedCommitRequest,
  PreconditionConflictError,
  TxnIdReusedError,
} from "./forwarded_commit.ts";
import {
  initializeV3Datastore,
  openV3Datastore,
  type V3Datastore,
} from "./v3_datastore.ts";

async function withHandle(fn: (v3: V3Datastore) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "swamp-forwarded-commit-" });
  try {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const v3 = openV3Datastore({ repoDir: join(dir, "repo"), datastorePath });
    try {
      await fn(v3);
    } finally {
      await v3.close();
    }
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

async function saveOps(name: string, version: number): Promise<Op[]> {
  return [await savePut(name, version), versionOp(name, version)];
}

function request(
  ops: readonly Op[],
  overrides: Partial<ForwardedCommitRequest> = {},
): ForwardedCommitRequest {
  return {
    partition: modelPartition(),
    txnId: crypto.randomUUID(),
    expectedSeq: 0,
    principal: "user:alice",
    ops,
    ...overrides,
  };
}

const signal = () => AbortSignal.timeout(30_000);

Deno.test("commitForwarded: lands at the next seq, stamped with the caller and serve's writer", async () => {
  await withHandle(async (v3) => {
    const result = await commitForwarded(
      v3,
      request(await saveOps("vpc", 1)),
      signal(),
    );
    assertEquals(result, { seq: 1, duplicate: false });
    const [{ commit }] = await v3.commitStore.readPartition(
      v3.namespace,
      modelPartition(),
      1,
      1,
    );
    assertEquals(commit.principal, "user:alice");
    assertEquals(commit.writer, v3.writer);
  });
});

Deno.test("commitForwarded: a retry under the same txnId answers with the landed seq", async () => {
  await withHandle(async (v3) => {
    const first = request(await saveOps("vpc", 1));
    await commitForwarded(v3, first, signal());
    await commitForwarded(
      v3,
      request(await saveOps("vpc", 2), { expectedSeq: 1 }),
      signal(),
    );
    assertEquals(await commitForwarded(v3, first, signal()), {
      seq: 1,
      duplicate: true,
    });
  });
});

Deno.test("commitForwarded: a txnId reused by another caller, or for other ops, is refused", async () => {
  await withHandle(async (v3) => {
    const first = request(await saveOps("vpc", 1));
    await commitForwarded(v3, first, signal());
    await assertRejects(
      () =>
        commitForwarded(v3, { ...first, principal: "user:mallory" }, signal()),
      TxnIdReusedError,
    );
    await assertRejects(
      () =>
        commitForwarded(
          v3,
          { ...first, ops: [first.ops[0]] },
          signal(),
        ),
      TxnIdReusedError,
    );
  });
});

Deno.test("commitForwarded: a stale expected seq is refused with the head, and nothing lands", async () => {
  await withHandle(async (v3) => {
    await commitForwarded(v3, request(await saveOps("vpc", 1)), signal());
    const error = await assertRejects(
      async () =>
        await commitForwarded(
          v3,
          request(await saveOps("vpc", 2), { expectedSeq: 0 }),
          signal(),
        ),
      StaleSeqError,
    );
    assertEquals(error.seq, 1);
    assertEquals(
      (await v3.commitStore.head(v3.namespace, modelPartition())).seq,
      1,
    );
  });
});

Deno.test("commitForwarded: a client fence that is not the writer's is refused as fenced", async () => {
  await withHandle(async (v3) => {
    await assertRejects(
      async () =>
        await commitForwarded(
          v3,
          request(await saveOps("vpc", 1), { fence: 999 }),
          signal(),
        ),
      WriterFencedError,
    );
  });
});

Deno.test("commitForwarded: a chunk the store does not hold is refused before anything lands", async () => {
  await withHandle(async (v3) => {
    const sha256 = "a".repeat(64);
    const put = await putOp({
      intent: modelIntent({ kind: "data.save", name: "vpc", version: 1 }),
      key: dataKey("vpc", 1),
      blob: BlobRef.create({ sha256, size: 10 }),
    });
    const error = await assertRejects(
      () => commitForwarded(v3, request([put, versionOp("vpc", 1)]), signal()),
      ChunksMissingError,
    );
    assertEquals(error.missing, [sha256]);
    assertEquals(
      (await v3.commitStore.head(v3.namespace, modelPartition())).seq,
      0,
    );
  });
});

Deno.test("commitForwarded: a failed precondition names the key and who changed it", async () => {
  await withHandle(async (v3) => {
    await commitForwarded(v3, request(await saveOps("vpc", 1)), signal());
    // Bob's put of the version's content.
    const bobs = await putOp({
      intent: modelIntent({ kind: "data.append", name: "vpc", version: 1 }),
      key: dataKey("vpc", 1),
      inline: base64("bob"),
    });
    await commitForwarded(
      v3,
      request([bobs], { expectedSeq: 1, principal: "user:bob" }),
      signal(),
    );
    // Alice still expects the bytes she first read.
    const stale = await putOp({
      intent: modelIntent({ kind: "data.append", name: "vpc", version: 1 }),
      key: dataKey("vpc", 1),
      inline: base64("alice"),
      expect: { sha256: (await savePut("vpc", 1)).sha256 },
    });
    const error = await assertRejects(
      () => commitForwarded(v3, request([stale], { expectedSeq: 2 }), signal()),
      PreconditionConflictError,
    );
    assertEquals(error.key, dataKey("vpc", 1).toString());
    assertEquals(error.changedBy, "user:bob");
    assertEquals(error.seq, 2);
    assert(error.changedAt !== undefined);
  });
});
