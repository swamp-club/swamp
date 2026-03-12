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

import type { AuditRepository } from "./audit_repository.ts";
import {
  type AuditEntry,
  createDirectAuditEntry,
  createSwampAuditEntry,
} from "./audit_entry.ts";

/**
 * Commands that are filtered out by default as noise.
 * These are informational/read-only shell commands that don't
 * represent infrastructure changes.
 */
const NOISE_COMMAND_PREFIXES: string[] = [
  "ls",
  "cat",
  "head",
  "tail",
  "echo",
  "grep",
  "rg",
  "find",
  "which",
  "pwd",
  "whoami",
  "date",
  "wc",
  "sort",
  "uniq",
  "diff",
  "file",
  "stat",
  "tree",
  "less",
  "more",
  "man",
  "type",
  "printenv",
  "env",
  "set",
  "cd",
  "true",
  "false",
  "test",
  "[",
  "git status",
  "git log",
  "git diff",
  "git show",
  "git branch",
  "git remote",
  "git tag",
  "git rev-parse",
  "git config",
  "git stash list",
];

/** Default retention period in days for audit data */
const DEFAULT_RETENTION_DAYS = 7;

/**
 * Merged audit timeline result.
 */
export interface AuditTimeline {
  entries: AuditEntry[];
  totalSwamp: number;
  totalDirect: number;
  hoursAnalyzed: number;
}

/**
 * Options for building the audit timeline.
 */
export interface AuditTimelineOptions {
  hours: number;
  showAll: boolean;
  sessionId?: string;
}

/**
 * Service that categorizes hook-captured bash commands
 * into a unified audit timeline.
 *
 * Commands starting with "swamp" are tagged as source "swamp".
 * Everything else is tagged as source "direct".
 */
export class AuditService {
  constructor(
    private readonly auditRepository: AuditRepository,
  ) {}

  /**
   * Builds an audit timeline from hook-captured bash command logs.
   */
  async getTimeline(options: AuditTimelineOptions): Promise<AuditTimeline> {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - options.hours * 3600_000);

    const bashEntries = await this.auditRepository.findByTimeRange(
      startTime,
      endTime,
    );

    const auditEntries: AuditEntry[] = [];

    for (const be of bashEntries) {
      const trimmedCommand = be.command.trim();

      // Filter by session if requested — entries without sessionId are excluded
      if (options.sessionId) {
        if (!be.sessionId || be.sessionId !== options.sessionId) {
          continue;
        }
      }

      const isSwampCommand = trimmedCommand.startsWith("swamp ") ||
        trimmedCommand === "swamp";

      const failure = be.error
        ? { exitCode: be.exitCode, error: be.error }
        : undefined;

      if (isSwampCommand) {
        auditEntries.push(
          createSwampAuditEntry(
            be.timestamp,
            trimmedCommand,
            failure ? "error" : "success",
          ),
        );
        continue;
      }

      // Filter noise commands unless --all
      if (!options.showAll && isNoiseCommand(trimmedCommand)) {
        continue;
      }

      auditEntries.push(
        createDirectAuditEntry(
          be.timestamp,
          trimmedCommand,
          be.sessionId,
          failure,
        ),
      );
    }

    // Sort by timestamp ascending
    auditEntries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return {
      entries: auditEntries,
      totalSwamp: auditEntries.filter((e) => e.source === "swamp").length,
      totalDirect: auditEntries.filter((e) => e.source === "direct").length,
      hoursAnalyzed: options.hours,
    };
  }

  /**
   * Cleans up old audit data. Fire-and-forget.
   */
  cleanupOldAuditData(
    retentionDays: number = DEFAULT_RETENTION_DAYS,
  ): void {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    this.auditRepository.deleteOlderThan(cutoffDate).catch((error) => {
      if (Deno.env.get("SWAMP_DEBUG")) {
        console.error("[Audit] Cleanup failed:", error);
      }
    });
  }
}

/**
 * Checks if a command matches the noise filter.
 * A command is noise if it starts with any of the known noise prefixes,
 * followed by a space, pipe, semicolon, or end of string.
 */
export function isNoiseCommand(command: string): boolean {
  for (const prefix of NOISE_COMMAND_PREFIXES) {
    if (command === prefix) return true;
    if (
      command.startsWith(prefix) &&
      (command[prefix.length] === " " ||
        command[prefix.length] === "|" ||
        command[prefix.length] === ";")
    ) {
      return true;
    }
  }
  return false;
}
