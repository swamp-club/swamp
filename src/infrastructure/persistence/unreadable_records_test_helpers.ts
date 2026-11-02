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

import { configure, type LogRecord, reset } from "@logtape/logtape";
import { relative, resolve, SEPARATOR } from "@std/path";
import type {
  UnreadableContentEntry,
  UnreadableContentLookup,
} from "../../domain/datastore/datastore_sync_service.ts";
import { UNREADABLE_CONTENT_CODE } from "../../domain/datastore/unreadable_content.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import { initializeLogging } from "../logging/logger.ts";

export const FAKE_ADVICE = "Write the record again.";

export function fakeUnreadableLookup(paths: readonly string[]) {
  const errors = new Map(
    paths.map((path) => [
      resolve(path),
      markErrorPaths(
        new UserError(
          `The record ${path} cannot be read.`,
          UNREADABLE_CONTENT_CODE,
        ),
        [path],
      ),
    ]),
  );
  const stats = { listings: 0 };
  const lookup: UnreadableContentLookup = Object.assign(
    (absPath: string) => Promise.resolve(errors.get(resolve(absPath))),
    {
      under: (absDir: string) => {
        stats.listings++;
        const entries: UnreadableContentEntry[] = [];
        for (const [path, error] of errors) {
          const rel = relative(resolve(absDir), path);
          if (rel === "" || rel.startsWith("..") || rel.startsWith(SEPARATOR)) {
            continue;
          }
          entries.push({ path, error, advice: FAKE_ADVICE });
        }
        return Promise.resolve(entries);
      },
    },
  );
  return { lookup, errors, stats };
}

export async function captureUnreadableWarnings(
  fn: () => Promise<void>,
  category: string[] = ["swamp", "persistence", "unreadable-records"],
): Promise<string[]> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      {
        category,
        lowestLevel: "warning",
        sinks: ["capture"],
      },
      { category: ["logtape", "meta"], lowestLevel: "error", sinks: [] },
    ],
    reset: true,
  });
  try {
    await fn();
  } finally {
    await reset();
    await initializeLogging({});
  }
  return records.map((record) => record.message.map(String).join(""));
}
