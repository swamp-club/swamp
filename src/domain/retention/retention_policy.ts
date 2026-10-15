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

/**
 * The kinds of history retention applies to, each with its own key in the
 * `.swamp.yaml` `garbageCollection` block (swamp-club#3473).
 */
export const RETENTION_KINDS = [
  "workflowRuns",
  "evaluatedSnapshots",
  "outputs",
  "data",
  "audit",
  "bookkeeping",
] as const;

export type RetentionKind = typeof RETENTION_KINDS[number];

/** The `.swamp.yaml` `garbageCollection` block. */
export interface RetentionConfig {
  /** Default timeframe for every kind without its own value. */
  retention?: string;
  /** Apply retention automatically (serve timer, CLI end of command). */
  automatic?: boolean;
  workflowRuns?: string;
  evaluatedSnapshots?: string;
  outputs?: string;
  data?: string;
  audit?: string;
  bookkeeping?: string;
}

/** Every key the block accepts; anything else is warned about and ignored. */
export const RETENTION_CONFIG_KEYS: readonly string[] = [
  "retention",
  "automatic",
  ...RETENTION_KINDS,
];

/**
 * A problem with a `garbageCollection` block. `field` is the key path under
 * the block (e.g. `workflowRuns`), or undefined for the block itself.
 */
export interface RetentionConfigProblem {
  field?: string;
  message: string;
}

function isPositiveDuration(value: string): boolean {
  try {
    return parseDataDuration(value) > 0;
  } catch {
    return false;
  }
}

/**
 * Checks a raw `garbageCollection` value. Returns the errors that must
 * refuse the file and the unknown keys, which are only warned about: they
 * were silently ignored before swamp-club#3473, so refusing them now would
 * break repos that already carry one.
 */
export function checkRetentionConfig(
  raw: unknown,
): { errors: RetentionConfigProblem[]; unknownKeys: string[] } {
  if (raw === undefined) return { errors: [], unknownKeys: [] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      errors: [{ message: "garbageCollection must be a mapping" }],
      unknownKeys: [],
    };
  }
  const config = raw as Record<string, unknown>;
  const errors: RetentionConfigProblem[] = [];
  const unknownKeys = Object.keys(config).filter((key) =>
    !RETENTION_CONFIG_KEYS.includes(key)
  );

  for (const field of ["retention", ...RETENTION_KINDS] as const) {
    const value = config[field];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      errors.push({
        field,
        message: `garbageCollection.${field} must be a duration string`,
      });
      continue;
    }
    if (!isPositiveDuration(value)) {
      errors.push({
        field,
        message:
          `garbageCollection.${field} must be a positive duration like 1h, 7d, or 2w`,
      });
    }
  }

  if (config.automatic !== undefined && typeof config.automatic !== "boolean") {
    errors.push({
      field: "automatic",
      message: "garbageCollection.automatic must be true or false",
    });
  }

  // Only an explicit evaluatedSnapshots can be longer than the runs: an
  // unset one follows the run retention.
  if (errors.length === 0 && config.evaluatedSnapshots !== undefined) {
    const policy = RetentionPolicy.fromConfig(config as RetentionConfig);
    const snapshots = policy.retentionMs("evaluatedSnapshots");
    const runs = policy.retentionMs("workflowRuns");
    if (
      snapshots !== undefined && runs !== undefined && snapshots > runs
    ) {
      errors.push({
        field: "evaluatedSnapshots",
        message:
          "garbageCollection.evaluatedSnapshots must not be longer than workflowRuns: a snapshot is removed with its run",
      });
    }
  }

  return { errors, unknownKeys };
}

/**
 * Resolves how long each kind of history is kept. Precedence for a kind:
 * a one-off override (e.g. `--older-than`), then the kind's own key, then
 * `retention`. A kind with none of these has no retention: automatic
 * retention leaves it alone, and the manual commands fall back to their
 * own built-in defaults.
 */
export class RetentionPolicy {
  private constructor(private readonly config: RetentionConfig) {}

  static fromConfig(config: RetentionConfig | undefined): RetentionPolicy {
    return new RetentionPolicy({ ...(config ?? {}) });
  }

  /** True when retention runs on its own (serve timer, CLI end of command). */
  get automatic(): boolean {
    return this.config.automatic === true;
  }

  /**
   * The configured duration string for a kind, after precedence. Evaluated
   * snapshots without their own value follow the run retention, so they go
   * with their runs (and orphans are swept) whenever runs are reaped.
   */
  durationFor(kind: RetentionKind): string | undefined {
    if (kind === "evaluatedSnapshots") {
      return this.config.evaluatedSnapshots ??
        this.durationFor("workflowRuns");
    }
    return this.config[kind] ?? this.config.retention;
  }

  /** True when the kind has its own key rather than a default it follows. */
  isExplicit(kind: RetentionKind): boolean {
    return this.config[kind] !== undefined;
  }

  /** How long a kind is kept, in milliseconds; undefined when unset. */
  retentionMs(kind: RetentionKind, overrideMs?: number): number | undefined {
    if (overrideMs !== undefined) return overrideMs;
    const duration = this.durationFor(kind);
    return duration === undefined ? undefined : parseDataDuration(duration);
  }

  /**
   * The instant before which items of a kind are reaped; undefined when the
   * kind has no retention.
   */
  cutoff(
    kind: RetentionKind,
    now: Date,
    overrideMs?: number,
  ): Date | undefined {
    const ms = this.retentionMs(kind, overrideMs);
    return ms === undefined ? undefined : new Date(now.getTime() - ms);
  }

  /** True when any kind has a retention. */
  get hasAnyRetention(): boolean {
    return RETENTION_KINDS.some((kind) => this.durationFor(kind) !== undefined);
  }
}
