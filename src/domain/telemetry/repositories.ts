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
   * Deletes all telemetry entries older than the given date.
   *
   * @param date - Delete entries older than this date
   * @returns The number of entries deleted
   */
  deleteOlderThan(date: Date): Promise<number>;

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
   * @param entry - The entry to mark as flushed
   * @param keepFlushed - If true, rename instead of delete
   */
  markFlushed(entry: TelemetryEntry, keepFlushed?: boolean): Promise<void>;
}
