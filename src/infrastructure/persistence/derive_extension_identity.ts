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

import { basename } from "@std/path";

/**
 * Logical identity of an extension as the catalog records it.
 *
 *   - For pulled extensions, `name` is parsed from the on-disk path
 *     (`.swamp/pulled-extensions/<name>/<kind>/...`); `version` is
 *     intentionally left empty because the on-disk layout encodes only
 *     the name. Version is owned by `upstream_extensions.json` (the
 *     lockfile) and consulted at read time by `ExtensionRepository`'s
 *     empty-version fallback (W1b). Treating the catalog and the
 *     lockfile as two systems of record — with the lockfile
 *     authoritative for version — keeps W1a's schema migration narrow.
 *
 *   - For local extensions (rows under `<repo>/extensions/<kind>/`),
 *     this function returns the synthetic `@local/<basename(repoRoot)>`
 *     at version `"0.0.0"`. When `extensions/manifest.yaml` declares
 *     both `name` and `version`, callers (e.g. {@link ExtensionRepository},
 *     {@link ReconcileFromDiskService}) override this synthetic identity
 *     with the manifest-sourced values. The override happens outside
 *     this function — `deriveExtensionIdentity` remains a pure string
 *     transform that does not read the filesystem beyond its inputs.
 */
export interface ExtensionIdentity {
  readonly name: string;
  readonly version: string;
}

/**
 * Derives the logical extension identity for a catalog row's
 * `source_path`. Returns `null` when the path matches neither layout —
 * the W1a migration converts null to "drop the row," and the W1b
 * `ExtensionRepository` fallback converts null to "skip + DELETE the
 * orphaned row" with a structured warning.
 *
 * The function is a pure string transform. It does not stat the
 * filesystem, does not read the lockfile, and does not normalize
 * `..`/`.` segments. Callers must pre-canonicalize `sourcePath` and
 * `repoRoot` (see {@link canonicalizePath}) so prefix matching is
 * stable across mixed-case filesystems.
 *
 * Layout rules (issue swamp-club#211, W1):
 *
 *   - Pulled: `<repoRoot>/.swamp/pulled-extensions/<name>/...`
 *     Note <name> may contain forward slashes (scoped extension names
 *     like `@swamp/aws/ec2` are common). The function consumes
 *     everything between the `pulled-extensions/` prefix and the next
 *     known kind segment (`models`, `vaults`, `drivers`, `datastores`,
 *     `reports`, `workflows`, `skills`) as the name.
 *   - Local or source-mounted: any path containing an
 *     `/extensions/<kind>/` segment where `<kind>` is one of the known
 *     kind directory names. Both `<repoRoot>/extensions/<kind>/...`
 *     (repo-internal locals) and `<externalDir>/extensions/<kind>/...`
 *     (source-mounted via `swamp extension source add <externalDir>`)
 *     match this rule. They roll up into the same synthetic
 *     `@local/<basename(repoRoot)>` aggregate: per the design doc,
 *     `@local/<repo-name>` covers every Source under every
 *     `extensions/<kind>/` tree for the repo regardless of whether
 *     the source dir is inside the repo or mounted from outside.
 *   - Otherwise: `null`.
 *
 * Found-during-implementation correction from issue/v5 spec: the issue
 * body claimed pulled paths encode `<name>/<version>`. They encode
 * `<name>` only. Version comes from the lockfile.
 *
 * Source-mounted handling note: catalog rows for source-mounted
 * extensions have absolute paths outside `repoRoot` (e.g.
 * `/some/external/dir/extensions/models/foo.ts`). An earlier draft of
 * this helper only matched `<repoRoot>/extensions/` and missed those
 * rows; the generalised "any `/extensions/<kind>/` segment" rule
 * catches both layouts.
 */
export function deriveExtensionIdentity(
  sourcePath: string,
  repoRoot: string,
): ExtensionIdentity | null {
  // The migration's sub-step 4 has already canonicalized source_path
  // (lowercase + forward-slash on Windows; raw on POSIX). We do the
  // same prefix matching here so a TS-driven backfill loop and the
  // W1b runtime fallback share the exact same matching semantics.
  // pulledPrefix always ends in '/', so plain startsWith is correct —
  // it can't match `/repo/.swamp/pulled-extensions-archive/...` because
  // the literal `/` after `pulled-extensions` is part of the prefix.
  const pulledPrefix = joinForward(repoRoot, ".swamp/pulled-extensions/");
  if (sourcePath.startsWith(pulledPrefix)) {
    const nameAndRest = sourcePath.slice(pulledPrefix.length);
    const name = extractPulledExtensionName(nameAndRest);
    if (name === null) {
      // Path is under pulled-extensions/ but doesn't have a recognizable
      // <name>/<kind>/ segment — corrupt or non-standard layout.
      return null;
    }
    return { name, version: "" };
  }

  // Local or source-mounted: any `/extensions/<kind>/` segment where
  // <kind> is one of the known kind directory names. Catches both
  // repo-internal locals (under `<repoRoot>/extensions/<kind>/`) and
  // source-added external dirs (`/external/dir/extensions/<kind>/`).
  if (containsKnownExtensionsKindSegment(sourcePath)) {
    return {
      name: `@local/${basename(repoRoot)}`,
      version: "0.0.0",
    };
  }

  return null;
}

/**
 * Walks the path's `/extensions/<kind>/` segments looking for a known
 * kind directory after the literal `extensions/` segment. Returns true
 * if and only if the path contains `**\/extensions/<known-kind>/...`.
 */
function containsKnownExtensionsKindSegment(path: string): boolean {
  const parts = path.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === "extensions" && KIND_SEGMENTS.has(parts[i + 1])) {
      return true;
    }
  }
  return false;
}

/** Kind subdirectory names that delimit the end of an extension name
 *  inside the pulled-extensions tree. Matches the directories created
 *  by `installExtension` at `pull.ts:892` (per-kind subtree under the
 *  per-extension subtree).
 */
const KIND_SEGMENTS = new Set([
  "models",
  "vaults",
  "drivers",
  "datastores",
  "reports",
  "workflows",
  "skills",
]);

/**
 * Walks segment by segment through the trailing portion of a pulled
 * path until it hits a known kind segment, returning everything
 * consumed before that as the extension name. Returns null when the
 * path has no kind segment (corrupt/non-standard layout).
 *
 * Examples (sourcePath after `pulledPrefix` is stripped):
 *   "@scope/foo/models/x.ts"          → "@scope/foo"
 *   "@hivemq/harvester/kubeconfig/models/harvester/kubeconfig.ts"
 *                                     → "@hivemq/harvester/kubeconfig"
 *   "no-kind-segment/file.ts"         → null
 *   "models/at-the-root.ts"           → null (zero-length name)
 */
function extractPulledExtensionName(nameAndRest: string): string | null {
  const parts = nameAndRest.split("/");
  for (let i = 0; i < parts.length; i++) {
    if (KIND_SEGMENTS.has(parts[i])) {
      if (i === 0) return null; // Empty name — meaningless.
      return parts.slice(0, i).join("/");
    }
  }
  return null;
}

/**
 * Joins a directory and a relative path with forward slashes, matching
 * the canonical form produced by {@link canonicalizePath} on Windows
 * and the natural form on POSIX. We deliberately do not use
 * `@std/path/join` here — `join` produces backslashes on Windows,
 * which would not match canonicalized source_path values.
 */
function joinForward(dir: string, rel: string): string {
  const trimmedDir = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  const trimmedRel = rel.startsWith("/") ? rel.slice(1) : rel;
  return `${trimmedDir}/${trimmedRel}`;
}
