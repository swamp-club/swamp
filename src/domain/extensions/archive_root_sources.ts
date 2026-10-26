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

import {
  isReservedArchiveRootName,
  SHARED_ARCHIVE_DIR,
} from "./source_archive_plan.ts";

/** What an archive entry is, as its tar header records it. */
export type ArchiveEntryKind =
  | "file"
  | "directory"
  | "symlink"
  | "hardlink"
  | "character-device"
  | "block-device"
  | "fifo"
  | "unsupported";

/**
 * Why each kind other than a file or directory refuses the archive. None
 * quotes anything from the header beyond the entry's own path: a link's
 * target is the archive author's text.
 */
const REFUSED_KIND_REASONS: Readonly<
  Record<Exclude<ArchiveEntryKind, "file" | "directory">, string>
> = {
  "symlink": "is a symlink; extensions may not contain links",
  "hardlink": "is a hardlink; extensions may not contain links",
  "character-device": "is a character device; an extension holds only " +
    "regular files and directories",
  "block-device": "is a block device; an extension holds only regular " +
    "files and directories",
  "fifo": "is a FIFO; an extension holds only regular files and directories",
  "unsupported": "has an unsupported tar entry type; an extension holds " +
    "only regular files and directories",
};

/** One entry of an extension archive. */
export interface ArchiveEntry {
  /** Forward-slash path inside the archive, e.g. `extension/lib/cmp.ts`. */
  path: string;
  kind: ArchiveEntryKind;
}

/** Why pull refuses an archive, naming the entry that decided it. */
export interface ArchiveEntryRefusal {
  path: string;
  reason: string;
}

/** The directory every extension archive keeps its content under. */
const ARCHIVE_ROOT = "extension";

/**
 * Names that change how Deno or npm resolve the modules beside them. One
 * installed among shared sources would reconfigure the extension's source
 * when it is rebundled, so pull refuses it. Compared without case: on a
 * case-insensitive file system `Deno.json` is found as `deno.json`.
 */
const RESOLUTION_CONFIG_NAMES: ReadonlySet<string> = new Set([
  "deno.json",
  "deno.jsonc",
  "package.json",
  "node_modules",
]);

/**
 * Whether a top-level entry of `extension/` holds shared sources: a name
 * push mirrored there because it is not reserved, or `_shared/`, which push
 * reserves for the modules no mirrored path can hold.
 */
function isSharedSourceRoot(name: string): boolean {
  return name === SHARED_ARCHIVE_DIR || !isReservedArchiveRootName(name);
}

/**
 * Segments of `path` with any leading `./` and empty segments dropped.
 * Splits on `\` as well as `/`: a tar header may hold either, and on
 * Windows the extractor writes `\` as a separator, so classifying on `/`
 * alone would let `lib\deno.json` pass as one harmless segment.
 */
function segmentsOf(path: string): string[] {
  return path.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
}

/**
 * The entry's path below `extension/` as segments, or undefined when the
 * entry lies outside it (pull reads nothing there).
 */
function extensionSegments(path: string): string[] | undefined {
  const segments = segmentsOf(path);
  if (segments[0] !== ARCHIVE_ROOT || segments.length < 2) return undefined;
  return segments.slice(1);
}

/**
 * Whether `name` differs from a reserved root name only by case. On a
 * case-insensitive file system it would install into that kind's directory.
 */
function aliasesReservedName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower !== name && isReservedArchiveRootName(lower);
}

/**
 * Why pull refuses an archive holding `entry`, or undefined when the entry
 * is acceptable. Decided from the tar header alone, so a caller can refuse
 * before the entry is written.
 *
 * - Anything but a regular file or directory anywhere in the archive: a
 *   symlink, hardlink, device, FIFO or unsupported entry type. Push writes
 *   only files and directories, and its safety gate refuses links in
 *   sources, so an installed extension never holds a link.
 * - Under a top-level entry holding shared sources (a name that is not
 *   reserved, or `_shared/`; swamp-club#3384): a backslash (push always
 *   writes `/`), a hidden or `..` segment, a Deno or npm resolution config
 *   file or `node_modules`, or a top-level name that differs from a
 *   reserved one only by case.
 *
 * Entries under reserved names keep the rules pull applied before.
 */
export function archiveEntryRefusal(
  entry: ArchiveEntry,
): ArchiveEntryRefusal | undefined {
  if (entry.kind !== "file" && entry.kind !== "directory") {
    return { path: entry.path, reason: REFUSED_KIND_REASONS[entry.kind] };
  }
  const segments = extensionSegments(entry.path);
  if (segments === undefined || !isSharedSourceRoot(segments[0])) {
    return undefined;
  }
  if (entry.path.includes("\\")) {
    return {
      path: entry.path,
      reason: "contains a backslash; archive paths use forward slashes",
    };
  }
  if (aliasesReservedName(segments[0])) {
    return {
      path: entry.path,
      reason: `differs only by case from the reserved archive directory ${
        segments[0].toLowerCase()
      }`,
    };
  }
  if (segments.some((s) => s.startsWith("."))) {
    return {
      path: entry.path,
      reason: "is hidden; shared sources may not contain hidden files",
    };
  }
  const config = segments.find((s) =>
    RESOLUTION_CONFIG_NAMES.has(s.toLowerCase())
  );
  if (config !== undefined) {
    return {
      path: entry.path,
      reason: `is ${config}, which would change how the installed ` +
        `extension's modules resolve`,
    };
  }
  return undefined;
}

/** What pull installs from the archive root, or why it refuses the archive. */
export interface ArchiveRootSourcePlan {
  /**
   * Forward-slash paths below `extension/` of the shared source files to
   * install at the same path under the extension's install root, sorted.
   */
  sources: string[];
  /** Every entry that refuses the archive, in archive order. */
  refusals: ArchiveEntryRefusal[];
}

/**
 * Plans the archive-root shared sources pull installs: every regular file
 * under `_shared/` or a top-level entry of `extension/` whose name is not
 * reserved (swamp-club#3384). Push places a shared module there when it sits outside
 * its kind's directory, so the installed source resolves as the archive
 * does. Directories install nothing of their own, so an empty legacy
 * directory adds nothing.
 */
export function planArchiveRootSources(
  entries: readonly ArchiveEntry[],
): ArchiveRootSourcePlan {
  const sources: string[] = [];
  const refusals: ArchiveEntryRefusal[] = [];
  for (const entry of entries) {
    const refusal = archiveEntryRefusal(entry);
    if (refusal) {
      refusals.push(refusal);
      continue;
    }
    if (entry.kind !== "file") continue;
    const segments = extensionSegments(entry.path);
    if (segments === undefined || !isSharedSourceRoot(segments[0])) {
      continue;
    }
    sources.push(segments.join("/"));
  }
  return { sources: [...new Set(sources)].sort(), refusals };
}

/**
 * The top-level directories `sources` occupy under the install root: the
 * first segment of every source below one. A nested extension installed
 * at one of these would share its directory with the parent's sources.
 */
export function archiveRootSourceDirs(sources: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const source of sources) {
    const segments = source.split("/");
    if (segments.length > 1) dirs.add(segments[0]);
  }
  return [...dirs].sort();
}
