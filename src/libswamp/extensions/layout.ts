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

import { SWAMP_DATA_DIR } from "../../infrastructure/persistence/paths.ts";
import { readUpstreamExtensions } from "../../infrastructure/persistence/upstream_extensions.ts";

/**
 * Generation of an on-disk extension layout.
 *
 * - `gen-1`: files in `extensions/<type>/…` (pre-`.swamp/`).
 * - `gen-2`: files in `.swamp/pulled-extensions/<type>/…` — the "flat"
 *   layout where types sit at the top and filenames collide across
 *   extensions.
 * - `current`: files in `.swamp/pulled-extensions/<@scope>/<name>/<type>/…`
 *   — per-extension subtree, no cross-extension collisions.
 */
export type ExtensionLayoutGeneration = "gen-1" | "gen-2" | "current";

/** A single lockfile file entry classified by generation. */
export interface LegacyFileEntry {
  extensionName: string;
  file: string;
  generation: "gen-1" | "gen-2";
}

/**
 * Known pulled-type dir names under `.swamp/pulled-extensions/`. Used
 * both by `classifyExtensionFile` (to detect gen-2 flat paths) and by
 * the phase-two migration in `RepoService` (to decide which tracked
 * files to delete). Keep this list in one place so the two never drift.
 */
export const PULLED_TYPE_DIRS: ReadonlySet<string> = new Set([
  "models",
  "workflows",
  "vaults",
  "drivers",
  "datastores",
  "reports",
  "skills",
  "files",
]);

const PULLED_PREFIX = `${SWAMP_DATA_DIR}/pulled-extensions/`;

/**
 * Classifies a single lockfile file path.
 *
 * - Returns `"gen-1"` when the path lives outside `.swamp/` (pre-`.swamp/`
 *   layout, e.g. `extensions/models/foo.ts`).
 * - Returns `"gen-2"` when the path lives under
 *   `.swamp/pulled-extensions/<type>/...` where `<type>` is a known
 *   pulled-type dir — the "flat" layout where filenames collide across
 *   extensions.
 * - Returns `"current"` for the per-extension subtree
 *   (`.swamp/pulled-extensions/@<scope>/...`) and for paths outside
 *   `pulled-extensions/` entirely (bundles, etc.).
 */
export function classifyExtensionFile(file: string): ExtensionLayoutGeneration {
  if (!file.startsWith(`${SWAMP_DATA_DIR}/`)) {
    return "gen-1";
  }
  if (!file.startsWith(PULLED_PREFIX)) {
    return "current";
  }
  const firstSegment = file.slice(PULLED_PREFIX.length).split("/")[0];
  if (PULLED_TYPE_DIRS.has(firstSegment)) {
    return "gen-2";
  }
  return "current";
}

/**
 * Detects whether a repository has pulled extensions in any legacy layout.
 *
 * Reads `upstream_extensions.json` and classifies each tracked file.
 * Returns a flat list of legacy entries (both gen-1 and gen-2) with their
 * generation tag so the upgrade migrator can branch.
 *
 * @param lockfilePath Full path to upstream_extensions.json
 */
export async function detectLegacyExtensionLayout(
  lockfilePath: string,
): Promise<LegacyFileEntry[]> {
  const upstream = await readUpstreamExtensions(lockfilePath);
  const legacy: LegacyFileEntry[] = [];

  for (const [name, entry] of Object.entries(upstream)) {
    if (!entry.files) continue;
    for (const file of entry.files) {
      const generation = classifyExtensionFile(file);
      if (generation === "gen-1" || generation === "gen-2") {
        legacy.push({ extensionName: name, file, generation });
      }
    }
  }

  return legacy;
}

/**
 * Emits a structured summary of legacy state suitable for renderer
 * consumption: per-extension set of flagged files and the generations
 * represented.
 */
export interface LegacyLayoutSummary {
  /** Names of extensions whose lockfile entries reference legacy paths. */
  extensionNames: string[];
  /** Total count of flagged file entries across all extensions. */
  fileCount: number;
  /** Which legacy generations are present. */
  generations: Set<"gen-1" | "gen-2">;
}

/**
 * Summarises detectLegacyExtensionLayout output into the shape that CLI
 * commands and the renderer prefer.
 */
export function summariseLegacyLayout(
  legacy: LegacyFileEntry[],
): LegacyLayoutSummary {
  const names = new Set<string>();
  const generations = new Set<"gen-1" | "gen-2">();
  for (const entry of legacy) {
    names.add(entry.extensionName);
    generations.add(entry.generation);
  }
  return {
    extensionNames: [...names].sort(),
    fileCount: legacy.length,
    generations,
  };
}

/**
 * Logs a warning when any pulled-extension entries are in a legacy layout.
 *
 * Prior versions threw here to hard-block extension commands until the
 * user ran `swamp repo upgrade`. That was the right call when migration
 * was rename-based and had to move everything atomically. The current
 * migration path is per-extension (re-install from the lockfile), so the
 * lockfile tolerates mixed-generation state and individual extensions can
 * be upgraded in any order. Commands proceed normally — they operate on
 * whatever paths the lockfile records — so extensions already in the new
 * layout stay usable even when others are pending migration.
 *
 * @param lockfilePath Full path to upstream_extensions.json
 * @param warn Invoked with a short human-readable message when legacy
 *   entries exist. Callers typically wire this to their logger's warn
 *   channel.
 * @returns The legacy summary, or `undefined` if everything is current.
 */
export async function warnLegacyExtensionLayout(
  lockfilePath: string,
  warn: (message: string) => void,
): Promise<LegacyLayoutSummary | undefined> {
  const legacy = await detectLegacyExtensionLayout(lockfilePath);
  if (legacy.length === 0) return undefined;
  const summary = summariseLegacyLayout(legacy);
  warn(
    `${summary.extensionNames.length} extension(s) pending migration. ` +
      `Run 'swamp repo upgrade' to complete.`,
  );
  return summary;
}

/**
 * Backwards-compatible alias that retains the old throw-on-legacy shape
 * for any caller that still depends on a hard-gate. New code should use
 * `warnLegacyExtensionLayout`. Kept to keep the migration window's diff
 * small — remove in a follow-up once all call sites have moved over.
 *
 * @deprecated Prefer `warnLegacyExtensionLayout` — the lockfile tolerates
 *   mixed-generation state.
 */
export async function requireCurrentExtensionLayout(
  lockfilePath: string,
): Promise<void> {
  const legacy = await detectLegacyExtensionLayout(lockfilePath);
  if (legacy.length === 0) return;
  const summary = summariseLegacyLayout(legacy);
  const msg =
    `${summary.extensionNames.length} extension(s) pending migration. ` +
    `Run 'swamp repo upgrade' to complete.`;
  // Lazy import to avoid circular deps with UserError consumers.
  const { UserError } = await import("../../domain/errors.ts");
  throw new UserError(msg);
}
