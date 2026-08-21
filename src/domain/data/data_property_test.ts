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
import fc from "fast-check";
import { type CreateDataProps, Data } from "./data.ts";
import type {
  GarbageCollectionPolicy,
  Lifetime,
  OwnerDefinition,
} from "./data_metadata.ts";

// Arbitrary for safe data names. Production only rejects "..", "/", "\" and
// null bytes, so a single "." is legal and is generated on purpose.
const arbSafeName = fc
  .stringOf(
    fc.char().filter((c) => c !== "/" && c !== "\\" && c !== "\0"),
    { minLength: 1, maxLength: 30 },
  )
  .filter((s) => !s.includes(".."));

// Names built from a dot-heavy alphabet so single dots and dot-separated
// segments are exercised without ever forming "..".
const arbDottedName = fc
  .array(
    fc.stringOf(fc.constantFrom(..."abc123".split("")), {
      minLength: 1,
      maxLength: 5,
    }),
    { minLength: 1, maxLength: 4 },
  )
  .map((segments) => segments.join("."));

// Arbitrary for names containing path traversal characters
const arbPathTraversalName = fc.oneof(
  fc.constant("foo/../bar"),
  fc.constant("foo/bar"),
  fc.constant("foo\\bar"),
  fc.constant("foo\0bar"),
  fc.constant(".."),
  arbSafeName.map((s) => s + "/.."),
  arbSafeName.map((s) => s + "/"),
  arbSafeName.map((s) => s + "\\"),
  arbSafeName.map((s) => s + "\0"),
);

const arbLifetime: fc.Arbitrary<Lifetime> = fc.oneof(
  fc.constantFrom(
    "ephemeral" as Lifetime,
    "infinite" as Lifetime,
    "job" as Lifetime,
    "workflow" as Lifetime,
  ),
  fc
    .tuple(
      fc.integer({ min: 0, max: 100 }),
      fc.constantFrom("h", "m", "d", "w", "mo", "y"),
    )
    .map(([n, unit]) => `${n}${unit}` as Lifetime),
);

const arbGarbageCollection: fc.Arbitrary<GarbageCollectionPolicy> = fc.oneof(
  fc.integer({ min: 1, max: 50 }),
  fc
    .tuple(
      fc.integer({ min: 1, max: 100 }),
      fc.constantFrom("h", "m", "d", "w", "mo", "y"),
    )
    .map(([n, unit]) => `${n}${unit}`),
);

const arbOwnerDefinition: fc.Arbitrary<OwnerDefinition> = fc.record({
  definitionHash: fc.string({ minLength: 1, maxLength: 16 }),
  ownerType: fc.constantFrom(
    "model-method" as const,
    "workflow-step" as const,
    "manual" as const,
  ),
  ownerRef: fc.string({ minLength: 1, maxLength: 20 }),
  workflowId: fc.uuid(),
  workflowRunId: fc.uuid(),
  workflowName: fc.string({ maxLength: 20 }),
  jobName: fc.string({ maxLength: 20 }),
  stepName: fc.string({ maxLength: 20 }),
  source: fc.string({ maxLength: 20 }),
}, { requiredKeys: ["ownerType", "ownerRef"] });

const arbTags = fc.dictionary(
  fc.stringOf(fc.constantFrom(..."abcdefgh".split("")), {
    minLength: 1,
    maxLength: 8,
  }).filter((s) => s !== "type"),
  fc.string({ minLength: 0, maxLength: 20 }),
  { minKeys: 0, maxKeys: 3 },
).map((tags) => ({ ...tags, type: "resource" }));

/** Everything about a Data entity except its name. */
const arbDataShape = fc.record({
  contentType: fc.constantFrom(
    "text/plain",
    "application/json",
    "application/octet-stream",
  ),
  lifetime: arbLifetime,
  garbageCollection: arbGarbageCollection,
  streaming: fc.boolean(),
  tags: arbTags,
  ownerDefinition: arbOwnerDefinition,
  version: fc.integer({ min: 1, max: 100 }),
  size: fc.integer({ min: 0, max: 1_000_000 }),
  checksum: fc.hexaString({ minLength: 8, maxLength: 32 }),
  lifecycle: fc.constantFrom("active" as const, "deleted" as const),
  createdAt: fc
    .integer({ min: 0, max: 1_900_000_000_000 })
    .map((ms) => new Date(ms)),
}, {
  requiredKeys: [
    "contentType",
    "lifetime",
    "garbageCollection",
    "tags",
    "ownerDefinition",
  ],
});

function makeDataProps(
  overrides: Partial<CreateDataProps> = {},
): CreateDataProps {
  return {
    name: "test-data",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: 5,
    tags: { type: "resource" },
    ownerDefinition: { ownerType: "model-method", ownerRef: "ref" },
    ...overrides,
  };
}

Deno.test("property: path traversal is always rejected", () => {
  fc.assert(
    fc.property(arbPathTraversalName, (name) => {
      assertThrows(() => Data.create(makeDataProps({ name })));
    }),
    { numRuns: 100 },
  );
});

Deno.test("property: single dots in names are accepted", () => {
  // Production rejects only the ".." traversal sequence, not lone dots, so
  // "config.json"-style names must survive creation unchanged.
  fc.assert(
    fc.property(arbDottedName, (name) => {
      const data = Data.create(makeDataProps({ name }));
      assertEquals(data.name, name);
      assertEquals(Data.fromData(data.toData()).name, name);
    }),
    { numRuns: 200 },
  );
});

