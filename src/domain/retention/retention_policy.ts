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

import { parseDataDuration } from "../data/duration.ts";

export const RETENTION_KINDS = [
  "workflowRuns",
  "evaluatedSnapshots",
  "outputs",
  "data",
  "audit",
  "bookkeeping",
  "autoDefinitions",
] as const;

export type RetentionKind = typeof RETENTION_KINDS[number];

export interface RetentionConfig {
  /**
   * Default timeframe for every kind without its own value, except `data`,
   * `bookkeeping` and `autoDefinitions`, which must be set on their own.
   */
  retention?: string;
  automatic?: boolean;
  workflowRuns?: string;
  evaluatedSnapshots?: string;
  outputs?: string;
  data?: string;
  audit?: string;
  bookkeeping?: string;
  autoDefinitions?: string;
}

export const RETENTION_CONFIG_KEYS: readonly string[] = [
  "retention",
  "automatic",
  ...RETENTION_KINDS,
];

export interface RetentionConfigProblem {
  field?: string;
  message: string;
  replacement?: string;
}

/**
 * capped so now - retention is always a valid Date; a longer value would give
 * an invalid date that fails every age check
 */
export const MAX_RETENTION_MS = 1000 * 365 * 24 * 60 * 60 * 1000;

const LEGACY_KEYS: readonly string[] = ["workflowRuns", "outputs"];

/**
 * errors refuse the file; ignored keys are dropped with a warning; unknownKeys
 * are warned about and ignored
 */
export function checkRetentionConfig(
  raw: unknown,
): {
  errors: RetentionConfigProblem[];
  ignored: RetentionConfigProblem[];
  unknownKeys: string[];
} {
  if (raw === undefined) return { errors: [], ignored: [], unknownKeys: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      errors: [{ message: "garbageCollection must be a mapping" }],
      ignored: [],
      unknownKeys: [],
    };
  }
  const config = raw as Record<string, unknown>;
  const errors: RetentionConfigProblem[] = [];
  const ignored: RetentionConfigProblem[] = [];
  const unknownKeys = Object.keys(config).filter((key) =>
    !RETENTION_CONFIG_KEYS.includes(key)
  );
  const problem = (legacy: boolean, entry: RetentionConfigProblem) =>
    (legacy ? errors : ignored).push(entry);

  for (const field of ["retention", ...RETENTION_KINDS] as const) {
    const value = config[field];
    if (value === undefined) continue;
    const legacy = LEGACY_KEYS.includes(field);
    if (typeof value !== "string") {
      problem(legacy, {
        field,
        message: `garbageCollection.${field} must be a duration string`,
      });
      continue;
    }
    let ms: number | undefined;
    try {
      ms = parseDataDuration(value);
    } catch {
      ms = undefined;
    }
    if (ms === undefined || ms <= 0) {
      problem(legacy, {
        field,
        message:
          `garbageCollection.${field} must be a positive duration like 1h, 7d, or 2w`,
      });
    } else if (ms > MAX_RETENTION_MS) {
      // too long for a date means forever, so hold it at the longest retention;
      // dropping it would fall back to a shorter default
      ignored.push({
        field,
        message:
          `garbageCollection.${field} is longer than 1000y; using 1000y (leave it unset to keep forever)`,
        replacement: "1000y",
      });
    }
  }

  if (config.automatic !== undefined && typeof config.automatic !== "boolean") {
    ignored.push({
      field: "automatic",
      message: "garbageCollection.automatic must be true or false",
    });
  }

  // Only an explicit evaluatedSnapshots can be longer than the runs: an
  // unset one follows the run retention.
  const valid = withoutIgnored(config as RetentionConfig, ignored);
  if (errors.length === 0 && valid.evaluatedSnapshots !== undefined) {
    const snapshots = parseDataDuration(valid.evaluatedSnapshots);
    const runsDuration = valid.workflowRuns ?? valid.retention;
    const runs = runsDuration === undefined
      ? undefined
      : parseDataDuration(runsDuration);
    if (
      snapshots !== undefined && runs !== undefined && snapshots > runs
    ) {
      ignored.push({
        field: "evaluatedSnapshots",
        message:
          "garbageCollection.evaluatedSnapshots must not be longer than workflowRuns: a snapshot is removed with its run",
      });
    }
  }

  return { errors, ignored, unknownKeys };
}

export function withoutIgnored(
  config: RetentionConfig,
  ignored: readonly RetentionConfigProblem[],
): RetentionConfig {
  const result: Record<string, unknown> = { ...config };
  for (const entry of ignored) {
    if (entry.field === undefined) continue;
    if (entry.replacement !== undefined) {
      result[entry.field] = entry.replacement;
    } else {
      delete result[entry.field];
    }
  }
  return result as RetentionConfig;
}

/**
 * precedence: one-off override, then the kind's own key, then retention; a kind
 * with none has no retention and manual commands use their own defaults
 */
export class RetentionPolicy {
  private constructor(private readonly config: RetentionConfig) {}

  /**
   * ignored values are dropped here, never in the file: a command that rewrites
   * .swamp.yaml must save the user's block as written
   */
  static fromConfig(config: RetentionConfig | undefined): RetentionPolicy {
    if (config === undefined) return new RetentionPolicy({});
    const { errors, ignored } = checkRetentionConfig(config);
    return new RetentionPolicy(
      withoutIgnored(config, [...errors, ...ignored]),
    );
  }

  get automatic(): boolean {
    return this.config.automatic === true;
  }

  durationFor(kind: RetentionKind): string | undefined {
    // Data retention deletes latest versions, a behavior's current state
    // included: it applies only when `data` is set, never from the shared
    // default.
    if (kind === "data") return this.config.data;
    // Bookkeeping retention is serve's worker GC grace: a shared default
    // meant for history must not prune a worker that is merely offline.
    if (kind === "bookkeeping") return this.config.bookkeeping;
    // Removing an auto-definition discards its edited global arguments, so it
    // is never implied by a default meant for history.
    if (kind === "autoDefinitions") return this.config.autoDefinitions;
    if (kind === "evaluatedSnapshots") {
      return this.config.evaluatedSnapshots ??
        this.durationFor("workflowRuns");
    }
    return this.config[kind] ?? this.config.retention;
  }

  isExplicit(kind: RetentionKind): boolean {
    return this.config[kind] !== undefined;
  }

  retentionMs(kind: RetentionKind, overrideMs?: number): number | undefined {
    if (overrideMs !== undefined) return overrideMs;
    const duration = this.durationFor(kind);
    return duration === undefined ? undefined : parseDataDuration(duration);
  }

  cutoff(
    kind: RetentionKind,
    now: Date,
    overrideMs?: number,
  ): Date | undefined {
    const ms = this.retentionMs(kind, overrideMs);
    if (ms === undefined) return undefined;
    // A cutoff no Date can hold means nothing can be that old.
    const cutoff = new Date(now.getTime() - ms);
    return Number.isFinite(cutoff.getTime()) ? cutoff : undefined;
  }

  get hasAnyRetention(): boolean {
    return RETENTION_KINDS.some((kind) => this.durationFor(kind) !== undefined);
  }
}
