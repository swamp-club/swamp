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

import { assert, assertEquals, assertFalse } from "@std/assert";
import { makeSourceLocation, sourceLocationEquals } from "./source_location.ts";
import { canonicalizePathFor } from "../../infrastructure/persistence/canonicalize_path.ts";

Deno.test("makeSourceLocation: relativePath rebases lexically against extensionRoot", () => {
  const ext = "/repo/.swamp/pulled-extensions/@scope/foo";
  const src = "/repo/.swamp/pulled-extensions/@scope/foo/models/instance.ts";
  const loc = makeSourceLocation(src, ext);
  assertEquals(loc.relativePath, "models/instance.ts");
  // canonicalPath/extensionRoot are POSIX-pass-through on non-Windows hosts.
  if (Deno.build.os !== "windows") {
    assertEquals(loc.canonicalPath, src);
    assertEquals(loc.extensionRoot, ext);
  }
});

Deno.test("makeSourceLocation: source equal to root returns empty relativePath", () => {
  const ext = "/repo/.swamp/pulled-extensions/@scope/foo";
  const loc = makeSourceLocation(ext, ext);
  assertEquals(loc.relativePath, "");
});

Deno.test("sourceLocationEquals: equal canonicalPaths compare equal", () => {
  const ext = "/repo/extensions/models";
  const a = makeSourceLocation("/repo/extensions/models/foo.ts", ext);
  const b = makeSourceLocation("/repo/extensions/models/foo.ts", ext);
  assert(sourceLocationEquals(a, b));
});

Deno.test("sourceLocationEquals: differing canonicalPaths compare unequal", () => {
  const ext = "/repo/extensions/models";
  const a = makeSourceLocation("/repo/extensions/models/foo.ts", ext);
  const b = makeSourceLocation("/repo/extensions/models/bar.ts", ext);
  assertFalse(sourceLocationEquals(a, b));
});

Deno.test("SourceLocation cross-platform equality: Windows case-folds the fixture pair", () => {
  // Plan-required fixture pair: EXTENSIONS/Models/A.ts ↔ extensions/models/a.ts
  // On Windows: canonicalize lowercases + flips backslashes, so both inputs
  // produce the same canonicalPath and compare equal.
  const upper = canonicalizePathFor(
    "C:\\repo\\EXTENSIONS\\Models\\A.ts",
    /* isWindows */ true,
  );
  const lower = canonicalizePathFor(
    "C:/repo/extensions/models/a.ts",
    /* isWindows */ true,
  );
  assertEquals(upper, lower);
});

Deno.test("SourceLocation cross-platform equality: POSIX leaves the fixture pair distinct", () => {
  // On POSIX the canonicalize is pass-through — case differences survive,
  // so two different surface forms compare as different paths. macOS HFS+/APFS
  // case-insensitivity at the filesystem level is a known limitation
  // documented in canonicalize_path.ts; the canonicalizer itself is pure.
  const upper = canonicalizePathFor(
    "/repo/EXTENSIONS/Models/A.ts",
    /* isWindows */ false,
  );
  const lower = canonicalizePathFor(
    "/repo/extensions/models/a.ts",
    /* isWindows */ false,
  );
  assertFalse(upper === lower);
});
