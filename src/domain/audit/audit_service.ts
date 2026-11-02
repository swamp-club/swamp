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

import { getLogger } from "@logtape/logtape";
import type { AuditRepository } from "./audit_repository.ts";
import {
  type AuditEntry,
  createDirectAuditEntry,
  createSwampAuditEntry,
} from "./audit_entry.ts";

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

const logger = getLogger(["swamp", "audit"]);

export const DEFAULT_AUDIT_RETENTION_DAYS = 7;

const MS_PER_DAY = 86_400_000;

/**
 * rounds up to whole days: audit files are named by day, so a partial day keeps
 * that day's file
 */
export function retentionMsToWholeDays(retentionMs: number): number {
  return Math.ceil(retentionMs / MS_PER_DAY);
}

export function auditRetentionDays(retentionMs: number | undefined): number {
  return retentionMs === undefined
    ? DEFAULT_AUDIT_RETENTION_DAYS
    : retentionMsToWholeDays(retentionMs);
}

/**
 * the store's own retention.days when set, else the repo's audit retention
 * rounded up to whole days, else undefined (never pruned)
 */
export function resolveAuditStoreRetentionDays(
  explicitDays: number | undefined,
  repoRetentionMs: number | undefined,
): number | undefined {
  if (explicitDays) return explicitDays;
  return repoRetentionMs === undefined
    ? undefined
    : retentionMsToWholeDays(repoRetentionMs);
}

export interface AuditTimeline {
  entries: AuditEntry[];
  totalSwamp: number;
  totalDirect: number;
  hoursAnalyzed: number;
}

export interface AuditTimelineOptions {
  hours: number;
  showAll: boolean;
  sessionId?: string;
  /**
   * doctor smoke-test rows are reserved diagnostic output and would pollute the
   * timeline, so they are excluded unless this is true
   */
  includeDiagnostic?: boolean;
}

/**
 * kept here because it is filtered here; the doctor payload imports it so
 * writer and reader agree on the sentinel
 */
export const DIAGNOSTIC_COMMAND_PREFIX = "echo swamp-doctor-smoke-test";

export class AuditService {
  constructor(
    private readonly auditRepository: AuditRepository,
  ) {}

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

      if (
        !options.includeDiagnostic &&
        trimmedCommand.startsWith(DIAGNOSTIC_COMMAND_PREFIX)
      ) {
        continue;
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

    auditEntries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return {
      entries: auditEntries,
      totalSwamp: auditEntries.filter((e) => e.source === "swamp").length,
      totalDirect: auditEntries.filter((e) => e.source === "direct").length,
      hoursAnalyzed: options.hours,
    };
  }

  /** never rejects: a failed cleanup is only logged */
  async cleanupOldAuditData(
    retentionDays: number = DEFAULT_AUDIT_RETENTION_DAYS,
  ): Promise<void> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    try {
      await this.auditRepository.deleteOlderThan(cutoffDate);
    } catch (error) {
      logger.debug`Audit cleanup failed: ${error}`;
    }
  }
}

/**
 * a command is noise if it starts with a known prefix followed by a space,
 * pipe, semicolon or end of string
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
