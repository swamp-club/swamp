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

/**
 * Repository interface for persisting and retrieving TelemetryEntry entities.
 */
export interface TelemetryRepository {
  /**
   * Saves a telemetry entry.
   * Returns a Promise that resolves when the write completes.
   * Should never throw - errors are logged silently.
   *
   * @param entry - The telemetry entry to save
   */
  save(entry: TelemetryEntry): Promise<void>;

  /**
   * Finds all telemetry entries for a given date.
   *
   * @param date - The date to search for entries
   * @returns Array of telemetry entries from that date
   */
  findByDate(date: Date): Promise<TelemetryEntry[]>;

  /**
   * Finds all telemetry entries within a date range.
   *
   * @param startDate - The start date (inclusive)
   * @param endDate - The end date (inclusive)
   * @returns Array of telemetry entries within the range
   */
  findByDateRange(startDate: Date, endDate: Date): Promise<TelemetryEntry[]>;

  /**
   * Deletes flushed telemetry entries older than the given date.
   * Unflushed entries are preserved for retry.
   *
   * @param date - Delete flushed entries older than this date
   * @returns The number of entries deleted
   */
  deleteOlderThan(date: Date): Promise<number>;

  /**
   * Deletes ALL telemetry entries older than the given date,
   * regardless of flush status. Hard retention cap.
   *
   * @param date - Delete all entries older than this date
   * @returns The number of entries deleted
   */
  deleteAllOlderThan(date: Date): Promise<number>;

  /**
   * Finds unflushed telemetry entries, sorted oldest first.
   * "Unflushed" entries are those that have not been sent to the remote endpoint.
   *
   * @param limit - Maximum number of entries to return
   * @returns Array of unflushed telemetry entries (oldest first)
   */
  findUnflushed(limit: number): Promise<TelemetryEntry[]>;

  /**
   * Marks a telemetry entry as flushed (sent to remote endpoint).
   * By default, deletes the file. If keepFlushed is true, renames to .flushed.json.
   *
   * Returns whether the entry was actually marked. A `false` return means the
   * entry is still on disk and will be read again by the next `findUnflushed`
   * — harmless for a one-shot CLI run, but a caller that flushes repeatedly
   * must not re-send it or the same invocation is counted once per attempt.
   *
   * @param entry - The entry to mark as flushed
   * @param keepFlushed - If true, rename instead of delete
   * @returns true if the entry was marked, false if the operation failed
   */
  markFlushed(entry: TelemetryEntry, keepFlushed?: boolean): Promise<boolean>;

  /**
   * Sets an entry aside as undeliverable, excluding it from future
   * `findUnflushed` results without deleting it.
   *
   * The escape hatch for a permanently-rejected entry. `findUnflushed`
   * returns the oldest entries first and a batch is only marked after the
   * whole batch sends, so without this a single entry the endpoint always
   * rejects blocks every newer entry behind it forever.
   *
   * @param entry - The entry to quarantine
   */
  quarantine(entry: TelemetryEntry): Promise<void>;

  /**
   * Deletes quarantined entries older than the given date.
   *
   * Quarantined entries are, by definition, not deliverable, so unlike
   * unflushed entries they are not worth retaining indefinitely.
   *
   * @param date - Delete quarantined entries older than this date
   * @returns The number of entries deleted
   */
  deleteQuarantinedOlderThan(date: Date): Promise<number>;
}
