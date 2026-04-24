// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import type { AuditRepository } from "../../domain/audit/audit_repository.ts";
import {
  type BashCommandEntry,
  type BashCommandEntryData,
  bashCommandEntryFromData,
  bashCommandEntryToData,
} from "../../domain/audit/audit_command_entry.ts";
import {
  AUDIT_FILENAME_PATTERN,
  auditFilePathForTimestamp,
} from "../../domain/audit/audit_path.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";

/**
 * JSONL-based implementation of AuditRepository.
 *
 * Stores bash command entries in date-partitioned JSONL files:
 * {repoDir}/.swamp/audit/commands-{YYYY-MM-DD}.jsonl
 *
 * Append-only for safe concurrent writes from hooks.
 * Silent failure to avoid breaking CLI execution.
 */
export class JsonlAuditRepository implements AuditRepository {
  private readonly baseDir: string;

  constructor(private readonly repoDir: string, baseDir?: string) {
    this.baseDir = baseDir ?? swampPath(repoDir, SWAMP_SUBDIRS.audit);
  }

  /**
   * Appends a bash command entry to the day's JSONL file.
   * Never throws.
   */
  async append(entry: BashCommandEntry): Promise<void> {
    try {
      const auditDir = this.getAuditDir();
      await ensureDir(auditDir);

      const path = auditFilePathForTimestamp(auditDir, entry.timestamp);

      const line = JSON.stringify(bashCommandEntryToData(entry)) + "\n";

      const file = await Deno.open(path, {
        write: true,
        create: true,
        append: true,
      });
      try {
        const encoder = new TextEncoder();
        await file.write(encoder.encode(line));
      } finally {
        file.close();
      }
    } catch (error) {
      if (Deno.env.get("SWAMP_DEBUG")) {
        console.error("[Audit] Failed to append:", error);
      }
    }
  }

  /**
   * Finds all bash command entries within a time range.
   */
  async findByTimeRange(
    startTime: Date,
    endTime: Date,
  ): Promise<BashCommandEntry[]> {
    const entries: BashCommandEntry[] = [];

    try {
      const auditDir = this.getAuditDir();

      // Iterate date range to find relevant files
      const current = new Date(startTime);
      current.setUTCHours(0, 0, 0, 0);

      const end = new Date(endTime);
      end.setUTCHours(23, 59, 59, 999);

      while (current <= end) {
        const path = auditFilePathForTimestamp(auditDir, current.toISOString());

        try {
          const content = await Deno.readTextFile(path);
          const lines = content.split("\n").filter((line) => line.trim());

          for (const line of lines) {
            try {
              const data = JSON.parse(line) as BashCommandEntryData;
              const entry = bashCommandEntryFromData(data);

              // Filter entries within the time range
              const entryTime = new Date(entry.timestamp);
              if (entryTime >= startTime && entryTime <= endTime) {
                entries.push(entry);
              }
            } catch {
              // Skip malformed lines
            }
          }
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) {
            if (Deno.env.get("SWAMP_DEBUG")) {
              console.error(`[Audit] Failed to read ${path}:`, error);
            }
          }
        }

        current.setUTCDate(current.getUTCDate() + 1);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      if (Deno.env.get("SWAMP_DEBUG")) {
        console.error("[Audit] Failed to read audit data:", error);
      }
    }

    return entries;
  }

  /**
   * Deletes audit files older than the given date.
   */
  async deleteOlderThan(date: Date): Promise<number> {
    let deletedCount = 0;
    const cutoffDateStr = date.toISOString().split("T")[0];

    try {
      const auditDir = this.getAuditDir();

      for await (const entry of Deno.readDir(auditDir)) {
        if (
          entry.isFile &&
          entry.name.startsWith("commands-") &&
          entry.name.endsWith(".jsonl")
        ) {
          const dateMatch = entry.name.match(AUDIT_FILENAME_PATTERN);
          if (dateMatch) {
            const fileDate = dateMatch[1];
            if (fileDate < cutoffDateStr) {
              try {
                await Deno.remove(join(auditDir, entry.name));
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
        console.error("[Audit] Cleanup error:", error);
      }
    }

    return deletedCount;
  }

  private getAuditDir(): string {
    return this.baseDir;
  }
}
