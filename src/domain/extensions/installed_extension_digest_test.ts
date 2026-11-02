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

import { assertEquals, assertNotEquals } from "@std/assert";
import { computeInstalledExtensionDigest } from "./installed_extension_digest.ts";

Deno.test("computeInstalledExtensionDigest: identical entries produce identical digests", async () => {
  const a = await computeInstalledExtensionDigest([
    { relPath: "models/foo.ts", contentSha: "a".repeat(64) },
    { relPath: "datastores/bar.ts", contentSha: "b".repeat(64) },
  ]);
  const b = await computeInstalledExtensionDigest([
    { relPath: "models/foo.ts", contentSha: "a".repeat(64) },
    { relPath: "datastores/bar.ts", contentSha: "b".repeat(64) },
  ]);
  assertEquals(a, b);
});

Deno.test("computeInstalledExtensionDigest: entry order does not affect digest", async () => {
  const ascending = await computeInstalledExtensionDigest([
    { relPath: "a.ts", contentSha: "1".repeat(64) },
    { relPath: "b.ts", contentSha: "2".repeat(64) },
    { relPath: "c.ts", contentSha: "3".repeat(64) },
  ]);
  const descending = await computeInstalledExtensionDigest([
    { relPath: "c.ts", contentSha: "3".repeat(64) },
    { relPath: "b.ts", contentSha: "2".repeat(64) },
    { relPath: "a.ts", contentSha: "1".repeat(64) },
  ]);
  assertEquals(ascending, descending);
});

Deno.test("computeInstalledExtensionDigest: changing file content produces different digest", async () => {
  const before = await computeInstalledExtensionDigest([
    { relPath: "models/foo.ts", contentSha: "a".repeat(64) },
  ]);
  const after = await computeInstalledExtensionDigest([
    { relPath: "models/foo.ts", contentSha: "b".repeat(64) },
  ]);
  assertNotEquals(before, after);
});

Deno.test("computeInstalledExtensionDigest: changing path produces different digest", async () => {
  const before = await computeInstalledExtensionDigest([
    { relPath: "models/foo.ts", contentSha: "a".repeat(64) },
  ]);
  const after = await computeInstalledExtensionDigest([
    { relPath: "models/bar.ts", contentSha: "a".repeat(64) },
  ]);
  assertNotEquals(before, after);
});

Deno.test("computeInstalledExtensionDigest: adding a file produces different digest", async () => {
  const before = await computeInstalledExtensionDigest([
    { relPath: "models/foo.ts", contentSha: "a".repeat(64) },
  ]);
  const after = await computeInstalledExtensionDigest([
    { relPath: "models/foo.ts", contentSha: "a".repeat(64) },
    { relPath: "models/bar.ts", contentSha: "b".repeat(64) },
  ]);
  assertNotEquals(before, after);
});

Deno.test("computeInstalledExtensionDigest: removing a file produces different digest", async () => {
  const before = await computeInstalledExtensionDigest([
    { relPath: "models/foo.ts", contentSha: "a".repeat(64) },
    { relPath: "models/bar.ts", contentSha: "b".repeat(64) },
  ]);
  const after = await computeInstalledExtensionDigest([
    { relPath: "models/foo.ts", contentSha: "a".repeat(64) },
  ]);
  assertNotEquals(before, after);
});

Deno.test("computeInstalledExtensionDigest: empty entry set produces stable digest", async () => {
  const a = await computeInstalledExtensionDigest([]);
  const b = await computeInstalledExtensionDigest([]);
  assertEquals(a, b);
  assertEquals(
    a,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

Deno.test("computeInstalledExtensionDigest: paths with newlines are unambiguous", async () => {
  // a NUL separator between relPath and contentSha keeps a path containing a
  // newline from colliding with a naively joined entry
  const a = await computeInstalledExtensionDigest([
    { relPath: "a\nb", contentSha: "c".repeat(64) },
  ]);
  const b = await computeInstalledExtensionDigest([
    { relPath: "a", contentSha: "b\n" + "c".repeat(63) },
  ]);
  assertNotEquals(a, b);
});
