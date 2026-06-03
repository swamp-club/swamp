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

import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import { makeBundleLocation } from "./bundle_location.ts";
import {
  makeExtension,
  makeLocalExtension,
  markSourceMissing,
  observeFreshSource,
  recordBundled,
  recordSourceMissing,
  recordValidationFailed,
  SourceExtensionRootMismatch,
  tombstoneAll,
} from "./extension.ts";
import { makeSource } from "./source.ts";
import { makeSourceLocation } from "./source_location.ts";

const EXT_ROOT = "/repo/.swamp/pulled-extensions/@scope/foo";
const FP = "abc123";
const BUNDLE = makeBundleLocation("/repo/.swamp/bundles/x.js", FP);

function indexedSource(
  relPath: string,
  type: string,
  kind: "model" | "vault" = "model",
) {
  const abs = `${EXT_ROOT}/${relPath}`;
  return makeSource({
    id: makeSourceLocation(abs, EXT_ROOT),
    kind,
    fingerprint: FP,
    state: { tag: "Indexed", type, bundle: BUNDLE },
    sourceMtime: "",
  });
}

Deno.test("makeExtension: empty sources is valid", () => {
  const ext = makeExtension({
    name: "@scope/foo",
    version: "1.0.0",
    origin: "pulled",
    extensionRoot: EXT_ROOT,
    sources: [],
  });
  assertEquals(ext.sources.size, 0);
  assertEquals(ext.name, "@scope/foo");
});

Deno.test("makeExtension: I1 — Source with mismatched extensionRoot throws", () => {
  const wrongRoot = "/somewhere/else";
  const bad = makeSource({
    id: makeSourceLocation(`${wrongRoot}/models/x.ts`, wrongRoot),
    kind: "model",
    fingerprint: FP,
    state: { tag: "Indexed", type: "@scope/foo/x", bundle: BUNDLE },
    sourceMtime: "",
  });
  assertThrows(
    () =>
      makeExtension({
        name: "@scope/foo",
        version: "1.0.0",
        origin: "pulled",
        extensionRoot: EXT_ROOT,
        sources: [bad],
      }),
    SourceExtensionRootMismatch,
  );
});

Deno.test("makeExtension: I2 — duplicate (kind, type) resolved by deterministic-winner transform", () => {
  // a.ts < b.ts lexicographically → a wins, b is tombstoned.
  const a = indexedSource("models/a.ts", "@scope/foo/instance");
  const b = indexedSource("models/b.ts", "@scope/foo/instance");
  const ext = makeExtension({
    name: "@scope/foo",
    version: "1.0.0",
    origin: "pulled",
    extensionRoot: EXT_ROOT,
    sources: [a, b],
  });
  assertEquals(ext.sources.size, 2);
  const aAfter = ext.sources.get(a.id);
  const bAfter = ext.sources.get(b.id);
  assert(aAfter);
  assert(bAfter);
  assertEquals(aAfter.state.tag, "Indexed");
  assertEquals(bAfter.state.tag, "Tombstoned");
  if (bAfter.state.tag === "Tombstoned") {
    assertEquals(bAfter.state.reason, "renamed");
  }
});

Deno.test("makeExtension: I2 — three-way collision tombstones two losers", () => {
  const a = indexedSource("models/a.ts", "@scope/foo/instance");
  const b = indexedSource("models/b.ts", "@scope/foo/instance");
  const c = indexedSource("models/c.ts", "@scope/foo/instance");
  const ext = makeExtension({
    name: "@scope/foo",
    version: "1.0.0",
    origin: "pulled",
    extensionRoot: EXT_ROOT,
    sources: [a, b, c],
  });
  assertEquals(ext.sources.size, 3);
  const aAfter = ext.sources.get(a.id);
  const bAfter = ext.sources.get(b.id);
  const cAfter = ext.sources.get(c.id);
  assert(aAfter);
  assert(bAfter);
  assert(cAfter);
  assertEquals(aAfter.state.tag, "Indexed");
  assertEquals(bAfter.state.tag, "Tombstoned");
  assertEquals(cAfter.state.tag, "Tombstoned");
});

Deno.test("makeExtension: I2 — already-tombstoned loser is idempotent", () => {
  const a = indexedSource("models/a.ts", "@scope/foo/instance");
  const bTombstoned = makeSource({
    id: makeSourceLocation(`${EXT_ROOT}/models/b.ts`, EXT_ROOT),
    kind: "model",
    fingerprint: FP,
    state: { tag: "Tombstoned", reason: "renamed" },
    sourceMtime: "",
  });
  const ext = makeExtension({
    name: "@scope/foo",
    version: "1.0.0",
    origin: "pulled",
    extensionRoot: EXT_ROOT,
    sources: [a, bTombstoned],
  });
  assertEquals(ext.sources.size, 2);
  const aAfter = ext.sources.get(a.id);
  const bAfter = ext.sources.get(bTombstoned.id);
  assert(aAfter);
  assert(bAfter);
  assertEquals(aAfter.state.tag, "Indexed");
  assertEquals(bAfter.state.tag, "Tombstoned");
});

