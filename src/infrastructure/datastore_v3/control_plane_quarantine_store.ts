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
 * Serve's quarantined changes in its shared control plane (swamp-club#4195).
 * See {@link QuarantineStore} and the layout in `quarantine.ts`.
 *
 * @module
 */

import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import {
  MAX_QUARANTINED,
  parseQuarantineContent,
  parseQuarantineRecord,
  parseQuarantineRecordKey,
  principalKeyOf,
  QUARANTINE_ACCEPTED_PREFIX,
  QUARANTINE_DISCARDED_PREFIX,
  QUARANTINE_HELD_PREFIX,
  type QuarantineContent,
  quarantineContentKey,
  type QuarantineRecord,
  quarantineRecordKey,
  type QuarantineStore,
  serializeQuarantineContent,
  serializeQuarantineRecord,
} from "../../domain/datastore_v3/quarantine.ts";
import { getSwampLogger } from "../logging/logger.ts";

const logger = getSwampLogger(["serve", "datastore-quarantine"]);

/** A {@link QuarantineStore} over serve's control-plane store. */
export class ControlPlaneQuarantineStore implements QuarantineStore {
  readonly #store: ControlPlaneStore;

  constructor(store: ControlPlaneStore) {
    this.#store = store;
  }

  async heldKeys(): Promise<string[]> {
    return await this.#store.list(QUARANTINE_HELD_PREFIX);
  }

  async heldBytesOf(principalKey: string): Promise<number> {
    let bytes = 0;
    for (const key of await this.heldKeys()) {
      if (parseQuarantineRecordKey(key)?.principalKey !== principalKey) {
        continue;
      }
      bytes += (await this.#read(key))?.bytes ?? 0;
    }
    return bytes;
  }

  async find(txnId: string): Promise<QuarantineRecord | undefined> {
    // An accepted or discarded record wins: a crash after it was written
    // leaves the held one behind until the accept or discard is repeated.
    for (
      const prefix of [
        QUARANTINE_ACCEPTED_PREFIX,
        QUARANTINE_DISCARDED_PREFIX,
        QUARANTINE_HELD_PREFIX,
      ]
    ) {
      for (const key of await this.#store.list(`${prefix}${txnId}/`)) {
        const record = await this.#read(key);
        if (record !== undefined && record.txnId === txnId) return record;
      }
    }
    return undefined;
  }

  async content(txnId: string): Promise<QuarantineContent | undefined> {
    const bytes = await this.#store.get(quarantineContentKey(txnId));
    return bytes === null ? undefined : await parseQuarantineContent(bytes);
  }

  async deposit(
    record: QuarantineRecord,
    content: QuarantineContent,
  ): Promise<void> {
    await this.#store.put(
      quarantineContentKey(record.txnId),
      serializeQuarantineContent(content),
    );
    await this.#store.put(
      quarantineRecordKey(
        "held",
        record.txnId,
        await principalKeyOf(record.principal),
      ),
      serializeQuarantineRecord(record),
    );
  }

  async markAccepted(accepted: QuarantineRecord): Promise<void> {
    const principalKey = await principalKeyOf(accepted.principal);
    await this.#store.put(
      quarantineRecordKey("accepted", accepted.txnId, principalKey),
      serializeQuarantineRecord({ ...accepted, state: "accepted" }),
    );
    await this.#store.delete(
      quarantineRecordKey("held", accepted.txnId, principalKey),
    );
    await this.#store.delete(quarantineContentKey(accepted.txnId));
  }

  async markDiscarded(discarded: QuarantineRecord): Promise<void> {
    const principalKey = await principalKeyOf(discarded.principal);
    await this.#store.put(
      quarantineRecordKey("discarded", discarded.txnId, principalKey),
      serializeQuarantineRecord({ ...discarded, state: "discarded" }),
    );
    await this.#store.delete(
      quarantineRecordKey("held", discarded.txnId, principalKey),
    );
    await this.#store.delete(quarantineContentKey(discarded.txnId));
  }

  async list(maxAccepted: number): Promise<{
    readonly records: readonly QuarantineRecord[];
    readonly truncated: boolean;
  }> {
    // Accepted and discarded records are kept: at most MAX_QUARANTINED of
    // them are read for a listing, so it stays bounded however many there
    // are.
    const acceptedKeys = [
      ...await this.#store.list(QUARANTINE_ACCEPTED_PREFIX),
      ...await this.#store.list(QUARANTINE_DISCARDED_PREFIX),
    ];
    const accepted: QuarantineRecord[] = [];
    for (const key of acceptedKeys.slice(0, MAX_QUARANTINED)) {
      const record = await this.#read(key);
      if (record !== undefined) accepted.push(record);
    }
    accepted.sort((a, b) =>
      (b.acceptedAt ?? b.discardedAt ?? "").localeCompare(
        a.acceptedAt ?? a.discardedAt ?? "",
      )
    );
    const acceptedIds = new Set(accepted.map((record) => record.txnId));
    const held: QuarantineRecord[] = [];
    for (const key of await this.heldKeys()) {
      const parsed = parseQuarantineRecordKey(key);
      if (parsed === undefined || acceptedIds.has(parsed.txnId)) continue;
      const record = await this.#read(key);
      if (record !== undefined) held.push(record);
    }
    held.sort((a, b) => a.depositedAt.localeCompare(b.depositedAt));
    return {
      records: [...held, ...accepted.slice(0, maxAccepted)],
      truncated: acceptedKeys.length > Math.min(maxAccepted, accepted.length),
    };
  }

  /** The record at `key`; undefined, and logged, when it cannot be read. */
  async #read(key: string): Promise<QuarantineRecord | undefined> {
    if (parseQuarantineRecordKey(key) === undefined) return undefined;
    const bytes = await this.#store.get(key);
    if (bytes === null) return undefined;
    try {
      return parseQuarantineRecord(bytes);
    } catch (error) {
      logger.warn`Skipped an unreadable quarantine record ${key}: ${error}`;
      return undefined;
    }
  }
}
