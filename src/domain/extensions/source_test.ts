// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { makeBundleLocation } from "./bundle_location.ts";
import { makeSourceLocation } from "./source_location.ts";
import { makeSource, withFingerprintAndState, withState } from "./source.ts";

const EXT_ROOT = "/repo/.swamp/pulled-extensions/@scope/foo";
const ABS_PATH = "/repo/.swamp/pulled-extensions/@scope/foo/models/instance.ts";
const FP = "abc123";
const BUNDLE = makeBundleLocation("/repo/.swamp/bundles/x.js", FP);

function indexedSource() {
  return makeSource({
    id: makeSourceLocation(ABS_PATH, EXT_ROOT),
    kind: "model",
    fingerprint: FP,
    state: { tag: "Indexed", type: "@scope/foo/instance", bundle: BUNDLE },
    sourceMtime: "2026-01-15T10:00:00.000Z",
  });
}

Deno.test("makeSource: stores all fields", () => {
  const s = indexedSource();
  assertEquals(s.kind, "model");
  assertEquals(s.fingerprint, FP);
  assertEquals(s.state.tag, "Indexed");
  assertEquals(s.id.relativePath, "models/instance.ts");
  assertEquals(s.sourceMtime, "2026-01-15T10:00:00.000Z");
});

Deno.test("withState: returns a NEW Source, leaves original untouched", () => {
  const original = indexedSource();
  const next = withState(original, {
    tag: "ValidationFailed",
    bundle: BUNDLE,
    lastError: "schema mismatch",
  });

  // The original is unchanged — referential equality preserved.
  assertEquals(original.state.tag, "Indexed");
  // The new instance is a distinct object.
  assertFalse(original === next);
  // The new instance reflects the transition.
  assertEquals(next.state.tag, "ValidationFailed");
  // Identity, kind, fingerprint, and mtime flow through untouched.
  assert(original.id === next.id);
  assertEquals(original.kind, next.kind);
  assertEquals(original.fingerprint, next.fingerprint);
  assertEquals(next.sourceMtime, original.sourceMtime);
});

Deno.test("withFingerprintAndState: replaces both atomically", () => {
  const original = indexedSource();
  const newBundle = makeBundleLocation("/repo/.swamp/bundles/y.js", "def456");
  const next = withFingerprintAndState(original, "def456", {
    tag: "Indexed",
    type: "@scope/foo/instance",
    bundle: newBundle,
  }, "2026-02-20T15:30:00.000Z");

  assertFalse(original === next);
  assertEquals(original.fingerprint, FP); // original unchanged
  assertEquals(next.fingerprint, "def456");
  assertEquals(next.state.tag, "Indexed");
  if (next.state.tag === "Indexed") {
    assertEquals(next.state.bundle.fingerprint, "def456");
  }
  assertEquals(next.sourceMtime, "2026-02-20T15:30:00.000Z");
  assertEquals(original.sourceMtime, "2026-01-15T10:00:00.000Z");
});
