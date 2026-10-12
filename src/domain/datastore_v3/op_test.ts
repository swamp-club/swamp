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

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { BlobRef } from "./blob_ref.ts";
import {
  dataVersionOp,
  isOp,
  leaseOp,
  MAX_INLINE_BYTES,
  opFromJSON,
  PutOp,
  putOp,
  tombstoneOp,
} from "./op.ts";
import type { RecordKey } from "./record_key.ts";
import {
  base64,
  dataKey,
  metadata,
  modelIntent,
  sha256Of,
} from "./v3_test_helpers.ts";

const SAVE = modelIntent({ kind: "data.save", name: "vpc", version: 1 });
const KEY = dataKey("vpc", 1);

Deno.test("putOp: computes the digest of inline content", async () => {
  const op = await putOp({ intent: SAVE, key: KEY, inline: base64("hello") });
  assertEquals(op.sha256, await sha256Of("hello"));
  assertEquals(op.toJSON(), {
    kind: "put",
    intent: SAVE,
    key: KEY.toString(),
    inline: base64("hello"),
  });
});

Deno.test("putOp: takes a blob's digest from the blob", async () => {
  const blob = BlobRef.create({ sha256: "b".repeat(64), size: 1 << 20 });
  const op = await putOp({ intent: SAVE, key: KEY, blob, expect: "absent" });
  assertEquals(op.sha256, "b".repeat(64));
  assertEquals(op.toJSON().blob, blob.toJSON());
  assertEquals(op.toJSON().expect, "absent");
});

Deno.test("putOp: accepts exactly the inline size limit and no more", async () => {
  const bytes = "x".repeat(MAX_INLINE_BYTES);
  await putOp({ intent: SAVE, key: KEY, inline: btoa(bytes) });
  await assertRejects(
    () => putOp({ intent: SAVE, key: KEY, inline: btoa(bytes + "x") }),
    Error,
    "store it as a blob",
  );
});

Deno.test("putOp: rejects invalid or non-canonical base64", async () => {
  for (const inline of ["%%%", "aGVsbG8", "aGVsbG8=\n", " aGVsbG8="]) {
    await assertRejects(
      () => putOp({ intent: SAVE, key: KEY, inline }),
      Error,
      "base64",
    );
  }
});

Deno.test("putOp: needs exactly one of blob and inline, and a valid expect", async () => {
  const blob = BlobRef.create({ sha256: "b".repeat(64), size: 1 });
  await assertRejects(() => putOp({ intent: SAVE, key: KEY }));
  await assertRejects(() =>
    putOp({ intent: SAVE, key: KEY, blob, inline: base64("x") })
  );
  for (
    const expect of [
      "present",
      { sha256: "B".repeat(64) },
      { sha256: "b".repeat(64), extra: 1 },
    ]
  ) {
    await assertRejects(() =>
      putOp({
        intent: SAVE,
        key: KEY,
        blob,
        expect: expect as "absent",
      })
    );
  }
  await assertRejects(() =>
    putOp({ intent: SAVE, key: "data/x" as unknown as RecordKey, blob })
  );
});

Deno.test("tombstoneOp: names one key and an optional 'present' expect", () => {
  const intent = modelIntent({ kind: "data.delete", name: "vpc", version: 1 });
  const op = tombstoneOp({ intent, key: KEY, expect: "present" });
  assertEquals(op.toJSON(), {
    kind: "tombstone",
    intent,
    key: KEY.toString(),
    expect: "present",
  });
  assertThrows(() =>
    tombstoneOp({ intent, key: KEY, expect: "absent" as "present" })
  );
});

Deno.test("dataVersionOp: keeps the parsed metadata and rejects invalid metadata", () => {
  const op = dataVersionOp({ key: KEY, metadata: metadata("vpc", 3) });
  assertEquals(op.metadata.version, 3);
  assertEquals(op.metadata.streaming, false);
  assertThrows(() =>
    dataVersionOp({
      key: KEY,
      metadata: { ...metadata("vpc", 3) as object, version: 0 },
    })
  );
  assertThrows(() =>
    dataVersionOp({ key: KEY, metadata: { ...metadata("a/b", 3) as object } })
  );
});

