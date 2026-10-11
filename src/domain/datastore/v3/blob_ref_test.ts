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
import { BlobRef } from "./blob_ref.ts";
import { RecordKey } from "./record_key.ts";

const SHA = "a".repeat(64);

Deno.test("BlobRef.create: keeps sha256, size and legacyKey", () => {
  const legacyKey = RecordKey.create("data/x/1/raw");
  const blob = BlobRef.create({ sha256: SHA, size: 0, legacyKey });
  assertEquals(blob.toJSON(), {
    sha256: SHA,
    size: 0,
    legacyKey: "data/x/1/raw",
  });
  assertEquals(BlobRef.create({ sha256: SHA, size: 5 }).toJSON(), {
    sha256: SHA,
    size: 5,
  });
});

Deno.test("BlobRef.create: rejects a malformed digest or size", () => {
  const invalid = [
    { sha256: "A".repeat(64), size: 1 },
    { sha256: "a".repeat(63), size: 1 },
    { sha256: "g".repeat(64), size: 1 },
    { sha256: SHA, size: -1 },
    { sha256: SHA, size: 1.5 },
    { sha256: SHA, size: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const props of invalid) {
    assertThrows(() => BlobRef.create(props));
  }
  assertThrows(
    () =>
      BlobRef.create({
        sha256: SHA,
        size: 1,
        legacyKey: "data/x" as unknown as RecordKey,
      }),
    TypeError,
  );
});

Deno.test("BlobRef.equals: compares every field, legacyKey included", () => {
  const a = BlobRef.create({ sha256: SHA, size: 1 });
  const b = BlobRef.create({
    sha256: SHA,
    size: 1,
    legacyKey: RecordKey.create("x"),
  });
  assert(a.equals(BlobRef.fromJSON(a.toJSON())));
  assert(b.equals(BlobRef.fromJSON(b.toJSON())));
  assert(!a.equals(b) && !b.equals(a));
  assertThrows(() => BlobRef.fromJSON(null), TypeError);
});
