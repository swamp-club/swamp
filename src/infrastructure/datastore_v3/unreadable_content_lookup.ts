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
 * The loud-read lookup of a v3 checkout (swamp-club#3617): tells a
 * repository whether content missing from the checkout is a record the read
 * model could not materialise.
 *
 * @module
 */

import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import type {
  UnreadableContentEntry,
  UnreadableContentLookup,
} from "../../domain/datastore/datastore_sync_service.ts";
import {
  type UnreadableRecord,
  unreadableRecordAdvice,
  UnreadableRecordError,
} from "../../domain/datastore_v3/read_model.ts";
import { swampPath } from "../persistence/paths.ts";
import { errorPaths, markErrorPaths, UserError } from "../../domain/errors.ts";

/** The read model's side of the lookup. */
export interface UnreadableRecordSource {
  unreadableRecord(
    namespace: string,
    recordKey: string,
  ): Promise<UnreadableRecord | undefined>;
  /** The unreadable records under the directory `keyPrefix`, if listable. */
  unreadableRecordsUnder?(
    namespace: string,
    keyPrefix: string,
  ): Promise<readonly UnreadableRecord[]>;
}

/**
 * The lookup over `source` for the checkout at `repoDir`, spelled as the
 * repositories of its context spell it.
 *
 * A content path maps to a namespace and record key relative to the
 * checkout's `.swamp/`: the cache root of namespace `ns` is `.swamp/` (solo)
 * or `.swamp/<ns>`, so a path is tried as a solo key and, under a first
 * segment, as that namespace's key. The paths compare as written first; only
 * when the content path is not under `repoDir` as written (a repository
 * built from another spelling of the checkout, such as a symlink or macOS's
 * `/tmp`) do both resolve their symlinks.
 *
 * A lookup that fails throws a {@link UserError} naming the path rather
 * than reading as absent: it runs only after a read found no file, and
 * reading a record it could not check as absent is the silent "no data"
 * the lookup exists to end. The read model's state is a WAL database with a
 * busy timeout, so an ordinary absent file does not fail on a passing lock;
 * a closed read model (a command shutting down) still reads as absent.
 *
 * When `source` can list records by key prefix, the lookup also has
 * `under`: the records under a directory, mapped from it as a path is, each
 * spelled under the directory as the caller gave it.
 */
export function unreadableContentLookup(
  repoDir: string,
  source: UnreadableRecordSource,
): UnreadableContentLookup {
  const lookup = async (absPath: string) => {
    try {
      for (
        const [namespace, recordKey] of await recordKeysOf(repoDir, absPath)
      ) {
        const record = await source.unreadableRecord(namespace, recordKey);
        if (record !== undefined) return new UnreadableRecordError(record);
      }
    } catch (error) {
      throw lookupFailed(
        absPath,
        `Could not tell whether ${absPath}, which this checkout does not have, is a record the datastore could not materialise`,
        error,
      );
    }
    return undefined;
  };
  const listUnder = source.unreadableRecordsUnder?.bind(source);
  if (listUnder === undefined) return lookup;
  // The records under a directory, mapped from it as a path is: one range
  // query per (namespace, prefix) the directory may be.
  const under = async (
    absDir: string,
  ): Promise<readonly UnreadableContentEntry[]> => {
    const entries: UnreadableContentEntry[] = [];
    try {
      for (
        const [namespace, keyPrefix] of await recordKeysOf(repoDir, absDir)
      ) {
        for (const record of await listUnder(namespace, keyPrefix)) {
          const rest = record.recordKey.slice(keyPrefix.length + 1);
          entries.push({
            path: join(absDir, ...rest.split("/")),
            error: new UnreadableRecordError(record),
            advice: unreadableRecordAdvice(record.recordKey),
          });
        }
      }
    } catch (error) {
      throw lookupFailed(
        absDir,
        `Could not list the records under ${absDir} the datastore could not materialise`,
        error,
      );
    }
    return entries;
  };
  return Object.assign(lookup, { under });
}

/** A lookup that could not ask the read model, naming the path asked. */
function lookupFailed(path: string, what: string, error: unknown): UserError {
  return markErrorPaths(
    new UserError(
      `${what}: ${
        error instanceof Error ? error.message : String(error)
      }. Run the command again; if it keeps failing, run \`swamp doctor datastores\`.`,
    ),
    [path, ...errorPaths(error)],
  );
}

/** The (namespace, record key) pairs `absPath` may be in the checkout. */
async function recordKeysOf(
  repoDir: string,
  absPath: string,
): Promise<[string, string][]> {
  const root = swampPath(repoDir);
  const rel = inside(root, absPath) ??
    inside(await canonicalPath(root), await canonicalPath(absPath));
  if (rel === undefined) return [];
  const segments = rel.split(SEPARATOR);
  const keys: [string, string][] = [["", segments.join("/")]];
  if (segments.length > 1) {
    keys.push([segments[0], segments.slice(1).join("/")]);
  }
  return keys;
}

/** `path` relative to `root` when it is strictly inside it. */
function inside(root: string, path: string): string | undefined {
  const rel = relative(resolve(root), resolve(path));
  if (rel === "" || rel === ".." || rel.startsWith(`..${SEPARATOR}`)) {
    return undefined;
  }
  // On Windows a path on another drive comes back absolute.
  if (isAbsolute(rel)) return undefined;
  return rel;
}

/**
 * `path` with symlinks resolved, through its nearest existing parent when
 * it does not exist (the content file the read missed).
 */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    const parent = dirname(resolve(path));
    if (parent === resolve(path)) return resolve(path);
    return join(await canonicalPath(parent), basename(path));
  }
}
