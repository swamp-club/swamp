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

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { z } from "zod";
import { atomicWriteTextFile } from "./atomic_write.ts";
import type { TelemetryFlushRecordRepository } from "../../domain/telemetry/repositories.ts";
import type { TelemetryFlushRecord } from "../../domain/telemetry/telemetry_flush_record.ts";

/** kept out of the telemetry-<date>- namespace so spool scans never read it */
export const TELEMETRY_FLUSH_RECORD_FILE = "flush-state.json";

const MAX_REASON_LENGTH = 200;

const FlushRecordSchema = z.object({
  lastAttemptAt: z.iso.datetime(),
  lastAttemptOk: z.boolean(),
  lastFailureReason: z.string().max(MAX_REASON_LENGTH).optional(),
  lastSuccessAt: z.iso.datetime().optional(),
  lastSentCount: z.number().int().nonnegative().optional(),
});

export class JsonTelemetryFlushRecordRepository
  implements TelemetryFlushRecordRepository {
  constructor(private readonly telemetryDir: string) {}

  async read(): Promise<TelemetryFlushRecord | null> {
    try {
      const content = await Deno.readTextFile(this.#path());
      const parsed = FlushRecordSchema.safeParse(JSON.parse(content));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async write(record: TelemetryFlushRecord): Promise<void> {
    try {
      await ensureDir(this.telemetryDir);
      const stored = record.lastFailureReason !== undefined
        ? {
          ...record,
          lastFailureReason: record.lastFailureReason.slice(
            0,
            MAX_REASON_LENGTH,
          ),
        }
        : record;
      // not durable: the record is advisory and written on every invocation
      await atomicWriteTextFile(
        this.#path(),
        JSON.stringify(stored, null, 2),
      );
    } catch (error) {
      if (Deno.env.get("SWAMP_DEBUG")) {
        console.error("[Telemetry] Failed to write flush record:", error);
      }
    }
  }

  #path(): string {
    return join(this.telemetryDir, TELEMETRY_FLUSH_RECORD_FILE);
  }
}
