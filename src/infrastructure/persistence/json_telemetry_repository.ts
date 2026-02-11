import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import type { TelemetryRepository } from "../../domain/telemetry/repositories.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";
import {
  TelemetryEntry,
  type TelemetryEntryData,
} from "../../domain/telemetry/telemetry_entry.ts";

/**
 * JSON-based implementation of TelemetryRepository.
 *
 * Stores telemetry entries as JSON files in the directory structure:
 * {repoDir}/.swamp/telemetry/telemetry-{YYYY-MM-DD}-{uuid}.json
 *
 * Each invocation creates a single file (no locking issues).
 * Errors are silently logged to avoid breaking CLI execution.
 */
export class JsonTelemetryRepository implements TelemetryRepository {
  constructor(private readonly repoDir: string) {}

  /**
   * Saves a telemetry entry to a JSON file.
   * Never throws - errors are logged silently if SWAMP_DEBUG is set.
   */
  async save(entry: TelemetryEntry): Promise<void> {
    try {
      const telemetryDir = this.getTelemetryDir();
      await ensureDir(telemetryDir);

      const date = entry.startedAt.toISOString().split("T")[0];
      const filename = `telemetry-${date}-${entry.id}.json`;
      const path = join(telemetryDir, filename);

      const json = JSON.stringify(entry.toData(), null, 2);
      await Deno.writeTextFile(path, json);
    } catch (error) {
      // Silent failure - log only if SWAMP_DEBUG
      if (Deno.env.get("SWAMP_DEBUG")) {
        console.error("[Telemetry] Failed to write:", error);
      }
      // Never throw - telemetry errors shouldn't break CLI
    }
  }

  /**
   * Finds all telemetry entries for a given date.
   */
  async findByDate(date: Date): Promise<TelemetryEntry[]> {
    const entries: TelemetryEntry[] = [];
    const dateStr = date.toISOString().split("T")[0];
    const prefix = `telemetry-${dateStr}-`;

    try {
      const telemetryDir = this.getTelemetryDir();

      for await (const entry of Deno.readDir(telemetryDir)) {
        if (
          entry.isFile &&
          entry.name.startsWith(prefix) &&
          entry.name.endsWith(".json")
        ) {
          try {
            const path = join(telemetryDir, entry.name);
            const content = await Deno.readTextFile(path);
            const data = JSON.parse(content) as TelemetryEntryData;
            entries.push(TelemetryEntry.fromData(data));
          } catch {
            // Skip files that can't be parsed
          }
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return entries;
  }

  /**
   * Finds all telemetry entries within a date range.
   */
  async findByDateRange(
    startDate: Date,
    endDate: Date,
  ): Promise<TelemetryEntry[]> {
    const entries: TelemetryEntry[] = [];

    // Iterate through each day in the range
    const current = new Date(startDate);
    current.setHours(0, 0, 0, 0);

    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    while (current <= end) {
      const dayEntries = await this.findByDate(current);
      entries.push(...dayEntries);
      current.setDate(current.getDate() + 1);
    }

    return entries;
  }

  /**
   * Deletes all telemetry entries older than the given date.
   */
  async deleteOlderThan(date: Date): Promise<number> {
    let deletedCount = 0;
    const cutoffDateStr = date.toISOString().split("T")[0];

    try {
      const telemetryDir = this.getTelemetryDir();

      for await (const entry of Deno.readDir(telemetryDir)) {
        if (
          entry.isFile &&
          entry.name.startsWith("telemetry-") &&
          entry.name.endsWith(".json")
        ) {
          // Extract date from filename: telemetry-YYYY-MM-DD-uuid.json
          const dateMatch = entry.name.match(/^telemetry-(\d{4}-\d{2}-\d{2})-/);
          if (dateMatch) {
            const fileDate = dateMatch[1];
            if (fileDate < cutoffDateStr) {
              try {
                const path = join(telemetryDir, entry.name);
                await Deno.remove(path);
                deletedCount++;
              } catch {
                // Ignore errors when deleting individual files
              }
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return 0;
      }
      // Log but don't throw for cleanup operations
      if (Deno.env.get("SWAMP_DEBUG")) {
        console.error("[Telemetry] Cleanup error:", error);
      }
    }

    return deletedCount;
  }

  /**
   * Finds unflushed telemetry entries, sorted oldest first.
   */
  async findUnflushed(limit: number): Promise<TelemetryEntry[]> {
    const entries: Array<{ entry: TelemetryEntry; startedAt: Date }> = [];

    try {
      const telemetryDir = this.getTelemetryDir();

      for await (const dirEntry of Deno.readDir(telemetryDir)) {
        if (
          dirEntry.isFile &&
          dirEntry.name.startsWith("telemetry-") &&
          dirEntry.name.endsWith(".json") &&
          !dirEntry.name.endsWith(".flushed.json")
        ) {
          try {
            const path = join(telemetryDir, dirEntry.name);
            const content = await Deno.readTextFile(path);
            const data = JSON.parse(content) as TelemetryEntryData;
            const entry = TelemetryEntry.fromData(data);
            entries.push({ entry, startedAt: entry.startedAt });
          } catch {
            // Skip files that can't be parsed
          }
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    // Sort oldest first by startedAt
    entries.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

    return entries.slice(0, limit).map((e) => e.entry);
  }

  /**
   * Marks a telemetry entry as flushed.
   * By default, deletes the file. If keepFlushed is true, renames to .flushed.json.
   */
  async markFlushed(
    entry: TelemetryEntry,
    keepFlushed?: boolean,
  ): Promise<void> {
    try {
      const telemetryDir = this.getTelemetryDir();
      const date = entry.startedAt.toISOString().split("T")[0];
      const filename = `telemetry-${date}-${entry.id}.json`;
      const filePath = join(telemetryDir, filename);

      if (keepFlushed) {
        const flushedFilename = `telemetry-${date}-${entry.id}.flushed.json`;
        const flushedPath = join(telemetryDir, flushedFilename);
        await Deno.rename(filePath, flushedPath);
      } else {
        await Deno.remove(filePath);
      }
    } catch {
      // Silent failure
    }
  }

  private getTelemetryDir(): string {
    return swampPath(this.repoDir, SWAMP_SUBDIRS.telemetry);
  }
}
