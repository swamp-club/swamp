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
import { Definition } from "./definition.ts";

// Arbitrary for safe definition names (no path traversal chars)
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

const arbTags = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 10 }),
  fc.string({ minLength: 0, maxLength: 20 }),
  { minKeys: 0, maxKeys: 5 },
);

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

Deno.test("property: serialization round-trips", () => {
  fc.assert(
    fc.property(arbSafeName, arbTags, (name, tags) => {
      const original = Definition.create({ name, tags });
      const restored = Definition.fromData(original.toData());
      assertEquals(restored.id, original.id);
      assertEquals(restored.name, original.name);
      assertEquals(restored.version, original.version);
      assertEquals(restored.tags, original.tags);
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

Deno.test("property: hash is deterministic", async () => {
  const def = Definition.create({ name: "deterministic-test" });
  const hash1 = await def.computeHash();
  const hash2 = await def.computeHash();
  assertEquals(hash1, hash2);
});

Deno.test("property: hash changes with different content", async () => {
  const def1 = Definition.create({
    name: "test-a",
    tags: { env: "dev" },
  });
  const def2 = Definition.create({
    name: "test-b",
    tags: { env: "prod" },
  });
  const hash1 = await def1.computeHash();
  const hash2 = await def2.computeHash();
  assert(hash1 !== hash2);
});
