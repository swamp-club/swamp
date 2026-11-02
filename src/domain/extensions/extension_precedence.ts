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
 * sourcePath must already be canonical so two forms of one file compare equal
 * and the tie-break is stable across hosts
 */
export interface ExtensionContributor {
  readonly sourcePath: string;
  readonly pulled: boolean;
  readonly mountIndex?: number;
}

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
 * tiers are local > source-mounted > pulled, as the catalog applies and the
 * loader registers; earlier mount wins, then smaller canonical path; a total
 * order, so attach order never changes the winner
 */
export function compareExtensionPrecedence(
  a: ExtensionContributor,
  b: ExtensionContributor,
): number {
  if (a.pulled !== b.pulled) return a.pulled ? 1 : -1;
  const aMount = a.mountIndex ?? -1;
  const bMount = b.mountIndex ?? -1;
  if (aMount !== bMount) return aMount - bMount;
  if (a.sourcePath < b.sourcePath) return -1;
  if (a.sourcePath > b.sourcePath) return 1;
  return 0;
}

export function contributorTier(c: ExtensionContributor): string {
  if (c.pulled) return "pulled";
  return c.mountIndex === undefined ? "local" : "source-mounted";
}
