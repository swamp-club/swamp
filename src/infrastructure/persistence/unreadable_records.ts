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

import { getLogger } from "@logtape/logtape";
import type {
  UnreadableContentEntry,
  UnreadableContentLookup,
} from "../../domain/datastore/datastore_sync_service.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";

const logger = getLogger(["swamp", "persistence", "unreadable-records"]);

export async function unreadableRecordsUnder(
  lookup: UnreadableContentLookup | undefined,
  absDir: string,
): Promise<readonly UnreadableContentEntry[]> {
  return await lookup?.under?.(absDir) ?? [];
}

const warnedLeftOut = new Set<string>();

/**
 * one warning per listing and each record named once per process; a failed
 * query warns too, since failing the listing would hide the readable records
 */
export async function warnUnreadableLeftOut(
  lookup: UnreadableContentLookup | undefined,
  absDir: string,
  include: (entry: UnreadableContentEntry) => boolean = () => true,
): Promise<void> {
  if (lookup?.under === undefined) return;
  let entries: readonly UnreadableContentEntry[];
  try {
    entries = await lookup.under(absDir);
  } catch (error) {
    logger
      .warn`Could not check for records under ${absDir} the datastore could not materialise, so this answer may leave some out: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return;
  }
  const fresh = entries.filter((entry) =>
    include(entry) && !warnedLeftOut.has(entry.path)
  );
  if (fresh.length === 0) return;
  for (const entry of fresh) warnedLeftOut.add(entry.path);
  const advice = [...new Set(fresh.map((entry) => entry.advice))].join(" ");
  logger
    .warn`This answer leaves out records that cannot be read, because a chunk of each is missing or damaged in the datastore: ${
    fresh.map((entry) => entry.path).join(", ")
  }. ${advice}`;
}

/**
 * the code is not_found, not the unreadable-content code: the subject may be a
 * mistyped id none of them holds, so it must not read as a read of one of them
 */
export function mayBeUnreadableError(
  subject: string,
  entries: readonly UnreadableContentEntry[],
): UserError {
  const advice = [...new Set(entries.map((entry) => entry.advice))].join(" ");
  return markErrorPaths(
    new UserError(
      `${subject} was not found. It may be one of these records, which cannot be read because a chunk of each is missing or damaged in the datastore: ${
        entries.map((entry) => entry.path).join(", ")
      }. ${advice}`,
      "not_found",
    ),
    entries.map((entry) => entry.path),
  );
}
