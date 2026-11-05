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
import { refuseSymlinks } from "./start_session_file_repository.ts";

/** what a running `swamp serve` says about itself, for the hub overview */
export interface ServeInstanceRecord {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly authMode: string;
  readonly dashboard: boolean;
  readonly startedAt: string;
  readonly version: string;
}

const RecordSchema = z.object({
  pid: z.number().int().positive(),
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  url: z.string(),
  authMode: z.string(),
  dashboard: z.boolean(),
  startedAt: z.string(),
  version: z.string(),
});

function recordsDir(repoDir: string): string {
  return join(repoDir, ".swamp", "serve-instances");
}

/** none of these folders may be a link an imported repo planted */
function recordFolders(repoDir: string): string[] {
  return [join(repoDir, ".swamp"), recordsDir(repoDir)];
}

function recordPath(repoDir: string, pid: number): string {
  return join(recordsDir(repoDir), `${pid}.json`);
}

export async function writeServeInstanceRecord(
  repoDir: string,
  record: ServeInstanceRecord,
): Promise<void> {
  await refuseSymlinks(recordFolders(repoDir));
  await ensureDir(recordsDir(repoDir));
  await atomicWriteTextFile(
    recordPath(repoDir, record.pid),
    JSON.stringify(record, null, 2) + "\n",
    { mode: 0o600 },
  );
}

export async function removeServeInstanceRecord(
  repoDir: string,
  pid: number,
): Promise<void> {
  await refuseSymlinks(recordFolders(repoDir));
  try {
    await Deno.remove(recordPath(repoDir, pid));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/**
 * The serves running in a repo. A record whose process is gone is deleted, so
 * a serve that was killed never shows as running.
 */
export async function listServeInstances(
  repoDir: string,
  isAlive: (pid: number) => boolean,
): Promise<ServeInstanceRecord[]> {
  const records: ServeInstanceRecord[] = [];
  try {
    await refuseSymlinks(recordFolders(repoDir));
  } catch {
    // Records behind a planted link are never trusted.
    return records;
  }
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(recordsDir(repoDir)));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return records;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    const path = join(recordsDir(repoDir), entry.name);
    let parsed;
    try {
      parsed = RecordSchema.safeParse(
        JSON.parse(await Deno.readTextFile(path)),
      );
    } catch {
      // Removed or half-written meanwhile: not a running serve.
      continue;
    }
    // A record lives at <pid>.json; any other name was not written by serve.
    if (!parsed.success || entry.name !== `${parsed.data.pid}.json`) continue;
    if (isAlive(parsed.data.pid)) {
      records.push(parsed.data);
    } else {
      try {
        await Deno.remove(path);
      } catch {
        // Another reader pruned it first.
      }
    }
  }
  return records.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
