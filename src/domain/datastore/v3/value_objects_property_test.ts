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
import fc from "fast-check";
import { ModelType } from "../../models/model_type.ts";
import { BlobRef } from "./blob_ref.ts";
import {
  createIntent,
  type Intent,
  intentEquals,
  intentPartition,
  modelRef,
} from "./intent.ts";
import { opFromJSON, putOp, tombstoneOp } from "./op.ts";
import { PartitionKey } from "./partition_key.ts";
import { RecordKey } from "./record_key.ts";

const arbSegment = fc.stringOf(
  fc.constantFrom(..."abcxyz0189-_.@é日".split("")),
  { minLength: 1, maxLength: 8 },
).filter((s) => s !== "." && s !== "..");

const arbRecordKey = fc.array(arbSegment, { minLength: 1, maxLength: 6 })
  .map((segments) => segments.join("/"));

const arbSha = fc.hexaString({ minLength: 64, maxLength: 64 }).map((s) =>
  s.toLowerCase()
);

const arbDataName = fc.stringOf(
  fc.constantFrom(..."abcxyz0189-_.é".split("")),
  { minLength: 1, maxLength: 10 },
).filter((name) => !name.includes(".."));

const arbModelType = fc.constantFrom(
  "aws/ec2",
  "@swamp/aws-ec2",
  "a--b",
  "x/y/z",
).map((t) => ModelType.create(t));

const arbIntent: fc.Arbitrary<Intent> = fc.oneof(
  fc.record({
    type: arbModelType,
    id: fc.uuid(),
    name: arbDataName,
    version: fc.integer({ min: 1, max: 1_000_000 }),
  }).map(({ type, id, name, version }) =>
    createIntent({
      kind: "data.save",
      model: modelRef(type, id),
      name,
      version,
    })
  ),
  fc.record({ workflowId: fc.uuid(), runId: fc.uuid() }).map((run) =>
    createIntent({ kind: "run.update", run })
  ),
  fc.record({
    kind: fc.constantFrom("model", "workflow", "vault"),
    name: fc.string({ minLength: 1, maxLength: 20 }),
  }).map((definition) => createIntent({ kind: "definition.edit", definition })),
  fc.constant(createIntent({ kind: "lockfile.write" })),
);

Deno.test("RecordKey.create: round-trips and compares by value", () => {
  fc.assert(
    fc.property(arbRecordKey, arbRecordKey, (a, b) => {
      const ka = RecordKey.create(a);
      assert(RecordKey.fromJSON(JSON.parse(JSON.stringify(ka))).equals(ka));
      const kb = RecordKey.create(b);
      assertEquals(ka.equals(kb), a === b);
      assertEquals(ka.equals(kb), kb.equals(ka));
    }),
    { numRuns: 300 },
  );
});

Deno.test("RecordKey.create: rejects any path with an empty, '.' or '..' segment", () => {
  const arbBad = fc.tuple(
    fc.array(arbSegment, { maxLength: 3 }),
    fc.constantFrom("", ".", ".."),
    fc.array(arbSegment, { maxLength: 3 }),
  ).map(([before, bad, after]) => [...before, bad, ...after].join("/"));
  fc.assert(
    fc.property(arbBad, (path) => {
      try {
        RecordKey.create(path);
        return false;
      } catch {
        return true;
      }
    }),
    { numRuns: 300 },
  );
});

Deno.test("BlobRef.create: round-trips, and rejects digests that are not lowercase hex", () => {
  fc.assert(
    fc.property(
      arbSha,
      fc.nat(),
      fc.option(arbRecordKey, { nil: undefined }),
      (sha256, size, legacy) => {
        const blob = BlobRef.create({
          sha256,
          size,
          legacyKey: legacy === undefined
            ? undefined
            : RecordKey.create(legacy),
        });
        assert(BlobRef.fromJSON(JSON.parse(JSON.stringify(blob))).equals(blob));
      },
    ),
    { numRuns: 300 },
  );
  fc.assert(
    fc.property(
      fc.string({ maxLength: 70 }).filter((s) => !/^[0-9a-f]{64}$/.test(s)),
      (sha256) => {
        try {
          BlobRef.create({ sha256, size: 1 });
          return false;
        } catch {
          return true;
        }
      },
    ),
    { numRuns: 300 },
  );
});

Deno.test("createIntent: round-trips through JSON and keeps its partition", () => {
  fc.assert(
    fc.property(arbIntent, (intent) => {
      const parsed = createIntent(JSON.parse(JSON.stringify(intent)));
      assert(intentEquals(parsed, intent) && intentEquals(intent, parsed));
      assert(intentPartition(parsed).equals(intentPartition(intent)));
      assert(
        PartitionKey.parse(intentPartition(intent).toString()).equals(
          intentPartition(intent),
        ),
      );
    }),
    { numRuns: 300 },
  );
});

Deno.test("createIntent: rejects data names that could leave their directory", () => {
  const arbBadName = fc.tuple(
    fc.string({ maxLength: 4 }),
    fc.constantFrom("..", "/", "\\", "\0"),
    fc.string({ maxLength: 4 }),
  ).map((parts) => parts.join(""));
  fc.assert(
    fc.property(arbBadName, fc.uuid(), (name, id) => {
      try {
        createIntent({
          kind: "data.save",
          model: modelRef(ModelType.create("a/b"), id),
          name,
          version: 1,
        });
        return false;
      } catch {
        return true;
      }
    }),
    { numRuns: 300 },
  );
});

Deno.test("putOp: round-trips through JSON with the digest recomputed", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbIntent,
      arbRecordKey,
      fc.uint8Array({ maxLength: 64 }),
      async (intent, key, bytes) => {
        const inline = btoa(String.fromCharCode(...bytes));
        const op = await putOp({ intent, key: RecordKey.create(key), inline });
        const parsed = await opFromJSON(JSON.parse(JSON.stringify(op)));
        assertEquals(parsed.toJSON(), op.toJSON());
        assertEquals(parsed.kind === "put" && parsed.sha256, op.sha256);
      },
    ),
    { numRuns: 100 },
  );
});

Deno.test("tombstoneOp: round-trips through JSON", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbIntent,
      arbRecordKey,
      fc.boolean(),
      async (intent, key, present) => {
        const op = tombstoneOp({
          intent,
          key: RecordKey.create(key),
          expect: present ? "present" : undefined,
        });
        const parsed = await opFromJSON(JSON.parse(JSON.stringify(op)));
        assertEquals(parsed.toJSON(), op.toJSON());
      },
    ),
    { numRuns: 100 },
  );
});
