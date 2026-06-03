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
import type { Lifetime, OwnerDefinition } from "./data_metadata.ts";

// Arbitrary for safe data names (no path traversal chars)
const arbSafeName = fc
  .stringOf(
    fc.oneof(
      fc.char().filter((c) =>
        c !== "/" && c !== "\\" && c !== "\0" && c !== "."
      ),
    ),
    { minLength: 1, maxLength: 30 },
  )
  .filter((s) => !s.includes(".."));

// Arbitrary for names containing path traversal characters
const arbPathTraversalName = fc.oneof(
  fc.constant("foo/../bar"),
  fc.constant("foo/bar"),
  fc.constant("foo\\bar"),
  fc.constant("foo\0bar"),
  arbSafeName.map((s) => s + "/.."),
  arbSafeName.map((s) => s + "/"),
  arbSafeName.map((s) => s + "\\"),
  arbSafeName.map((s) => s + "\0"),
);

const arbLifetime: fc.Arbitrary<Lifetime> = fc.oneof(
  fc.constant("ephemeral" as Lifetime),
  fc.constant("infinite" as Lifetime),
  fc.constant("job" as Lifetime),
  fc.constant("workflow" as Lifetime),
  fc.integer({ min: 1, max: 100 }).map((n) => `${n}h` as Lifetime),
  fc.integer({ min: 1, max: 100 }).map((n) => `${n}d` as Lifetime),
  fc.integer({ min: 1, max: 100 }).map((n) => `${n}m` as Lifetime),
);

const arbOwnerDefinition: fc.Arbitrary<OwnerDefinition> = fc.record({
  ownerType: fc.constantFrom(
    "model-method" as const,
    "workflow-step" as const,
    "manual" as const,
  ),
  ownerRef: fc.string({ minLength: 1, maxLength: 20 }),
});

const arbTags = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s !== "type"),
  fc.string({ minLength: 0, maxLength: 20 }),
  { minKeys: 0, maxKeys: 3 },
).map((tags) => ({ ...tags, type: "resource" }));

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
    }),
    { numRuns: 100 },
  );
});

Deno.test("property: ownership check is correct", () => {
  fc.assert(
    fc.property(
      arbSafeName,
      arbOwnerDefinition,
      arbOwnerDefinition,
      (name, owner, other) => {
        const data = Data.create(
          makeDataProps({ name, ownerDefinition: owner }),
        );
        const shouldMatch = owner.ownerType === other.ownerType &&
          owner.ownerRef === other.ownerRef;
        assertEquals(data.isOwnedBy(other), shouldMatch);
      },
    ),
    { numRuns: 200 },
  );
});

Deno.test("property: serialization round-trips", () => {
  fc.assert(
    fc.property(
      arbSafeName,
      arbTags,
      arbLifetime,
      arbOwnerDefinition,
      (name, tags, lifetime, ownerDefinition) => {
        const original = Data.create(
          makeDataProps({ name, tags, lifetime, ownerDefinition }),
        );
        const restored = Data.fromData(original.toData());
        assertEquals(restored.id, original.id);
        assertEquals(restored.name, original.name);
        assertEquals(restored.version, original.version);
        assertEquals(restored.tags, original.tags);
        assertEquals(
          restored.ownerDefinition.ownerType,
          original.ownerDefinition.ownerType,
        );
        assertEquals(
          restored.ownerDefinition.ownerRef,
          original.ownerDefinition.ownerRef,
        );
      },
    ),
    { numRuns: 100 },
  );
});

Deno.test("property: new version preserves identity", () => {
  fc.assert(
    fc.property(
      arbSafeName,
      fc.integer({ min: 2, max: 100 }),
      (name, newVersion) => {
        const original = Data.create(makeDataProps({ name }));
        const updated = original.withNewVersion({ version: newVersion });
        assertEquals(updated.id, original.id);
        assertEquals(updated.name, original.name);
        assertEquals(updated.version, newVersion);
      },
    ),
    { numRuns: 100 },
  );
});
