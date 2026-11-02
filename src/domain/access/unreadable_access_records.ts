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

import { UserError } from "../errors.ts";
import type { UnreadableModelRecord } from "../data/repositories.ts";
import type { ModelType } from "../models/model_type.ts";

export type UnreadableRecordOutcome =
  | "kept-last-known-deny"
  | "kept-last-known-members"
  | "left-out";

export interface UnreadableAccessRecord {
  readonly record: string;
  readonly kind: "grant" | "group";
  readonly modelId: string;
  readonly dataName: string;
  /**
   * corrupt: JSON or metadata does not parse; unrecognised: fails this build's
   * validation, as a newer swamp's record may; neither self-heals. unreadable:
   * the read failed, which a retry can fix
   */
  readonly cause: "unreadable" | "corrupt" | "unrecognised";
  /**
   * true when it has no definition (an @-prefixed type), so swamp data delete
   * cannot reach it
   */
  readonly orphaned: boolean;
  readonly errorName: string;
  readonly error: string;
  readonly outcome: UnreadableRecordOutcome;
}

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

function removalFor(record: UnreadableAccessRecord): string {
  return record.orphaned
    ? `remove its directory, data/${record.record}, from the datastore (it has no definition, so \`swamp data delete\` cannot reach it)`
    : `remove it with \`swamp data delete ${record.modelId} ${record.dataName} -y\``;
}

/**
 * where nothing earlier can stand in (a first build or boot reconciler) a deny
 * among them would go unenforced, so the build fails closed
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

  static forFailures(
    kind: "grant" | "group",
    failures: readonly FailedRecord[],
  ): UnreadableAccessRecordsError {
    return new UnreadableAccessRecordsError(
      failures.map((failure) => unreadableRecord(kind, failure, "left-out")),
    );
  }
}

export interface FailedRecord {
  modelType: ModelType;
  modelId: string;
  error: unknown;
  cause: UnreadableAccessRecord["cause"];
}

/**
 * other data a grant model keeps, such as method-summary reports, is not access
 * data, so one that fails neither fails the record nor is named in its fix
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
 * a filesystem error is a failed read a retry can fix; a SyntaxError is
 * corrupt; any other error comes from validating metadata a newer swamp may
 * have written
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

const DESCRIBED_ISSUES = 3;

/**
 * a validation error's message is a JSON dump of every issue, so it is
 * described by its first issues as path: message
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
