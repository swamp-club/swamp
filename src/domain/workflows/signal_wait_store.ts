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

import type {
  StoredWaitRecord,
  WaitOutcome,
  WaitRegistration,
} from "./signal_wait_records.ts";
import type { WaitKeyRecords } from "./wait_key_claim.ts";
import type {
  PendingSignalRecords,
  PendingSignalTakenListener,
} from "./pending_signal.ts";

export interface SignalWaitStore extends WaitKeyRecords, PendingSignalRecords {
  /**
   * an existing registration is left as it is, so a backfill and the executor
   * never overwrite each other
   */
  register(registration: WaitRegistration): Promise<void>;

  findRegistration(
    waitId: string,
  ): Promise<StoredWaitRecord<WaitRegistration>>;

  listRegistrations(): Promise<WaitRegistration[]>;

  findOutcome(waitId: string): Promise<StoredWaitRecord<WaitOutcome>>;

  listOutcomes(): Promise<WaitOutcome[]>;

  /**
   * learn whether you won by comparing the returned outcome with your own,
   * never from the create: a create that landed can be reported as lost when
   * its reply is
   */
  settle(outcome: WaitOutcome): Promise<StoredWaitRecord<WaitOutcome>>;

  removeRegistration(waitId: string): Promise<void>;

  removeOutcome(waitId: string): Promise<void>;

  pendingTaken?: PendingSignalTakenListener;
}

export type SignalWaitSupport =
  | {
    readonly supported: true;
    readonly store: SignalWaitStore;
    /**
     * true only when the datastore's own run records are shared by every
     * writer, so a missing run is gone and a status is current; only then may
     * the sweep act on a wait from a run record
     */
    readonly localRunAbsenceIsAuthoritative?: boolean;
    /**
     * a step that asks for more fails when it would open its wait; a wait
     * already open keeps its deadline
     */
    readonly maxTimeoutSeconds?: number;
    /**
     * asked before a workflow with a wait starts, so an unusable store is
     * refused up front instead of failing at its first wait
     */
    readonly ready?: () => Promise<void>;
  }
  | { readonly supported: false; readonly reason: string };

export const SIGNAL_WAITS_NOT_CONFIGURED: SignalWaitSupport = {
  supported: false,
  reason: "no store for wait records was configured",
};

/**
 * receipts are unique, so an accepted match means this caller settled the wait;
 * a timeout or cancel matches by time alone, and nothing depends on which
 * settler won
 */
export function settledBy(
  stored: StoredWaitRecord<WaitOutcome>,
  outcome: WaitOutcome,
): boolean {
  if (stored.kind !== "found" || stored.record.kind !== outcome.kind) {
    return false;
  }
  if (stored.record.kind === "accepted" && outcome.kind === "accepted") {
    return stored.record.receipt.id === outcome.receipt.id;
  }
  return stored.record.settledAt === outcome.settledAt;
}

/**
 * for a run suspended on a datastore that cannot hold wait records: an overdue
 * wait settles as timed out for this caller alone, and nothing can signal one,
 * so it ends by deadline or cancel
 */
export const UNSHARED_SIGNAL_WAITS: SignalWaitStore = {
  register: () => Promise.resolve(),
  findRegistration: () => Promise.resolve({ kind: "absent" }),
  listRegistrations: () => Promise.resolve([]),
  findOutcome: () => Promise.resolve({ kind: "absent" }),
  listOutcomes: () => Promise.resolve([]),
  settle: (outcome) => Promise.resolve({ kind: "found", record: outcome }),
  removeRegistration: () => Promise.resolve(),
  removeOutcome: () => Promise.resolve(),
  highestKeyRecord: () => Promise.resolve({ kind: "none" }),
  createKeyRecord: (record) => Promise.resolve({ kind: "found", record }),
  findKeyRecord: () => Promise.resolve({ kind: "absent" }),
  listKeyRecords: () => Promise.resolve([]),
  removeKeyRecord: () => Promise.resolve(),
  removeKeyRecordsOfWorkflow: () => Promise.resolve(),
  highestPendingRecord: () => Promise.resolve({ kind: "none" }),
  createPendingRecord: (record) => Promise.resolve({ kind: "found", record }),
  findPendingRecord: () => Promise.resolve({ kind: "absent" }),
  listPendingAddresses: () => Promise.resolve([]),
  removePendingRecord: () => Promise.resolve(),
  removePendingRecordsOfWorkflow: () => Promise.resolve(),
};
