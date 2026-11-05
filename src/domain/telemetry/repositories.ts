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

import type { TelemetryEntry } from "./telemetry_entry.ts";
import type { TelemetryFlushRecord } from "./telemetry_flush_record.ts";

export interface TelemetryRepository {
  /** never throws; errors are logged silently */
  save(entry: TelemetryEntry): Promise<void>;

  findByDate(date: Date): Promise<TelemetryEntry[]>;

  findByDateRange(startDate: Date, endDate: Date): Promise<TelemetryEntry[]>;

  /** unflushed entries are preserved for retry */
  deleteOlderThan(date: Date): Promise<number>;

  deleteAllOlderThan(date: Date): Promise<number>;

  /**
   * with endpoint, only entries stamped for it or unstamped are returned; the
   * limit applies after filtering so other endpoints cannot crowd a batch out
   */
  findUnflushed(limit: number, endpoint?: string): Promise<TelemetryEntry[]>;

  /**
   * false means the entry stays on disk and findUnflushed returns it again; a
   * caller that flushes repeatedly must not resend it or the invocation is
   * counted once per attempt
   */
  markFlushed(entry: TelemetryEntry, keepFlushed?: boolean): Promise<boolean>;

  /**
   * escape hatch for a permanently rejected entry: a batch is marked only after
   * it all sends, so without this one always-rejected entry blocks every newer
   * one
   */
  quarantine(entry: TelemetryEntry): Promise<void>;

  /**
   * quarantined entries are not deliverable, so unlike unflushed ones they are
   * not worth retaining indefinitely
   */
  deleteQuarantinedOlderThan(date: Date): Promise<number>;
}

/** advisory: never throws, and a missing or invalid record reads as null */
export interface TelemetryFlushRecordRepository {
  read(): Promise<TelemetryFlushRecord | null>;
  write(record: TelemetryFlushRecord): Promise<void>;
}
