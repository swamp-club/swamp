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

import { createHash } from "node:crypto";
import { join } from "@std/path";
import type {
  ProcessIdentity,
  ProcessVerdict,
  RecordedProcess,
} from "../../domain/datastore_v3/process_liveness.ts";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";
import { judgeRecorded, localProcess } from "./process_identity.ts";

const COMMAND_LEASES_DIR = "command_leases";
const LEASE_ID = /^[A-Za-z0-9-]{1,128}$/;

/** the command leases one checkout's processes hold at one serve, as one caller */
export interface CommandLeaseRecords {
  record(lease: { leaseId: string; lockKey: string }): Promise<void>;
  forget(leaseId: string): Promise<void>;
  /** leases on `lockKey` whose recorded process is gone from this host */
  deadOn(lockKey: string): Promise<readonly string[]>;
}

interface RecordedCommandLease {
  readonly leaseId: string;
  readonly lockKey: string;
  readonly serverUrl: string;
  readonly caller: string;
  readonly pid: number;
  readonly process: ProcessIdentity;
}

export function commandLeaseRecordsAt(
  root: string,
  serverUrl: string,
  token: string | undefined,
  judge: (recorded: RecordedProcess) => Promise<ProcessVerdict> = judgeRecorded,
): CommandLeaseRecords {
  const dir = join(root, COMMAND_LEASES_DIR);
  // the same fingerprint a checkout view records: never the token itself
  const caller = createHash("sha256").update(token ?? "").digest("hex");
  const pathOf = (leaseId: string): string | undefined =>
    LEASE_ID.test(leaseId) ? join(dir, `${leaseId}.json`) : undefined;
  return {
    async record(lease) {
      const path = pathOf(lease.leaseId);
      if (path === undefined) return;
      const local = await localProcess();
      const recorded: RecordedCommandLease = {
        leaseId: lease.leaseId,
        lockKey: lease.lockKey,
        serverUrl,
        caller,
        pid: local.pid,
        process: local.identity,
      };
      await Deno.mkdir(dir, { recursive: true });
      await atomicWriteTextFile(path, JSON.stringify(recorded));
    },
    async forget(leaseId) {
      const path = pathOf(leaseId);
      if (path === undefined) return;
      await Deno.remove(path).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    },
    async deadOn(lockKey) {
      const dead: string[] = [];
      let entries;
      try {
        entries = await Array.fromAsync(Deno.readDir(dir));
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return dead;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile || !entry.name.endsWith(".json")) continue;
        const recorded = await readRecord(join(dir, entry.name));
        // another checkout's, caller's or serve's lease is never this one's
        if (
          recorded === undefined || recorded.lockKey !== lockKey ||
          recorded.serverUrl !== serverUrl || recorded.caller !== caller ||
          `${recorded.leaseId}.json` !== entry.name
        ) {
          continue;
        }
        const verdict = await judge({
          pid: recorded.pid,
          process: recorded.process,
        });
        if (verdict === "gone") dead.push(recorded.leaseId);
      }
      return dead;
    },
  };
}

async function readRecord(
  path: string,
): Promise<RecordedCommandLease | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(path));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const process = record.process as Record<string, unknown> | undefined;
  if (
    typeof record.leaseId !== "string" || !LEASE_ID.test(record.leaseId) ||
    typeof record.lockKey !== "string" ||
    typeof record.serverUrl !== "string" ||
    typeof record.caller !== "string" ||
    !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0 ||
    typeof process !== "object" || process === null ||
    typeof process.host !== "string"
  ) {
    return undefined;
  }
  return {
    leaseId: record.leaseId,
    lockKey: record.lockKey,
    serverUrl: record.serverUrl,
    caller: record.caller,
    pid: record.pid as number,
    process: {
      host: process.host,
      ...(typeof process.bootId === "string" ? { bootId: process.bootId } : {}),
      ...(typeof process.startTime === "string"
        ? { startTime: process.startTime }
        : {}),
    },
  };
}
