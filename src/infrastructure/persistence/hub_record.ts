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
import { z } from "zod";
import { refuseSymlinks } from "./start_session_file_repository.ts";

/** Written by the Go hub; holds its admin token, so it is read, never trusted blindly. */
export interface HubRecord {
  readonly pid: number;
  readonly port: number;
  readonly adminToken: string;
  readonly version: string;
  readonly gitSha: string;
  readonly engine: string;
  readonly engineVersion: string;
  readonly engineGitSha: string;
  readonly autoExit: boolean;
}

const HubRecordSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  adminToken: z.string().min(1),
  version: z.string(),
  gitSha: z.string(),
  engine: z.string(),
  engineVersion: z.string(),
  engineGitSha: z.string(),
  autoExit: z.boolean(),
});

export function hubDir(dataDir: string): string {
  return join(dataDir, "hub");
}

export function hubRecordPath(dataDir: string): string {
  return join(hubDir(dataDir), "hub.json");
}

/** null when there is no record, or one that is planted, damaged or half-written */
export async function readHubRecord(
  dataDir: string,
): Promise<HubRecord | null> {
  const path = hubRecordPath(dataDir);
  try {
    await refuseSymlinks([dataDir, hubDir(dataDir), path]);
    const parsed = HubRecordSchema.safeParse(
      JSON.parse(await Deno.readTextFile(path)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
