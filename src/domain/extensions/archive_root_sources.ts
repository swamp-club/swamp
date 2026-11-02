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
 * none quotes anything from the header beyond the entry's own path, since a
 * link's target is the archive author's text
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

export interface ArchiveEntry {
  path: string;
  kind: ArchiveEntryKind;
}

export interface ArchiveEntryRefusal {
  path: string;
  reason: string;
}

const ARCHIVE_ROOT = "extension";

/**
 * these change how Deno or npm resolve neighbouring modules, so one among
 * shared sources would reconfigure the extension on rebundle; compared without
 * case since Deno.json is found as deno.json
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
 * splits on backslash too: a tar header may hold either, and on Windows the
 * extractor writes it as a separator, so lib\deno.json must not pass as one
 * harmless segment
 */
function segmentsOf(path: string): string[] {
  return path.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
}

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
 * decided from the tar header alone so a caller can refuse before writing.
 * Links and special entries are refused since push writes only files and
 * directories; shared-source roots get extra path checks.
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

export interface ArchiveRootSourcePlan {
  sources: string[];
  refusals: ArchiveEntryRefusal[];
}

/**
 * push places a shared module under _shared/ or a non-reserved top-level name
 * when it sits outside its kind's directory, so the installed source resolves
 * as the archive does
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
