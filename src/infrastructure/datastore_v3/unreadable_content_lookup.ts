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

export interface UnreadableRecordSource {
  unreadableRecord(
    namespace: string,
    recordKey: string,
  ): Promise<UnreadableRecord | undefined>;
  unreadableRecordsUnder?(
    namespace: string,
    keyPrefix: string,
  ): Promise<readonly UnreadableRecord[]>;
}

/**
 * a lookup that fails throws a UserError naming the path rather than reading as
 * absent, the silent no-data this lookup exists to end; a closed read model
 * still reads as absent
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

function inside(root: string, path: string): string | undefined {
  const rel = relative(resolve(root), resolve(path));
  if (rel === "" || rel === ".." || rel.startsWith(`..${SEPARATOR}`)) {
    return undefined;
  }
  // On Windows a path on another drive comes back absolute.
  if (isAbsolute(rel)) return undefined;
  return rel;
}

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
