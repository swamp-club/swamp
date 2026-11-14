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

import { RUN_INITIATOR_MISMATCH_CODE } from "./commit_authorization.ts";
import type { Commit } from "./commit.ts";
import type { OutboxEntry } from "./commit_outbox.ts";

/**
 * Serve refusing a version as live or removed means the flush rebased on a
 * stale copy, not that the write conflicts: the next flush renumbers it.
 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "version-live",
  "version-reused",
]);

// An older swamp rejected without a code, keeping only serve's message.
const RETRYABLE_REASON = /^Data .+ version \d+ (is already live|was removed);/;

export function isRetryableRejection(
  entry: Pick<OutboxEntry, "state" | "stateCode" | "stateReason">,
): boolean {
  if (entry.state !== "rejected") return false;
  if (entry.stateCode !== undefined) {
    return RETRYABLE_CODES.has(entry.stateCode);
  }
  return entry.stateReason !== undefined &&
    RETRYABLE_REASON.test(entry.stateReason);
}

/** one data version, or the whole commit when it records none, a flush refused */
export interface RejectedWrite {
  readonly behavior: string;
  readonly name?: string;
  readonly version?: number;
  readonly txnId: string;
  readonly reason: string;
  readonly code?: string;
  readonly retryable: boolean;
  readonly next: string;
}

export function behaviorOf(partition: Commit["partition"]): string {
  const identity = partition.identity;
  return identity.kind === "model"
    ? `${identity.type}/${identity.id}`
    : partition.toString();
}

export function nextStepForRejected(
  rejection: { readonly code?: string; readonly retryable: boolean },
): string {
  if (rejection.retryable) {
    return "Nothing to do: the next command that reaches serve sends it again, renumbered past what serve holds.";
  }
  if (rejection.code === RUN_INITIATOR_MISMATCH_CODE) {
    return "An older swamp CLI wrote this run record, so it cannot be sent as it is: upgrade swamp and run the work again.";
  }
  return "It conflicts with what serve holds, so it is kept in this checkout's outbox and never sent again: check the data, then run the work again.";
}

export function rejectedWritesOf(
  commit: Commit,
  rejection: { readonly reason: string; readonly code?: string },
): RejectedWrite[] {
  const retryable = isRetryableRejection({
    state: "rejected",
    stateReason: rejection.reason,
    ...(rejection.code === undefined ? {} : { stateCode: rejection.code }),
  });
  const common = {
    behavior: behaviorOf(commit.partition),
    txnId: commit.txnId,
    reason: rejection.reason,
    ...(rejection.code === undefined ? {} : { code: rejection.code }),
    retryable,
    next: nextStepForRejected({
      retryable,
      ...(rejection.code === undefined ? {} : { code: rejection.code }),
    }),
  };
  const writes: RejectedWrite[] = [];
  for (const op of commit.ops) {
    if (op.kind !== "data-version") continue;
    writes.push({
      ...common,
      name: op.metadata.name,
      version: op.metadata.version,
    });
  }
  return writes.length > 0 ? writes : [common];
}
