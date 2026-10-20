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
 * Reads of a directory of records that a v3 read model may hold unreadable
 * records under (swamp-club#3617): a record whose chunk is missing or
 * damaged has no file, so a listing would leave it out without a word, and
 * a lookup by an id its file name does not carry would find nothing.
 *
 * @module
 */

import { getLogger } from "@logtape/logtape";
import type {
  UnreadableContentEntry,
  UnreadableContentLookup,
} from "../../domain/datastore/datastore_sync_service.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";

const logger = getLogger(["swamp", "persistence", "unreadable-records"]);

/**
 * The unreadable records under `absDir`, spelled under it; empty when the
 * lookup cannot list (no v3 datastore). One query per namespace the
 * directory may be in. A failing query throws, as a single-path lookup does.
 */
export async function unreadableRecordsUnder(
  lookup: UnreadableContentLookup | undefined,
  absDir: string,
): Promise<readonly UnreadableContentEntry[]> {
  return await lookup?.under?.(absDir) ?? [];
}

/** Paths this process has warned were left out of a listing. */
const warnedLeftOut = new Set<string>();

/**
 * Warns that a listing of `absDir`, or a search of it that found nothing,
 * leaves out the unreadable records under it that `include` keeps (all of
 * them by default), naming each with the way to bring it back or remove
 * it. The answer itself is unchanged, so its output (and `--json` shape)
 * stays the same.
 *
 * One warning per listing, not per record; a record is named once per
 * process, so a command that lists the same directory twice, or serve's
 * repeated sweeps, do not repeat it. A query that fails is a warning too:
 * the readable records listed are still right, and failing the whole
 * listing over the check would hide them.
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
 * The error of a lookup that found nothing where unreadable records it
 * cannot tell apart (their file names do not carry what it looked up) may
 * hold the answer: it says `subject` was not found and names them, rather
 * than report it simply absent. Its code is `not_found`, not the
 * unreadable-content code: the subject may be a mistyped id that none of
 * them holds, so it must not read as a read of one of them.
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