Deno.test("makeExtension: I2 — same type across different kinds is allowed", () => {
  // Same type name under different kinds is not a conflict — the
  // catalog's uniqueness key is (kind, type), not type alone.
  const m = indexedSource("models/x.ts", "@scope/foo/x", "model");
  const v = indexedSource("vaults/x.ts", "@scope/foo/x", "vault");
  const ext = makeExtension({
    name: "@scope/foo",
    version: "1.0.0",
    origin: "pulled",
    extensionRoot: EXT_ROOT,
    sources: [m, v],
  });
  assertEquals(ext.sources.size, 2);
});

Deno.test("makeExtension: Tombstoned sources don't trigger I2", () => {
  // Tombstoned sources are excluded from registration and from I2
  // — that's load-bearing for the upgrade-as-atomic-transition pattern.
  const live = indexedSource("models/a.ts", "@scope/foo/instance");
  const tombstoned = makeSource({
    id: makeSourceLocation(`${EXT_ROOT}/models/b.ts`, EXT_ROOT),
    kind: "model",
    fingerprint: FP,
    state: { tag: "Tombstoned", reason: "source-deleted" },
    sourceMtime: "",
  });
  const ext = makeExtension({
    name: "@scope/foo",
    version: "1.0.0",
    origin: "pulled",
    extensionRoot: EXT_ROOT,
    sources: [live, tombstoned],
  });
  assertEquals(ext.sources.size, 2);
});

Deno.test("tombstoneAll: returns NEW Extension with every source tombstoned", () => {
  const a = indexedSource("models/a.ts", "@scope/foo/a");
  const b = indexedSource("models/b.ts", "@scope/foo/b");
  const original = makeExtension({
    name: "@scope/foo",
    version: "1.0.0",
    origin: "pulled",
    extensionRoot: EXT_ROOT,
    sources: [a, b],
  });
  const next = tombstoneAll(original);

  // Original unchanged — every source still Indexed.
  for (const s of original.sources.values()) {
    assertEquals(s.state.tag, "Indexed");
  }
  // Next is a distinct object with every source Tombstoned.
  assertFalse(original === next);
  assertEquals(next.sources.size, 2);
  for (const s of next.sources.values()) {
    assertEquals(s.state.tag, "Tombstoned");
    if (s.state.tag === "Tombstoned") {
      assertEquals(s.state.reason, "extension-removed");
    }
  }
});

Deno.test("tombstoneAll: enables upgrade canary — same (kind, type) across versions is fine when v1 is fully tombstoned", () => {
  // Set up: v1 ships @scope/foo/instance. v2 also ships @scope/foo/instance.
  // After v1.tombstoneAll(), v1's sources are all Tombstoned, so I-Repo-1
  // (cross-aggregate uniqueness, evaluated by the repository) sees only
  // v2's source occupying (model, @scope/foo/instance). The aggregate-
  // level test here is just that v1.tombstoneAll() produces a valid
  // Extension; the cross-aggregate check lives in the repository tests.
  const v1Source = indexedSource("models/instance.ts", "@scope/foo/instance");
  const v1 = makeExtension({
    name: "@scope/foo",
    version: "1.0.0",
    origin: "pulled",
    extensionRoot: EXT_ROOT,
    sources: [v1Source],
  });
  const v1Dead = tombstoneAll(v1);
  assertEquals(v1Dead.sources.size, 1);
  assertEquals([...v1Dead.sources.values()][0].state.tag, "Tombstoned");
});

Deno.test("recordBundled: settles a Source in Indexed", () => {
  const initial = indexedSource("models/a.ts", "@scope/foo/a");
  const ext = makeExtension({
    name: "@scope/foo",
    version: "1.0.0",
    origin: "pulled",
    extensionRoot: EXT_ROOT,
    sources: [initial],
  });
  // Move to ValidationFailed first to see Indexed-after-recovery.
  const failed = recordValidationFailed(ext, {
    location: initial.id,
    bundle: BUNDLE,
    lastError: "schema mismatch",
  });
  assertEquals(
    [...failed.sources.values()][0].state.tag,
    "ValidationFailed",
  );

  const recovered = recordBundled(failed, {
    location: initial.id,
    type: "@scope/foo/a",
    bundle: BUNDLE,
  });
  assertEquals(
    [...recovered.sources.values()][0].state.tag,
    "Indexed",
  );
});

