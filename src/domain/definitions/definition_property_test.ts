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

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import fc from "fast-check";
import { type CreateDefinitionProps, Definition } from "./definition.ts";

const LOWER_ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
const NAME_CHARS = [...LOWER_ALNUM, "-", "_"];

/** Keys drawn from a small alphabetic set so no generated key collides with
 * `__proto__` and so insertion order (not numeric-key ordering) governs
 * property order. */
const arbKey = fc.stringOf(fc.constantFrom(..."abcdefgh".split("")), {
  minLength: 1,
  maxLength: 6,
});

/** JSON-ish values only — `undefined` would be dropped by JSON.stringify and
 * makes key presence ambiguous across the Zod round-trip. */
const arbJsonValue: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.string({ maxLength: 5 }), { maxLength: 3 }),
  fc.dictionary(arbKey, fc.string({ maxLength: 5 }), { maxKeys: 2 }),
);

const arbShortString = fc.stringOf(fc.constantFrom(...NAME_CHARS), {
  minLength: 1,
  maxLength: 12,
});

// Arbitrary for strict definition names (matching create() validation)
const arbSafeName = fc
  .tuple(
    fc.constantFrom(...LOWER_ALNUM),
    fc.stringOf(fc.constantFrom(...NAME_CHARS), { maxLength: 20 }),
  )
  .map(([head, rest]) => head + rest);

// Scoped `@collective/name` definition names, which definitionNameStrict
// accepts via the `name.includes("/")` escape hatch.
const arbScopedName = fc
  .tuple(
    arbShortString,
    arbShortString,
    fc.array(arbShortString, {
      maxLength: 2,
    }),
  )
  .map(([collective, name, extra]) =>
    [`@${collective}`, name, ...extra].join("/")
  );

const arbDefinitionName = fc.oneof(
  { arbitrary: arbSafeName, weight: 3 },
  { arbitrary: arbScopedName, weight: 1 },
);

// Arbitrary for names that contain path traversal characters
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

const arbTags = fc.dictionary(arbKey, fc.string({ maxLength: 20 }), {
  minKeys: 0,
  maxKeys: 5,
});

const arbLifetime = fc.oneof(
  fc.constantFrom("ephemeral", "infinite", "job", "workflow"),
  fc
    .tuple(
      fc.integer({ min: 1, max: 99 }),
      fc.constantFrom("h", "m", "d", "w", "mo", "y"),
    )
    .map(([n, unit]) => `${n}${unit}`),
);

const arbInputsSchema = fc.record({
  type: fc.constant("object" as const),
  properties: fc.dictionary(
    arbKey,
    fc.record({
      type: fc.constantFrom(
        "string" as const,
        "number" as const,
        "boolean" as const,
      ),
      description: fc.string({ maxLength: 8 }),
      default: arbJsonValue,
    }, { requiredKeys: ["type"] }),
    { maxKeys: 3 },
  ),
  required: fc.array(arbKey, { maxLength: 2 }),
}, { requiredKeys: [] });

/** Everything about a definition except its name, so name generation can be
 * varied independently. */
const arbDefinitionShape: fc.Arbitrary<Omit<CreateDefinitionProps, "name">> = fc
  .record({
    type: arbShortString,
    typeVersion: fc
      .tuple(
        fc.integer({ min: 2020, max: 2030 }),
        fc.integer({ min: 1, max: 12 }),
      )
      .map(([y, m]) => `${y}.${String(m).padStart(2, "0")}.0`),
    version: fc.integer({ min: 1, max: 50 }),
    tags: arbTags,
    globalArguments: fc.dictionary(arbKey, arbJsonValue, { maxKeys: 4 }),
    methods: fc.dictionary(
      arbKey,
      fc.record({
        arguments: fc.dictionary(arbKey, arbJsonValue, { maxKeys: 3 }),
      }, { requiredKeys: [] }),
      { maxKeys: 3 },
    ),
    inputs: arbInputsSchema,
    checks: fc.record({
      require: fc.array(arbShortString, { maxLength: 3 }),
      skip: fc.array(arbShortString, { maxLength: 2 }),
    }, { requiredKeys: [] }),
    reports: fc.record({
      require: fc.array(
        fc.oneof(
          arbShortString,
          fc.record({
            name: arbShortString,
            methods: fc.array(arbShortString, { maxLength: 2 }),
          }, { requiredKeys: ["name"] }),
        ),
        { maxLength: 3 },
      ),
      skip: fc.array(arbShortString, { maxLength: 2 }),
    }, { requiredKeys: [] }),
    resources: fc.dictionary(
      arbKey,
      fc.record({
        lifetime: arbLifetime,
        garbageCollection: fc.integer({ min: 1, max: 10 }),
        vaultName: arbShortString,
      }, { requiredKeys: [] }),
      { maxKeys: 3 },
    ),
  }, { requiredKeys: [] });

