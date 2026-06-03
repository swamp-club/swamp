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

import { dirname, join } from "@std/path";
import type {
  AutoupdateLogEntry,
  AutoupdateLogRepository,
} from "../../domain/update/autoupdate_log.ts";
import { getSwampDataDir } from "../persistence/paths.ts";
import { atomicWriteTextFile } from "../persistence/atomic_write.ts";

const LOG_FILE_NAME = "autoupdate.log";

function logFilePath(): string {
  return join(getSwampDataDir(), "log", LOG_FILE_NAME);
}

export class AutoupdateLogFileRepository implements AutoupdateLogRepository {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? logFilePath();
  }

  async append(entry: AutoupdateLogEntry): Promise<void> {
    const dir = dirname(this.filePath);
    await Deno.mkdir(dir, { recursive: true });
    const line = JSON.stringify(entry) + "\n";
    await Deno.writeTextFile(this.filePath, line, { append: true });
  }

  async readAll(): Promise<AutoupdateLogEntry[]> {
    try {
      const content = await Deno.readTextFile(this.filePath);
      const entries: AutoupdateLogEntry[] = [];
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          entries.push(JSON.parse(trimmed) as AutoupdateLogEntry);
        } catch {
          // Skip malformed lines
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  async prune(maxAgeDays: number): Promise<void> {
    const entries = await this.readAll();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);
    const cutoffIso = cutoff.toISOString();

    const kept = entries.filter((e) => e.timestamp >= cutoffIso);
    if (kept.length === entries.length) return;

    const content = kept.map((e) => JSON.stringify(e)).join("\n") +
      (kept.length > 0 ? "\n" : "");
    await atomicWriteTextFile(this.filePath, content);
  }
}