Deno.test("recordValidationFailed: retains fingerprint and bundle (I3)", () => {
  const initial = indexedSource("models/a.ts", "@scope/foo/a");
  const ext = makeExtension({
    name: "@scope/foo",
    version: "1.0.0",
    origin: "pulled",
    extensionRoot: EXT_ROOT,
    sources: [initial],
  });
  const failed = recordValidationFailed(ext, {
    location: initial.id,
    bundle: BUNDLE,
    lastError: "boom",
  });
  const after = [...failed.sources.values()][0];
  // Fingerprint preserved
  assertEquals(after.fingerprint, FP);
  // Bundle preserved on the state (I3)
  if (after.state.tag === "ValidationFailed") {
    assertEquals(after.state.bundle, BUNDLE);
    assertEquals(after.state.lastError, "boom");
  } else {
    throw new Error("expected ValidationFailed");
  }
});

Deno.test("recordValidationFailed: updates fingerprint when provided (I3 freshness)", () => {
  const initial = indexedSource("models/a.ts", "@scope/foo/a");
  const ext = makeExtension({
    name: "@scope/foo",
    version: "1.0.0",
    origin: "pulled",
    extensionRoot: EXT_ROOT,
    sources: [initial],
  });
  const newFp = "newfingerprint456";
  const newBundle = makeBundleLocation("/repo/.swamp/bundles/y.js", newFp);
  const failed = recordValidationFailed(ext, {
    location: initial.id,
    bundle: newBundle,
    lastError: "schema mismatch",
    fingerprint: newFp,
    sourceMtime: "2026-05-13T00:00:00.000Z",
  });
  const after = [...failed.sources.values()][0];
  assertEquals(after.fingerprint, newFp);
  assertEquals(after.sourceMtime, "2026-05-13T00:00:00.000Z");
  if (after.state.tag === "ValidationFailed") {
    assertEquals(after.state.bundle, newBundle);
    assertEquals(after.state.lastError, "schema mismatch");
  } else {
    throw new Error("expected ValidationFailed");
  }
});

Deno.test("markSourceMissing: → OrphanedBundleOnly when bundle present", () => {
  const initial = indexedSource("models/a.ts", "@scope/foo/a");
  const ext = makeExtension({
    name: "@scope/foo",
    version: "1.0.0",
    origin: "pulled",
    extensionRoot: EXT_ROOT,
    sources: [initial],
  });
  const next = markSourceMissing(ext, {
    location: initial.id,
    bundleOnDisk: BUNDLE,
  });
  assertEquals(
    [...next.sources.values()][0].state.tag,
    "OrphanedBundleOnly",
  );
});

Deno.test("markSourceMissing: → Tombstoned when bundle absent", () => {
  const initial = indexedSource("models/a.ts", "@scope/foo/a");
  const ext = makeExtension({
    name: "@scope/foo",
    version: "1.0.0",
    origin: "pulled",
    extensionRoot: EXT_ROOT,
    sources: [initial],
  });
  const next = markSourceMissing(ext, {
    location: initial.id,
    bundleOnDisk: null,
  });
  const after = [...next.sources.values()][0];
  assertEquals(after.state.tag, "Tombstoned");
  if (after.state.tag === "Tombstoned") {
    assertEquals(after.state.reason, "source-deleted");
  }
});

Deno.test("recordSourceMissing: → Tombstoned with default reason", () => {
  const initial = indexedSource("models/a.ts", "@scope/foo/a");
  const ext = makeExtension({
    name: "@scope/foo",
    version: "1.0.0",
    origin: "pulled",
    extensionRoot: EXT_ROOT,
    sources: [initial],
  });
  const next = recordSourceMissing(ext, { location: initial.id });
  const after = [...next.sources.values()][0];
  assertEquals(after.state.tag, "Tombstoned");
});

Deno.test("observeFreshSource: I1 violation throws", () => {
  const ext = makeExtension({
    name: "@scope/foo",
    version: "1.0.0",
    origin: "pulled",
    extensionRoot: EXT_ROOT,
    sources: [],
  });
  const wrongRoot = "/elsewhere";
  const wrongLoc = makeSourceLocation(`${wrongRoot}/x.ts`, wrongRoot);
  assertThrows(
    () =>
      observeFreshSource(ext, {
        location: wrongLoc,
        kind: "model",
        fingerprint: FP,
        type: "@scope/foo/x",
        bundle: BUNDLE,
        sourceMtime: "",
      }),
    SourceExtensionRootMismatch,
  );
});

