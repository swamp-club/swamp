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
import { atomicWriteTextFile } from "./atomic_write.ts";
import type { TelemetryRepository } from "../../domain/telemetry/repositories.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";
import { assertSafePath } from "./safe_path.ts";
import { readDirSorted } from "./sorted_dir_entries.ts";
import {
  TelemetryEntry,
  type TelemetryEntryData,
} from "../../domain/telemetry/telemetry_entry.ts";

export class JsonTelemetryRepository implements TelemetryRepository {
  private readonly baseDir: string;

  constructor(private readonly repoDir: string, baseDir?: string) {
    this.baseDir = baseDir ?? swampPath(repoDir, SWAMP_SUBDIRS.telemetry);
  }

  async save(entry: TelemetryEntry): Promise<void> {
    try {
      const telemetryDir = this.getTelemetryDir();
      await assertSafePath(telemetryDir, this.baseDir);
      await ensureDir(telemetryDir);

      const path = join(telemetryDir, this.entryFilename(entry));

      const json = JSON.stringify(entry.toData(), null, 2);
      await atomicWriteTextFile(path, json);
    } catch (error) {
      if (Deno.env.get("SWAMP_DEBUG")) {
        console.error("[Telemetry] Failed to write:", error);
      }
      // never throw: telemetry errors must not break the CLI
    }
  }

  async findByDate(date: Date): Promise<TelemetryEntry[]> {
    const entries: TelemetryEntry[] = [];
    const dateStr = date.toISOString().split("T")[0];
    const prefix = `telemetry-${dateStr}-`;

    try {
      const telemetryDir = this.getTelemetryDir();

      for (const entry of await readDirSorted(telemetryDir)) {
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

  async findByDateRange(
    startDate: Date,
    endDate: Date,
  ): Promise<TelemetryEntry[]> {
    const entries: TelemetryEntry[] = [];

    const current = new Date(startDate);
    current.setUTCHours(0, 0, 0, 0);

    const end = new Date(endDate);
    end.setUTCHours(23, 59, 59, 999);

    while (current <= end) {
      const dayEntries = await this.findByDate(current);
      for (const entry of dayEntries) entries.push(entry);
      current.setDate(current.getDate() + 1);
    }

    return entries;
  }

  /**
   * removes only .flushed.json files; unflushed entries are kept so they can be
   * retried
   */
  deleteOlderThan(date: Date): Promise<number> {
    return this.deleteByDate(date, true);
  }

  /**
   * hard retention cap regardless of flush status, preventing unbounded disk
   * growth when the endpoint is permanently unreachable
   */
  deleteAllOlderThan(date: Date): Promise<number> {
    return this.deleteByDate(date, false);
  }

  private async deleteByDate(
    date: Date,
    flushedOnly: boolean,
  ): Promise<number> {
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
          if (flushedOnly && !entry.name.endsWith(".flushed.json")) {
            continue;
          }

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
      if (Deno.env.get("SWAMP_DEBUG")) {
        console.error("[Telemetry] Cleanup error:", error);
      }
    }

    return deletedCount;
  }

  /**
   * filename sorting (the date prefix sorts chronologically) lets it stop
   * reading once limit entries are collected, avoiding O(n) reads of a large
   * spool; other endpoints' entries are read and skipped
   */
  async findUnflushed(
    limit: number,
    endpoint?: string,
  ): Promise<TelemetryEntry[]> {
    const filenames: string[] = [];

    try {
      const telemetryDir = this.getTelemetryDir();

      for await (const dirEntry of Deno.readDir(telemetryDir)) {
        if (
          dirEntry.isFile &&
          dirEntry.name.startsWith("telemetry-") &&
          dirEntry.name.endsWith(".json") &&
          !dirEntry.name.endsWith(".flushed.json") &&
          !dirEntry.name.endsWith(".quarantined.json")
        ) {
          filenames.push(dirEntry.name);
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    // Sort by filename — the `telemetry-YYYY-MM-DD-` prefix gives
    // chronological ordering. Within the same day, order is arbitrary
    // but acceptable for batch priority.
    filenames.sort();

    const telemetryDir = this.getTelemetryDir();
    const entries: TelemetryEntry[] = [];
    for (const filename of filenames) {
      if (entries.length >= limit) break;
      try {
        const path = join(telemetryDir, filename);
        const content = await Deno.readTextFile(path);
        const data = JSON.parse(content) as TelemetryEntryData;
        const entry = TelemetryEntry.fromData(data);
        if (endpoint === undefined || entry.isFlushableTo(endpoint)) {
          entries.push(entry);
        }
      } catch {
        // Skip files that can't be parsed
      }
    }

    return entries;
  }

  /**
   * returns false when the delete or rename fails; the entry stays and
   * findUnflushed returns it again, so a repeatedly-flushing caller must use
   * this result to avoid re-sending an accepted entry
   */
  async markFlushed(
    entry: TelemetryEntry,
    keepFlushed?: boolean,
  ): Promise<boolean> {
    try {
      const telemetryDir = this.getTelemetryDir();
      const filePath = join(telemetryDir, this.entryFilename(entry));

      if (keepFlushed) {
        const flushedPath = join(
          telemetryDir,
          this.entryFilename(entry, ".flushed.json"),
        );
        await Deno.rename(filePath, flushedPath);
      } else {
        await Deno.remove(filePath);
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * renamed to .quarantined.json, which findUnflushed skips; kept rather than
   * deleted since why an endpoint refuses a payload is usually visible only in
   * the payload
   */
  async quarantine(entry: TelemetryEntry): Promise<void> {
    try {
      const telemetryDir = this.getTelemetryDir();
      await Deno.rename(
        join(telemetryDir, this.entryFilename(entry)),
        join(telemetryDir, this.entryFilename(entry, ".quarantined.json")),
      );
    } catch {
      // best-effort: a failed quarantine leaves the entry unflushed, which the
      // caller's own retry accounting handles
    }
  }

  async deleteQuarantinedOlderThan(date: Date): Promise<number> {
    let deletedCount = 0;
    const cutoffDateStr = date.toISOString().split("T")[0];

    try {
      const telemetryDir = this.getTelemetryDir();

      for await (const entry of Deno.readDir(telemetryDir)) {
        if (
          !entry.isFile ||
          !entry.name.startsWith("telemetry-") ||
          !entry.name.endsWith(".quarantined.json")
        ) {
          continue;
        }

        const entryDateStr = entry.name.slice(
          "telemetry-".length,
          "telemetry-".length + 10,
        );
        if (entryDateStr >= cutoffDateStr) continue;

        try {
          await Deno.remove(join(telemetryDir, entry.name));
          deletedCount++;
        } catch {
          // Skip files that can't be removed
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    return deletedCount;
  }

  /**
   * the date prefix makes filenames sort chronologically, so findUnflushed
   * orders by name instead of parsing every file
   */
  private entryFilename(entry: TelemetryEntry, suffix = ".json"): string {
    const date = entry.startedAt.toISOString().split("T")[0];
    return `telemetry-${date}-${entry.id}${suffix}`;
  }

  private getTelemetryDir(): string {
    return this.baseDir;
  }
}