Deno.test("property: version is always positive", () => {
  fc.assert(
    fc.property(arbSafeName, (name) => {
      const data = Data.create(makeDataProps({ name }));
      assert(data.version >= 1);
    }),
    { numRuns: 100 },
  );
});

Deno.test("property: tags always include 'type'", () => {
  fc.assert(
    fc.property(arbSafeName, arbTags, (name, tags) => {
      const data = Data.create(makeDataProps({ name, tags }));
      assert("type" in data.tags);
      assertEquals(data.type, tags.type);
    }),
    { numRuns: 100 },
  );
});

Deno.test("property: isOwnedBy is reflexive and ignores provenance fields", () => {
  fc.assert(
    fc.property(
      arbSafeName,
      arbOwnerDefinition,
      arbOwnerDefinition,
      (name, owner, provenance) => {
        const data = Data.create(
          makeDataProps({ name, ownerDefinition: owner }),
        );
        // Reflexive: data is always owned by its own owner definition.
        assert(data.isOwnedBy(data.ownerDefinition));
        assert(data.isOwnedBy(owner));
        // Only ownerType + ownerRef participate: swapping every other field
        // (workflow ids, step names, definition hash) must not change the
        // verdict.
        assert(data.isOwnedBy({
          ...provenance,
          ownerType: owner.ownerType,
          ownerRef: owner.ownerRef,
        }));
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("property: isOwnedBy rejects a different ref or type", () => {
  fc.assert(
    fc.property(
      arbSafeName,
      arbOwnerDefinition,
      fc.string({ minLength: 1, maxLength: 20 }),
      (name, owner, otherRef) => {
        fc.pre(otherRef !== owner.ownerRef);
        const data = Data.create(
          makeDataProps({ name, ownerDefinition: owner }),
        );
        assertEquals(
          data.isOwnedBy({ ...owner, ownerRef: otherRef }),
          false,
        );
        for (
          const otherType of [
            "model-method",
            "workflow-step",
            "manual",
          ] as const
        ) {
          if (otherType === owner.ownerType) continue;
          assertEquals(
            data.isOwnedBy({ ...owner, ownerType: otherType }),
            false,
          );
        }
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("property: serialization round-trips every metadata field", () => {
  fc.assert(
    fc.property(arbSafeName, arbDataShape, (name, shape) => {
      const original = Data.create({ ...shape, name });
      const data = original.toData();
      // Full structural equality so fields added to DataMetadataSchema in the
      // future are covered without touching this assertion.
      assertEquals(Data.fromData(data).toData(), data);
    }),
    { numRuns: 200 },
  );
});

Deno.test("property: round-tripped data exposes the same accessors", () => {
  fc.assert(
    fc.property(arbSafeName, arbDataShape, (name, shape) => {
      const original = Data.create({ ...shape, name });
      const restored = Data.fromData(original.toData());
      assertEquals(restored.id, original.id);
      assertEquals(restored.name, original.name);
      assertEquals(restored.version, original.version);
      assertEquals(restored.contentType, original.contentType);
      assertEquals(restored.lifetime, original.lifetime);
      assertEquals(restored.garbageCollection, original.garbageCollection);
      assertEquals(restored.streaming, original.streaming);
      assertEquals(restored.tags, original.tags);
      assertEquals(restored.ownerDefinition, original.ownerDefinition);
      assertEquals(
        restored.createdAt.toISOString(),
        original.createdAt.toISOString(),
      );
      assertEquals(restored.lifecycle, original.lifecycle);
      assertEquals(restored.isDeleted, original.isDeleted);
      assertEquals(restored.size, original.size);
      assertEquals(restored.checksum, original.checksum);
    }),
    { numRuns: 100 },
  );
});

Deno.test("property: zero-duration lifetimes normalize to 'workflow'", () => {
  fc.assert(
    fc.property(
      arbSafeName,
      fc.constantFrom("h", "m", "d", "w", "mo", "y"),
      (name, unit) => {
        const data = Data.create(
          makeDataProps({ name, lifetime: `0${unit}` as Lifetime }),
        );
        assertEquals(data.lifetime, "workflow");
      },
    ),
    { numRuns: 100 },
  );
});

Deno.test("property: new version preserves identity", () => {
  fc.assert(
    fc.property(
      arbSafeName,
      arbDataShape,
      fc.integer({ min: 2, max: 100 }),
      (name, shape, newVersion) => {
        const original = Data.create({ ...shape, name });
        const updated = original.withNewVersion({ version: newVersion });
        assertEquals(updated.id, original.id);
        assertEquals(updated.name, original.name);
        assertEquals(updated.version, newVersion);
        assertEquals(updated.contentType, original.contentType);
        assertEquals(updated.lifetime, original.lifetime);
        assertEquals(updated.garbageCollection, original.garbageCollection);
        assertEquals(updated.streaming, original.streaming);
        assertEquals(updated.tags, original.tags);
        assertEquals(updated.lifecycle, original.lifecycle);
      },
    ),
    { numRuns: 100 },
  );
});

Deno.test("property: deletion markers tombstone without changing identity", () => {
  fc.assert(
    fc.property(
      arbSafeName,
      arbDataShape,
      fc.integer({ min: 2, max: 100 }),
      (name, shape, newVersion) => {
        const original = Data.create({ ...shape, name });
        const marker = original.withDeletionMarker({ version: newVersion });
        assertEquals(marker.id, original.id);
        assertEquals(marker.name, original.name);
        assertEquals(marker.version, newVersion);
        assertEquals(marker.contentType, "application/json");
        assertEquals(marker.streaming, false);
        assert(marker.isDeleted);
        assertEquals(marker.isRenamed, false);
      },
    ),
    { numRuns: 100 },
  );
});