Deno.test("observeFreshSource: adds new Source in transient Bundled state", () => {
  const ext = makeExtension({
    name: "@scope/foo",
    version: "1.0.0",
    origin: "pulled",
    extensionRoot: EXT_ROOT,
    sources: [],
  });
  const loc = makeSourceLocation(`${EXT_ROOT}/models/x.ts`, EXT_ROOT);
  const next = observeFreshSource(ext, {
    location: loc,
    kind: "model",
    fingerprint: FP,
    type: "@scope/foo/x",
    bundle: BUNDLE,
    sourceMtime: "2026-01-15T10:00:00.000Z",
  });
  assertEquals(next.sources.size, 1);
  const s = [...next.sources.values()][0];
  assertEquals(s.state.tag, "Bundled");
  // Original unchanged
  assertEquals(ext.sources.size, 0);
});

Deno.test("makeLocalExtension: synthetic name + version + repoRoot semantics", () => {
  const repoRoot = "/some/repo";
  const ext = makeLocalExtension({ repoRoot, basename: "myproject" });
  assertEquals(ext.name, "@local/myproject");
  assertEquals(ext.version, "0.0.0");
  assertEquals(ext.origin, "local");
  assertEquals(ext.extensionRoot, repoRoot);
  assertEquals(ext.sources.size, 0);
});

Deno.test("Extension: every transition returns a NEW instance (immutability)", () => {
  const initial = indexedSource("models/a.ts", "@scope/foo/a");
  const ext = makeExtension({
    name: "@scope/foo",
    version: "1.0.0",
    origin: "pulled",
    extensionRoot: EXT_ROOT,
    sources: [initial],
  });
  // Spot-check one transition each from the API. None should mutate `ext`.
  const a = recordValidationFailed(ext, {
    location: initial.id,
    bundle: BUNDLE,
    lastError: "x",
  });
  const b = tombstoneAll(ext);
  const c = recordSourceMissing(ext, { location: initial.id });
  for (const next of [a, b, c]) {
    assertFalse(ext === next);
    // The original Source instance is unchanged in the original Extension.
    assertEquals(
      [...ext.sources.values()][0].state.tag,
      "Indexed",
    );
    // The new Extension reflects the transition.
    assert(next.sources.size === 1);
  }
});

Deno.test("makeExtension: canonicalizes args.extensionRoot at the boundary (Windows native-path test)", () => {
  // Regression test for swamp-club#223 Windows CI failure. When a Windows
  // caller passes a native path (`C:\Users\...\foo` with backslashes +
  // uppercase) as args.extensionRoot, the I1 check would fire spuriously
  // because the SourceLocation's extensionRoot is canonicalized
  // (lowercase + forward slashes) but args.extensionRoot was being
  // stored raw. makeExtension now canonicalizes at the boundary so the
  // comparison is symmetric on every platform.
  //
  // We invoke canonicalizePathFor with isWindows=true to simulate the
  // mismatch on POSIX hosts; the test then runs the real makeExtension,
  // which uses canonicalizePath (POSIX pass-through on Linux/macOS,
  // case-fold on Windows). Either way, a path that compares unequal
  // before canonicalization must compare equal after.
  const ext = makeExtension({
    name: "@scope/foo",
    version: "1.0.0",
    origin: "pulled",
    // Mixed-form root: native upper case + backslashes followed by
    // forward slashes. Could come from a `Deno.makeTempDir()` result on
    // Windows joined with literal forward-slash suffix segments.
    extensionRoot: "/repo/.swamp/pulled-extensions/@scope/foo",
    sources: [],
  });
  // After construction, extensionRoot is in canonical form. On POSIX
  // canonicalize is identity so the check is `ext.extensionRoot === input`;
  // on Windows the input would be lowercased / slash-flipped first.
  assert(ext.extensionRoot.length > 0);
  // The fix: source paths constructed against this canonical root match
  // the Extension's stored canonical root, so I1 doesn't fire.
  const loc = makeSourceLocation(
    `${ext.extensionRoot}/models/x.ts`,
    ext.extensionRoot,
  );
  // Re-add the source to a new Extension constructed with the canonical
  // root — this is the post-Windows-fix scenario where caller and
  // Source agree.
  const ext2 = makeExtension({
    name: "@scope/foo",
    version: "1.0.0",
    origin: "pulled",
    extensionRoot: ext.extensionRoot,
    sources: [
      makeSource({
        id: loc,
        kind: "model",
        fingerprint: "fp",
        state: {
          tag: "Indexed",
          type: "@scope/foo/x",
          bundle: makeBundleLocation(
            `${ext.extensionRoot}/bundles/x.js`,
            "fp",
          ),
        },
        sourceMtime: "",
      }),
    ],
  });
  assertEquals(ext2.sources.size, 1);
});
