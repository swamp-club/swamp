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

import { canonicalizePath } from "../../infrastructure/persistence/canonicalize_path.ts";
import type { SourceFingerprint } from "./source_fingerprint.ts";

/**
 * Locates an on-disk bundle artifact for a Source. Carries the
 * fingerprint the bundle was built against — the pair `(canonicalPath,
 * fingerprint)` is what makes a bundle stale-detectable: if the source
 * fingerprint moves but the bundle's still points at the old hash, the
 * bundle is stale and must be rebuilt.
 *
 * Equality is by both fields — a bundle at the same path with a different
 * fingerprint is a different value (different content).
 */
export interface BundleLocation {
  readonly canonicalPath: string;
  readonly fingerprint: SourceFingerprint;
}

/**
 * Constructs a BundleLocation, canonicalizing the bundle path.
 */
export function makeBundleLocation(
  bundlePath: string,
  fingerprint: SourceFingerprint,
): BundleLocation {
  return {
    canonicalPath: canonicalizePath(bundlePath),
    fingerprint,
  };
}

/**
 * Equality by canonicalPath AND fingerprint.
 */
export function bundleLocationEquals(
  a: BundleLocation,
  b: BundleLocation,
): boolean {
  return a.canonicalPath === b.canonicalPath && a.fingerprint === b.fingerprint;
}
