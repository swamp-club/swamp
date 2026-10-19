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
import { isBundleArtifactPath } from "./paths.ts";
import { canonicalLockfileEntry } from "./upstream_extensions.ts";

// Lockfile paths as any checkout writes them: segments joined by either
// separator, some under a bundle cache dir.
const segment = fc.stringMatching(/^[a-z_@.-]{1,8}$/);
const path = fc.tuple(
  fc.constantFrom(
    ".swamp/pulled-extensions",
    ".swamp/bundles",
    ".swamp/vault-bundles",
    ".swamp/pulled-extensions/skills",
    "extensions/models",
  ),
  fc.array(segment, { minLength: 1, maxLength: 4 }),
  fc.boolean(),
).map(([root, rest, windows]) => {
  const joined = [root, ...rest].join("/");
  return windows ? joined.replaceAll("/", "\\") : joined;
});
const entry = fc.record({
  version: fc.constant("1.0.0"),
  pulledAt: fc.constant("2026-01-01T00:00:00.000Z"),
  files: fc.array(path, { maxLength: 8 }),
  include: fc.array(path, { maxLength: 3 }),
});

Deno.test("canonicalLockfileEntry: is idempotent", () => {
  fc.assert(
    fc.property(entry, (e) => {
      const once = canonicalLockfileEntry(e);
      assertEquals(canonicalLockfileEntry(once), once);
    }),
  );
});

Deno.test("canonicalLockfileEntry: leaves no backslash and no bundle cache path", () => {
  fc.assert(
    fc.property(entry, (e) => {
      const out = canonicalLockfileEntry(e);
      for (const file of [...out.files, ...out.include]) {
        assert(!file.includes("\\"), file);
      }
      assert(!out.files.some(isBundleArtifactPath));
    }),
  );
});

Deno.test("canonicalLockfileEntry: a Windows and a POSIX spelling read the same", () => {
  fc.assert(
    fc.property(entry, (e) => {
      const windows = {
        ...e,
        files: e.files.map((f) => f.replaceAll("/", "\\")),
        include: e.include.map((f) => f.replaceAll("/", "\\")),
      };
      const posix = {
        ...e,
        files: e.files.map((f) => f.replaceAll("\\", "/")),
        include: e.include.map((f) => f.replaceAll("\\", "/")),
      };
      assertEquals(
        canonicalLockfileEntry(windows),
        canonicalLockfileEntry(posix),
      );
    }),
  );
});
