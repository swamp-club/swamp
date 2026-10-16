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

const logger = getLogger(["swamp", "audit"]);

/** Default retention period in days for audit data */
export const DEFAULT_AUDIT_RETENTION_DAYS = 7;

const MS_PER_DAY = 86_400_000;

/**
 * Converts a retention in milliseconds to whole days, rounding up: audit
 * files are named by day, so a partial day keeps that day's file.
 */
export function retentionMsToWholeDays(retentionMs: number): number {
  return Math.ceil(retentionMs / MS_PER_DAY);
}

/**
 * The number of days audit data is kept: the repo's audit retention
 * (`garbageCollection.audit`, else `garbageCollection.retention`) rounded
 * up to whole days, or {@link DEFAULT_AUDIT_RETENTION_DAYS} when unset.
 */
export function auditRetentionDays(retentionMs: number | undefined): number {
  return retentionMs === undefined
    ? DEFAULT_AUDIT_RETENTION_DAYS
    : retentionMsToWholeDays(retentionMs);
}

/**
 * The retention in days for a serve audit store: the store's own
 * `retention.days` from serve.yaml when set, else the repo's audit retention
 * rounded up to whole days, else undefined (the store is never pruned).
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
  /**
   * When true, include rows written by `swamp doctor audit`'s smoke-test
   * check. Default false — those rows are reserved diagnostic output and
   * would otherwise pollute the user's timeline.
   */
  includeDiagnostic?: boolean;
}

/**
 * Reserved command prefix for rows written by the doctor smoke-test.
 * Kept in audit_service because it's filtered here; the corresponding
 * payload in `doctor/synthetic_payloads.ts` imports it to guarantee the
 * writer and reader agree on the sentinel.
 */
export const DIAGNOSTIC_COMMAND_PREFIX = "echo swamp-doctor-smoke-test";

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

      // Filter doctor smoke-test rows unless opted-in
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
   * Deletes audit data older than `retentionDays`. Never rejects: a failed
   * cleanup is only logged.
   */
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
