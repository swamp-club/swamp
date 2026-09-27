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

/**
 * The file an extension member (method, check or resource spec) came from,
 * ranked for collision resolution (swamp-club#2562).
 *
 * `sourcePath` must already be canonical (see `canonicalizePath`), so two
 * surface forms of one file compare equal and the tie-break is stable
 * across hosts.
 */
export interface ExtensionContributor {
  readonly sourcePath: string;
  readonly pulled: boolean;
}

/**
 * True when `canonicalPath` lives under one of the repo's pulled-extension
 * roots: `<repoRoot>/.swamp/pulled-extensions/` or, for managedConfig
 * repos, `<repoRoot>/.swamp/config/pulled-extensions/`. Those are the only
 * roots `resolvePulledExtensionsRoot` returns. Everything else — local
 * sources and source-mounted directories — is non-pulled.
 *
 * Both arguments must be canonical.
 */
export function isPulledExtensionPath(
  canonicalPath: string,
  canonicalRepoRoot: string,
): boolean {
  const sep = canonicalRepoRoot.endsWith("/") ? "" : "/";
  return canonicalPath.startsWith(
    `${canonicalRepoRoot}${sep}.swamp/pulled-extensions/`,
  ) ||
    canonicalPath.startsWith(
      `${canonicalRepoRoot}${sep}.swamp/config/pulled-extensions/`,
    );
}

/**
 * Orders two contributors for collision resolution. Negative means `a`
 * wins. Non-pulled (local and source-mounted) outranks pulled — the same
 * `local > pulled` rule the catalog applies to primary types — and within
 * a tier the lexicographically smaller canonical path wins, matching the
 * Extension aggregate's I2 tie-break. A total order, so the winner of any
 * set of contributors does not depend on the order they attach in.
 */
export function compareExtensionPrecedence(
  a: ExtensionContributor,
  b: ExtensionContributor,
): number {
  if (a.pulled !== b.pulled) return a.pulled ? 1 : -1;
  if (a.sourcePath < b.sourcePath) return -1;
  if (a.sourcePath > b.sourcePath) return 1;
  return 0;
}

/** Short human label for a contributor's tier, used in collision warnings. */
export function contributorTier(c: ExtensionContributor): string {
  return c.pulled ? "pulled" : "local";
}
