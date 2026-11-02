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

import { relative } from "@std/path";
import { errorPaths, markErrorPaths } from "../../domain/errors.ts";
import { ReleaseChannel } from "../../domain/extensions/release_channel.ts";
import { isBundleArtifactPath } from "./paths.ts";

export interface UpstreamExtensionEntry {
  version: string;
  pulledAt: string;
  files?: string[];
  include?: string[];
  checksum?: string;
  /**
   * digest of the extracted files, so auto-update can detect local edits before
   * overwriting; absent on older lockfile entries, so consumers must tolerate
   * it
   */
  filesChecksum?: string;
  serverUrl?: string;
  /** absent on older lockfile entries; consumers default to stable when missing */
  channel?: string;
  /**
   * channel the registry listed the pulled version on; differs from channel
   * when an exact version was pulled from another channel
   */
  publishedChannel?: string;
}

/**
 * the lockfile is repo-controlled, so a hand-edited value is ignored rather
 * than shown
 */
export function readPublishedChannel(
  entry: Pick<UpstreamExtensionEntry, "publishedChannel">,
): string | null {
  const value = entry.publishedChannel;
  return typeof value === "string" && ReleaseChannel.isValid(value)
    ? value
    : null;
}

export type UpstreamExtensionsMap = Record<string, UpstreamExtensionEntry>;

/**
 * relative() writes the OS separator, so a Windows lockfile holds backslashes
 * that POSIX would read as part of a file name
 */
export function canonicalLockfilePath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function lockfileRelative(from: string, to: string): string {
  return canonicalLockfilePath(relative(from, to));
}

/**
 * bundle namespaces hash an OS-separated path and bundles are rebuilt locally,
 * so bundle cache paths are dropped from files; applying it twice changes
 * nothing
 */
export function canonicalLockfileEntry<T>(entry: T): T {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return entry;
  }
  // fromEntries defines own properties, so a `__proto__` key in the
  // repo-controlled file stays data.
  return Object.fromEntries(
    Object.entries(entry).map(([key, value]) => {
      if ((key !== "files" && key !== "include") || !Array.isArray(value)) {
        return [key, value];
      }
      const paths = value.map((item) =>
        typeof item === "string" ? canonicalLockfilePath(item) : item
      );
      return [
        key,
        key === "files"
          ? paths.filter((item) =>
            typeof item !== "string" || !isBundleArtifactPath(item)
          )
          : paths,
      ];
    }),
  ) as T;
}

/**
 * invalid JSON or a non-object throws a SyntaxError naming the file, so callers
 * treat both as the same corrupt lockfile
 */
export async function readUpstreamExtensions(
  lockfilePath: string,
): Promise<UpstreamExtensionsMap> {
  let content: string;
  try {
    content = await Deno.readTextFile(lockfilePath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {};
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw markErrorPaths(
      new SyntaxError(
        `Cannot parse lockfile ${lockfilePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
      [lockfilePath, ...errorPaths(error)],
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const found = parsed === null
      ? "null"
      : Array.isArray(parsed)
      ? "an array"
      : typeof parsed;
    throw markErrorPaths(
      new SyntaxError(
        `Lockfile ${lockfilePath} must contain a JSON object, found ${found}`,
      ),
      [lockfilePath],
    );
  }
  return Object.fromEntries(
    Object.entries(parsed).map((
      [name, entry],
    ) => [name, canonicalLockfileEntry(entry)]),
  );
}
