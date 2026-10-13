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

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { z } from "zod";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { refuseSymlinks, startDir } from "./start_session_file_repository.ts";

/** Where a running `swamp start` server can be reached. */
export interface StartServerRecord {
  readonly pid: number;
  readonly port: number;
  readonly token: string;
  readonly startedAt: string;
}

const RecordSchema = z.object({
  pid: z.number().int(),
  port: z.number().int(),
  token: z.string().min(1),
  startedAt: z.string(),
});

/**
 * The folder of records, one per `swamp start` process that has the
 * workspace open. Several processes may have one workspace open at once.
 */
function recordsDir(workspacePath: string): string {
  return join(startDir(workspacePath), "servers");
}

/**
 * The folders a record lives under. Records hold the page token, so none of
 * them may be a link planted by an imported workspace.
 */
function recordFolders(workspacePath: string): string[] {
  return [
    join(workspacePath, ".swamp"),
    startDir(workspacePath),
    recordsDir(workspacePath),
  ];
}

function recordPath(workspacePath: string, pid: number): string {
  return join(recordsDir(workspacePath), `${pid}.json`);
}

/** Every readable record for the workspace; unreadable ones are skipped. */
export async function readStartServerRecords(
  workspacePath: string,
): Promise<StartServerRecord[]> {
  const records: StartServerRecord[] = [];
  try {
    await refuseSymlinks(recordFolders(workspacePath));
  } catch {
    // Records behind a planted link are never trusted.
    return records;
  }
  try {
    for await (const entry of Deno.readDir(recordsDir(workspacePath))) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      try {
        const raw = await Deno.readTextFile(
          join(recordsDir(workspacePath), entry.name),
        );
        const parsed = RecordSchema.safeParse(JSON.parse(raw));
        // A record lives at <pid>.json; one whose name doesn't match its
        // pid wasn't written by a swamp start, and pruning it by pid would
        // remove a different file.
        if (parsed.success && entry.name === `${parsed.data.pid}.json`) {
          records.push(parsed.data);
        }
      } catch {
        // A record removed or half-written meanwhile is not a live server.
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return records;
}

/** Writes this process's record, mode 0600. */
export async function writeStartServerRecord(
  workspacePath: string,
  record: StartServerRecord,
): Promise<void> {
  await refuseSymlinks(recordFolders(workspacePath));
  await ensureDir(recordsDir(workspacePath));
  await atomicWriteTextFile(
    recordPath(workspacePath, record.pid),
    JSON.stringify(record, null, 2) + "\n",
    { mode: 0o600 },
  );
}

/** Deletes one process's record; a missing file is fine. */
export async function removeStartServerRecord(
  workspacePath: string,
  pid: number,
): Promise<void> {
  await refuseSymlinks(recordFolders(workspacePath));
  try {
    await Deno.remove(recordPath(workspacePath, pid));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}
