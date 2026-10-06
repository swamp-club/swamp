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

/**
 * Where the registrations and outcomes of signal waits are kept
 * (swamp-club#3093). Every process on the datastore reads and writes the
 * same records, without the run claim and without the run record.
 */
export interface SignalWaitStore {
  /**
   * Records a wait. A registration that already exists is left as it is, so
   * a backfill and the executor never overwrite each other.
   */
  register(registration: WaitRegistration): Promise<void>;

  findRegistration(
    waitId: string,
  ): Promise<StoredWaitRecord<WaitRegistration>>;

  /** Every registration that can be read. */
  listRegistrations(): Promise<WaitRegistration[]>;

  findOutcome(waitId: string): Promise<StoredWaitRecord<WaitOutcome>>;

  /** Every outcome that can be read. */
  listOutcomes(): Promise<WaitOutcome[]>;

  /**
   * Settles a wait with `outcome` unless it is settled already, and returns
   * the outcome that is stored. The caller learns whether it won by
   * comparing that outcome with its own, never from the create itself: a
   * create that landed can be reported as lost when its reply is.
   */
  settle(outcome: WaitOutcome): Promise<StoredWaitRecord<WaitOutcome>>;

  removeRegistration(waitId: string): Promise<void>;

  removeOutcome(waitId: string): Promise<void>;
}

/**
 * Whether signal waits can be used on a datastore: with the store that
 * holds their records, or not at all, with the reason to show.
 */
export type SignalWaitSupport =
  | {
    readonly supported: true;
    readonly store: SignalWaitStore;
    /** Missing local runs are absent from the datastore, not merely unsynced. */
    readonly localRunAbsenceIsAuthoritative?: boolean;
  }
  | { readonly supported: false; readonly reason: string };

/** The support of a context that was given no store. */
export const SIGNAL_WAITS_NOT_CONFIGURED: SignalWaitSupport = {
  supported: false,
  reason: "no store for wait records was configured",
};

/** True when `outcome` is the one stored: this caller settled the wait. */
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