Deno.test("leaseOp: needs a holder and a non-negative integer fence", () => {
  assertEquals(leaseOp({ holder: "serve-1", fence: 0 }).toJSON(), {
    kind: "lease",
    holder: "serve-1",
    fence: 0,
  });
  assertThrows(() => leaseOp({ holder: "", fence: 1 }));
  assertThrows(() => leaseOp({ holder: "a", fence: -1 }));
  assertThrows(() => leaseOp({ holder: "a", fence: 0.5 }));
});

Deno.test("PutOp.build: refuses callers without the module token", () => {
  assertThrows(
    () =>
      PutOp.build(
        Symbol("forged") as never,
        SAVE,
        KEY,
        { inline: "" },
        "0".repeat(64),
        undefined,
      ),
    Error,
    "putOp",
  );
});

Deno.test("opFromJSON: round-trips every op kind", async () => {
  const ops = [
    await putOp({
      intent: SAVE,
      key: KEY,
      inline: base64("x"),
      expect: { sha256: "c".repeat(64) },
    }),
    tombstoneOp({ intent: SAVE, key: KEY }),
    dataVersionOp({ key: KEY, metadata: metadata("vpc", 1) }),
    leaseOp({ holder: "h", fence: 9 }),
  ];
  for (const op of ops) {
    const parsed = await opFromJSON(JSON.parse(JSON.stringify(op)));
    assert(isOp(parsed));
    assertEquals(parsed.toJSON(), op.toJSON());
  }
});

Deno.test("opFromJSON: refuses unknown fields, so a smuggled digest never lands", async () => {
  const json = {
    kind: "put",
    intent: SAVE,
    key: KEY.toString(),
    inline: base64("real"),
    sha256: "0".repeat(64),
  };
  await assertRejects(() => opFromJSON(json), Error, "sha256");
  await assertRejects(() => opFromJSON({ kind: "move" }), Error, "Unknown");
  const { sha256: _, ...clean } = json;
  const parsed = await opFromJSON(clean) as PutOp;
  assertEquals(parsed.sha256, await sha256Of("real"));
});

Deno.test("isOp: rejects op-shaped literals", () => {
  assertEquals(isOp({ kind: "lease", holder: "h", fence: 1 }), false);
});

Deno.test("dataVersionOp: freezes the metadata so a built commit cannot change", () => {
  const op = dataVersionOp({ key: KEY, metadata: metadata("vpc", 1) });
  assert(Object.isFrozen(op.metadata));
  assert(Object.isFrozen(op.metadata.tags));
  assert(Object.isFrozen(op.metadata.ownerDefinition));
  assertThrows(() => {
    (op.metadata as { name: string }).name = "../evil";
  }, TypeError);
});

Deno.test("dataVersionOp: orders tags by key, so equal metadata serializes equally", () => {
  const meta = metadata("vpc", 1) as Record<string, unknown>;
  const a = dataVersionOp({
    key: KEY,
    metadata: { ...meta, tags: { type: "resource", b: "2", a: "1" } },
  });
  const b = dataVersionOp({
    key: KEY,
    metadata: { ...meta, tags: { a: "1", type: "resource", b: "2" } },
  });
  assertEquals(JSON.stringify(a.toJSON()), JSON.stringify(b.toJSON()));
  assertEquals(Object.keys(a.metadata.tags), ["a", "b", "type"]);
});

Deno.test("putOp: freezes the op and its content, so the digest always matches the bytes", async () => {
  const op = await putOp({ intent: SAVE, key: KEY, inline: base64("hello") });
  assert(Object.isFrozen(op));
  assert(Object.isFrozen(op.content));
  assertThrows(() => {
    (op.content as { inline: string }).inline = base64("evil");
  }, TypeError);
  assert(Object.isFrozen(tombstoneOp({ intent: SAVE, key: KEY })));
  assert(Object.isFrozen(leaseOp({ holder: "h", fence: 1 })));
});