Deno.test("property: path traversal is always rejected", () => {
  fc.assert(
    fc.property(arbPathTraversalName, (name) => {
      assertThrows(() => Definition.create({ name }));
    }),
    { numRuns: 100 },
  );
});

Deno.test("property: version is always positive", () => {
  fc.assert(
    fc.property(arbSafeName, (name) => {
      const def = Definition.create({ name });
      assert(def.version >= 1);
    }),
    { numRuns: 100 },
  );
});

Deno.test("property: serialization round-trips every definition field", () => {
  fc.assert(
    fc.property(arbDefinitionName, arbDefinitionShape, (name, shape) => {
      const original = Definition.create({ ...shape, name });
      const data = original.toData();
      // Full structural equality so fields added to DefinitionSchema in the
      // future are covered without touching this assertion.
      assertEquals(Definition.fromData(data).toData(), data);
    }),
    { numRuns: 200 },
  );
});

Deno.test("property: round-tripped definition exposes the same accessors", () => {
  fc.assert(
    fc.property(arbDefinitionName, arbDefinitionShape, (name, shape) => {
      const original = Definition.create({ ...shape, name });
      const restored = Definition.fromData(original.toData());
      assertEquals(restored.id, original.id);
      assertEquals(restored.name, original.name);
      assertEquals(restored.type, original.type);
      assertEquals(restored.typeVersion, original.typeVersion);
      assertEquals(restored.version, original.version);
      assertEquals(restored.tags, original.tags);
      assertEquals(restored.globalArguments, original.globalArguments);
      assertEquals(restored.methodData, original.methodData);
      assertEquals(restored.inputs, original.inputs);
      assertEquals(restored.checkSelection, original.checkSelection);
      assertEquals(restored.reportSelection, original.reportSelection);
      assertEquals(restored.resources, original.resources);
    }),
    { numRuns: 100 },
  );
});

Deno.test("property: ID is always UUID", () => {
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  fc.assert(
    fc.property(arbSafeName, (name) => {
      const def = Definition.create({ name });
      assert(uuidPattern.test(def.id));
    }),
    { numRuns: 100 },
  );
});

Deno.test("property: hash is deterministic for arbitrary content", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbDefinitionName,
      arbDefinitionShape,
      async (name, shape) => {
        const def = Definition.create({ ...shape, name });
        assertEquals(await def.computeHash(), await def.computeHash());
        // Two definitions built from identical props hash identically too.
        const twin = Definition.fromData(def.toData());
        assertEquals(await twin.computeHash(), await def.computeHash());
      },
    ),
    { numRuns: 50 },
  );
});

Deno.test("property: hash ignores tag insertion order", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbSafeName,
      fc.uniqueArray(
        fc.tuple(arbKey, fc.string({ maxLength: 8 })),
        { minLength: 2, maxLength: 5, selector: ([key]) => key },
      ),
      async (name, entries) => {
        const id = crypto.randomUUID();
        const forward: Record<string, string> = {};
        for (const [key, value] of entries) forward[key] = value;
        const reversed: Record<string, string> = {};
        for (const [key, value] of [...entries].reverse()) {
          reversed[key] = value;
        }

        const a = Definition.create({ id, name, tags: forward });
        const b = Definition.create({ id, name, tags: reversed });
        // computeHash sorts keys recursively before hashing.
        assertEquals(await a.computeHash(), await b.computeHash());
      },
    ),
    { numRuns: 50 },
  );
});

Deno.test("property: hash ignores type and typeVersion", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbSafeName,
      arbShortString,
      arbShortString,
      async (name, typeA, typeB) => {
        const id = crypto.randomUUID();
        const a = Definition.create({
          id,
          name,
          type: typeA,
          typeVersion: "2026.01.0",
        });
        const b = Definition.create({
          id,
          name,
          type: typeB,
          typeVersion: "2030.12.0",
        });
        // computeHash strips type/typeVersion before serializing.
        assertEquals(await a.computeHash(), await b.computeHash());
      },
    ),
    { numRuns: 50 },
  );
});

Deno.test("property: hash changes when hashed content differs", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbSafeName,
      arbSafeName,
      arbDefinitionShape,
      async (nameA, nameB, shape) => {
        fc.pre(nameA !== nameB);
        const id = crypto.randomUUID();
        const a = Definition.create({ ...shape, id, name: nameA });
        const b = Definition.create({ ...shape, id, name: nameB });
        // Distinct names change the hashed payload; SHA-256 makes a collision
        // infeasible, so the hashes must differ.
        assertNotEquals(await a.computeHash(), await b.computeHash());
      },
    ),
    { numRuns: 50 },
  );
});

Deno.test("property: hash is a 64-character lowercase hex digest", async () => {
  await fc.assert(
    fc.asyncProperty(
      arbDefinitionName,
      arbDefinitionShape,
      async (name, shape) => {
        const hash = await Definition.create({ ...shape, name }).computeHash();
        assert(/^[0-9a-f]{64}$/.test(hash), `unexpected digest: ${hash}`);
      },
    ),
    { numRuns: 50 },
  );
});
