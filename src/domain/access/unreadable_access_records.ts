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

/**
 * Grant and group records that exist but cannot be loaded: why, and how to
 * fix each (swamp-club#3386). Shared by the policy snapshot loader and the
 * boot reconcilers that read every stored grant.
 */

import { UserError } from "../errors.ts";
import type { UnreadableModelRecord } from "../data/repositories.ts";
import type { ModelType } from "../models/model_type.ts";

/**
 * What a snapshot did with a grant or group record it could not read: kept
 * the deny or the group members an earlier build read, or left it out.
 */
export type UnreadableRecordOutcome =
  | "kept-last-known-deny"
  | "kept-last-known-members"
  | "left-out";

/**
 * A grant or group record that exists but could not be read or parsed by
 * the last build (swamp-club#3386).
 */
export interface UnreadableAccessRecord {
  /** `<model type>/<model id>`. */
  readonly record: string;
  readonly kind: "grant" | "group";
  readonly modelId: string;
  /** The access data the record keeps: `grant-main` or `group-main`. */
  readonly dataName: string;
  /**
   * `corrupt` when its JSON or metadata does not parse; `unrecognised` when
   * it parses but fails this build's grant, group or metadata validation,
   * as a record a newer swamp wrote may; neither loads again by itself.
   * `unreadable` when reading it failed (a file this process may not read,
   * a remote read that failed, content gone missing), which a retry can fix.
   */
  readonly cause: "unreadable" | "corrupt" | "unrecognised";
  /**
   * Whether it has no definition (an `@`-prefixed type), so
   * `swamp data delete` cannot reach it.
   */
  readonly orphaned: boolean;
  /** The error's class, which names the failure across retries. */
  readonly errorName: string;
  /** The error's class and message, for logs. */
  readonly error: string;
  readonly outcome: UnreadableRecordOutcome;
}

/** What a record a build could not load is, for messages. */
export function problemOf(record: UnreadableAccessRecord): string {
  switch (record.cause) {
    case "corrupt":
      return "is corrupt";
    case "unrecognised":
      return "is not valid for this swamp";
    case "unreadable":
      return "cannot be read";
  }
}

/** How to fix a record a build could not load. */
export function remedyFor(record: UnreadableAccessRecord): string {
  switch (record.cause) {
    case "corrupt":
      return `${
        removalFor(record)
      }, then create the ${record.kind} again if it is still wanted`;
    case "unrecognised":
      return `if a newer swamp wrote it, upgrade this one; otherwise it is corrupt: ${
        removalFor(record)
      }, then create the ${record.kind} again if it is still wanted`;
    case "unreadable":
      return "give this process read access to it (check the owner and mode of its files), then retry";
  }
}

/**
 * How to remove a record's access data: `swamp data delete`, or, for an
 * orphaned record it cannot reach, its directory.
 */
function removalFor(record: UnreadableAccessRecord): string {
  return record.orphaned
    ? `remove its directory, data/${record.record}, from the datastore (it has no definition, so \`swamp data delete\` cannot reach it)`
    : `remove it with \`swamp data delete ${record.modelId} ${record.dataName} -y\``;
}

/**
 * Grant or group records could not be loaded where nothing earlier can stand
 * in for them: a loader's first build, or a boot reconciler. Before any
 * build has succeeded there is no last-known version to fall back on, so a
 * deny among them would go unenforced; the build fails closed instead, as
 * serve's boot load and the one-shot access commands always have for a
 * content file they could not read.
 */
export class UnreadableAccessRecordsError extends UserError {
  readonly records: readonly UnreadableAccessRecord[];

  constructor(records: readonly UnreadableAccessRecord[]) {
    super(
      `Cannot load the access policy: ${records.length} grant or group record(s) cannot be loaded. A record that cannot be loaded may be a deny, which would go unenforced, so the policy is not loaded until each is fixed:\n${
        records.map((r) =>
          `  - ${r.record} ${problemOf(r)} (${r.error}): ${remedyFor(r)}`
        ).join("\n")
      }`,
      "access_records_unloadable",
    );
    this.name = "UnreadableAccessRecordsError";
    this.records = records;
  }

  /**
   * The error for the records a reader of every stored grant or group could
   * not load, such as serve's boot reconcilers of file and admin grants,
   * which run before the first snapshot is built.
   */
  static forFailures(
    kind: "grant" | "group",
    failures: readonly FailedRecord[],
  ): UnreadableAccessRecordsError {
    return new UnreadableAccessRecordsError(
      failures.map((failure) => unreadableRecord(kind, failure, "left-out")),
    );
  }
}

/** A record a build could not load, before its outcome is decided. */
export interface FailedRecord {
  modelType: ModelType;
  modelId: string;
  error: unknown;
  cause: UnreadableAccessRecord["cause"];
}

/**
 * The skipped records that fail a grant or group: the model as a whole, or
 * its access data. Other data the model keeps (method-summary reports) is
 * not access data, so one that fails neither fails the record nor is named
 * in its fix (swamp-club#3386).
 */
export function failedAccessData(
  skipped: readonly UnreadableModelRecord[],
  accessDataName: string,
): FailedRecord[] {
  return skipped
    .filter(({ dataName }) =>
      dataName === undefined || dataName === accessDataName
    )
    .map(({ modelType, modelId, error }) => ({
      modelType,
      modelId,
      error,
      cause: causeOfSkippedModel(error),
    }));
}

/**
 * Why the repository skipped a model directory. A filesystem error (any
 * `Deno.errors` class, such as PermissionDenied) is a failed read, which a
 * retry can fix; a parse failure (SyntaxError) is corrupt; any other error
 * comes from validating its metadata, which a newer swamp may have written.
 */
export function causeOfSkippedModel(
  error: unknown,
): UnreadableAccessRecord["cause"] {
  if (
    Object.values(Deno.errors).some((errorClass) => error instanceof errorClass)
  ) {
    return "unreadable";
  }
  return error instanceof SyntaxError ? "corrupt" : "unrecognised";
}

/** The record a build could not load, with what the snapshot did with it. */
export function unreadableRecord(
  kind: "grant" | "group",
  { modelType, modelId, error, cause }: FailedRecord,
  outcome: UnreadableRecordOutcome,
): UnreadableAccessRecord {
  const errorName = error instanceof Error ? error.name : "Error";
  return {
    record: recordKey(modelType, modelId),
    kind,
    modelId,
    dataName: `${kind}-main`,
    cause,
    orphaned: modelType.normalized.startsWith("@"),
    errorName,
    error: describeError(error),
    outcome,
  };
}

/** The most validation issues a description names before counting the rest. */
const DESCRIBED_ISSUES = 3;

/**
 * An error's class and message on one line. A validation error's message is
 * a JSON dump of every issue, so it is described by its first issues as
 * `path: message` instead.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return `${error.name}: ${error.message}`;
  }
  const named = issues.slice(0, DESCRIBED_ISSUES).map((issue) => {
    const { path, message } = issue as { path?: unknown; message?: unknown };
    const at = Array.isArray(path) && path.length > 0
      ? path.join(".")
      : "(root)";
    return `${at}: ${String(message)}`;
  });
  const more = issues.length > DESCRIBED_ISSUES
    ? `; and ${issues.length - DESCRIBED_ISSUES} more`
    : "";
  return `${error.name}: ${named.join("; ")}${more}`;
}

export function recordKey(modelType: ModelType, modelId: string): string {
  return `${modelType.normalized}/${modelId}`;
}
