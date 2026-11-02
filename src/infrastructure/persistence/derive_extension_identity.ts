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

import { basename } from "@std/path";
import { BEHAVIORS_DIR_NAME } from "../../domain/terminology/behavior_aliases.ts";

/**
 * pulled extensions get an empty version (the lockfile owns it); local ones get
 * @local/<repo> at 0.0.0, which callers override from the manifest, keeping
 * this a pure string transform
 */
export interface ExtensionIdentity {
  readonly name: string;
  readonly version: string;
}

/**
 * pure string transform: callers must pre-canonicalize sourcePath and repoRoot
 * so prefix matching is stable; the longest known name wins since names can
 * contain kind segments
 */
export function deriveExtensionIdentity(
  sourcePath: string,
  repoRoot: string,
  knownNames: readonly string[] = [],
): ExtensionIdentity | null {
  // pulled roots are checked before the local rule so a pulled name containing
  // extensions/<kind> is not taken as local; the trailing slash keeps
  // pulled-extensions-archive from matching
  for (const root of PULLED_ROOTS) {
    const pulledPrefix = joinForward(repoRoot, root);
    if (!sourcePath.startsWith(pulledPrefix)) continue;
    const nameAndRest = sourcePath.slice(pulledPrefix.length);
    const name = extractPulledExtensionName(nameAndRest, knownNames);
    if (name === null) {
      return null;
    }
    return { name, version: "" };
  }

  if (containsKnownExtensionsKindSegment(sourcePath)) {
    return {
      name: `@local/${basename(repoRoot)}`,
      version: "0.0.0",
    };
  }

  return null;
}

const PULLED_ROOTS = [
  ".swamp/pulled-extensions/",
  ".swamp/config/pulled-extensions/",
] as const;

function containsKnownExtensionsKindSegment(path: string): boolean {
  const parts = path.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    if (
      parts[i] === "extensions" &&
      (KIND_SEGMENTS.has(parts[i + 1]) ||
        LOCAL_ONLY_KIND_SEGMENTS.has(parts[i + 1]))
    ) {
      return true;
    }
  }
  return false;
}

const KIND_SEGMENTS = new Set([
  "models",
  "vaults",
  "datastores",
  "reports",
  "webhooks",
  "workflows",
  "skills",
]);

/**
 * behaviors/ exists only in local and source-mounted trees, so it stays out of
 * KIND_SEGMENTS, which also splits pulled names; a pulled @org/behaviors/...
 * keeps its whole name
 */
const LOCAL_ONLY_KIND_SEGMENTS = new Set([BEHAVIORS_DIR_NAME]);

function extractPulledExtensionName(
  nameAndRest: string,
  knownNames: readonly string[],
): string | null {
  let known: string | null = null;
  for (const name of knownNames) {
    if (
      nameAndRest.startsWith(`${name}/`) &&
      (known === null || name.length > known.length)
    ) {
      known = name;
    }
  }
  if (known !== null) return known;

  const parts = nameAndRest.split("/");
  // Scoped names (`@scope/name`) always have at least two segments, so
  // a kind-named second segment is part of the name, not a delimiter.
  const minNameSegments = parts[0].startsWith("@") ? 2 : 0;
  for (let i = minNameSegments; i < parts.length; i++) {
    if (KIND_SEGMENTS.has(parts[i])) {
      if (i === 0) return null;
      return parts.slice(0, i).join("/");
    }
  }
  return null;
}

/**
 * joins with forward slashes to match canonicalizePath output on Windows;
 * @std/path join would emit backslashes
 */
function joinForward(dir: string, rel: string): string {
  const trimmedDir = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  const trimmedRel = rel.startsWith("/") ? rel.slice(1) : rel;
  return `${trimmedDir}/${trimmedRel}`;
}
