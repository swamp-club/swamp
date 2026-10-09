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

import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import {
  decodeWaitOutcome,
  decodeWaitRegistration,
  encodeWaitRecord,
  type StoredWaitRecord,
  WAIT_OUTCOME_PREFIX,
  WAIT_RECORD_MAX_BYTES,
  WAIT_REGISTRATION_PREFIX,
  waitIdFromKey,
  type WaitOutcome,
  waitOutcomeKey,
  type WaitRegistration,
  waitRegistrationKey,
} from "../../domain/workflows/signal_wait_records.ts";
import type { SignalWaitStore } from "../../domain/workflows/signal_wait_store.ts";
import {
  decodeWaitKeyRecord,
  encodeWaitKeyRecord,
  type HighestKeyRecord,
  WAIT_KEY_RECORD_PREFIX,
  type WaitKeyAddress,
  waitKeyAddressFromKey,
  waitKeyPrefix,
  type WaitKeyRecord,
  waitKeyRecordKey,
  waitKeyWorkflowPrefix,
} from "../../domain/workflows/wait_key_claim.ts";

/** A control-plane store that can create a record only if it is absent. */
export type AtomicControlPlaneStore =
  & ControlPlaneStore
  & Required<Pick<ControlPlaneStore, "putIfAbsent">>;

/** True when `store` has the atomic create that wait records need. */
export function isAtomicControlPlaneStore(
  store: ControlPlaneStore,
): store is AtomicControlPlaneStore {
  return typeof store.putIfAbsent === "function";
}

/**
 * How often the highest record of a key is looked for when the one a
 * listing names is gone by the time it is read.
 */
const HIGHEST_KEY_RECORD_READS = 4;

/**
 * {@link SignalWaitStore} over a {@link ControlPlaneStore}: registrations
 * under `waits/`, outcomes under `wait-outcomes/` and key records under
 * `wait-keys/`, each written with `putIfAbsent` so the first writer of a
 * key holds it.
 */
export class ControlPlaneSignalWaitStore implements SignalWaitStore {
  readonly #store: AtomicControlPlaneStore;

  constructor(store: AtomicControlPlaneStore) {
    this.#store = store;
  }

  async register(registration: WaitRegistration): Promise<void> {
    const bytes = encodeWaitRecord(registration);
    if (bytes.byteLength > WAIT_RECORD_MAX_BYTES) {
      throw new Error(
        `Signal wait registration is ${bytes.byteLength} bytes, over the ${WAIT_RECORD_MAX_BYTES} byte limit`,
      );
    }
    await this.#store.putIfAbsent(
      waitRegistrationKey(registration.waitId),
      bytes,
    );
  }

  async findRegistration(
    waitId: string,
  ): Promise<StoredWaitRecord<WaitRegistration>> {
    return decodeWaitRegistration(
      await this.#store.get(waitRegistrationKey(waitId)),
      waitId,
    );
  }

  async listRegistrations(): Promise<WaitRegistration[]> {
    const found: WaitRegistration[] = [];
    for (const waitId of await this.#waitIds(WAIT_REGISTRATION_PREFIX)) {
      const stored = await this.findRegistration(waitId);
      if (stored.kind === "found") found.push(stored.record);
    }
    return found;
  }

  async findOutcome(waitId: string): Promise<StoredWaitRecord<WaitOutcome>> {
    return decodeWaitOutcome(
      await this.#store.get(waitOutcomeKey(waitId)),
      waitId,
    );
  }

  async listOutcomes(): Promise<WaitOutcome[]> {
    const found: WaitOutcome[] = [];
    for (const waitId of await this.#waitIds(WAIT_OUTCOME_PREFIX)) {
      const stored = await this.findOutcome(waitId);
      if (stored.kind === "found") found.push(stored.record);
    }
    return found;
  }

  async settle(outcome: WaitOutcome): Promise<StoredWaitRecord<WaitOutcome>> {
    await this.#store.putIfAbsent(
      waitOutcomeKey(outcome.waitId),
      encodeWaitRecord(outcome),
    );
    // Read back whatever holds the key. The create's own answer is not
    // trusted: a retried create whose first reply was lost reports the key
    // as taken to the writer that took it.
    return await this.findOutcome(outcome.waitId);
  }

  async removeRegistration(waitId: string): Promise<void> {
    await this.#store.delete(waitRegistrationKey(waitId));
  }

  async removeOutcome(waitId: string): Promise<void> {
    await this.#store.delete(waitOutcomeKey(waitId));
  }

  async highestKeyRecord(
    workflowId: string,
    key: string,
  ): Promise<HighestKeyRecord> {
    // The highest generation is read from the key names, so one record is
    // fetched however many runs have claimed the key.
    let generation = 0;
    for (let attempt = 0; attempt < HIGHEST_KEY_RECORD_READS; attempt++) {
      generation = 0;
      for (
        const storeKey of await this.#store.list(
          waitKeyPrefix(workflowId, key),
        )
      ) {
        const at = waitKeyAddressFromKey(storeKey);
        if (at !== undefined && at.generation > generation) {
          generation = at.generation;
        }
      }
      if (generation === 0) return { kind: "none" };
      const stored = await this.#findKeyRecord({
        workflowId,
        key,
        generation,
      });
      if (stored.kind === "found") return stored;
      if (stored.kind === "unreadable") {
        return { kind: "unreadable", generation };
      }
      // Listed and gone again: superseded and removed in between. The
      // next listing shows what superseded it.
    }
    // A listing that keeps naming a record that is not there says nothing
    // true about the key's holder.
    return { kind: "unreadable", generation };
  }

  async createKeyRecord(
    record: WaitKeyRecord,
  ): Promise<StoredWaitRecord<WaitKeyRecord>> {
    await this.#store.putIfAbsent(
      waitKeyRecordKey(record),
      encodeWaitKeyRecord(record),
    );
    // Read back, as `settle` does: the create's own answer is not trusted.
    return await this.#findKeyRecord(record);
  }

  async listKeyRecords(): Promise<WaitKeyRecord[]> {
    const found: WaitKeyRecord[] = [];
    for (const storeKey of await this.#store.list(WAIT_KEY_RECORD_PREFIX)) {
      const at = waitKeyAddressFromKey(storeKey);
      if (at === undefined) continue;
      const stored = await this.#findKeyRecord(at);
      if (stored.kind === "found") found.push(stored.record);
    }
    return found;
  }

  async removeKeyRecord(at: WaitKeyAddress): Promise<void> {
    await this.#store.delete(waitKeyRecordKey(at));
  }

  async removeKeyRecordsOfWorkflow(workflowId: string): Promise<void> {
    const prefix = waitKeyWorkflowPrefix(workflowId);
    for (const storeKey of await this.#store.list(prefix)) {
      await this.#store.delete(storeKey);
    }
  }

  async #findKeyRecord(
    at: WaitKeyAddress,
  ): Promise<StoredWaitRecord<WaitKeyRecord>> {
    return decodeWaitKeyRecord(
      await this.#store.get(waitKeyRecordKey(at)),
      at,
    );
  }

  /** The wait ids under a key family; keys that name no wait are skipped. */
  async #waitIds(prefix: string): Promise<string[]> {
    const ids: string[] = [];
    for (const key of await this.#store.list(prefix)) {
      const waitId = waitIdFromKey(key);
      if (waitId !== undefined) ids.push(waitId);
    }
    return ids;
  }
}
