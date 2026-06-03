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

import { assert, assertFalse } from "@std/assert";
import { bundleLocationEquals, makeBundleLocation } from "./bundle_location.ts";

Deno.test("bundleLocationEquals: identical path + fingerprint are equal", () => {
  const a = makeBundleLocation("/repo/.swamp/bundles/foo.js", "abc123");
  const b = makeBundleLocation("/repo/.swamp/bundles/foo.js", "abc123");
  assert(bundleLocationEquals(a, b));
});

Deno.test("bundleLocationEquals: same path different fingerprint are unequal", () => {
  // Same bundle file location, different content — the fingerprint
  // distinguishes a stale bundle from a fresh one.
  const a = makeBundleLocation("/repo/.swamp/bundles/foo.js", "abc123");
  const b = makeBundleLocation("/repo/.swamp/bundles/foo.js", "def456");
  assertFalse(bundleLocationEquals(a, b));
});

Deno.test("bundleLocationEquals: same fingerprint different path are unequal", () => {
  const a = makeBundleLocation("/repo/.swamp/bundles/foo.js", "abc123");
  const b = makeBundleLocation("/repo/.swamp/bundles/bar.js", "abc123");
  assertFalse(bundleLocationEquals(a, b));
});

Deno.test("bundleLocationEquals: MISSING-prefixed fingerprint is just another value", () => {
  // The MISSING:<hash> shape is opaque to BundleLocation — equality is
  // pure string comparison.
  const a = makeBundleLocation("/repo/.swamp/bundles/foo.js", "MISSING:xx");
  const b = makeBundleLocation("/repo/.swamp/bundles/foo.js", "MISSING:xx");
  assert(bundleLocationEquals(a, b));
});
