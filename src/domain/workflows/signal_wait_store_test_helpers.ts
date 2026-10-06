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

import {
  decodeWaitOutcome,
  decodeWaitRegistration,
  encodeWaitRecord,
  type StoredWaitRecord,
  type WaitOutcome,
  type WaitRegistration,
} from "./signal_wait_records.ts";
import type {
  SignalWaitStore,
  SignalWaitSupport,
} from "./signal_wait_store.ts";

/**
 * A {@link SignalWaitStore} held in memory, for tests. Records are kept as
 * the bytes a real store holds, so every read is parsed as in production,
 * and `registrations` and `outcomes` can be edited to stage a damaged one.
 */
export class InMemorySignalWaitStore implements SignalWaitStore {
  readonly registrations = new Map<string, Uint8Array>();
  readonly outcomes = new Map<string, Uint8Array>();

  register(registration: WaitRegistration): Promise<void> {
    if (!this.registrations.has(registration.waitId)) {
      this.registrations.set(
        registration.waitId,
        encodeWaitRecord(registration),
      );
    }
    return Promise.resolve();
  }

  findRegistration(
    waitId: string,
  ): Promise<StoredWaitRecord<WaitRegistration>> {
    return Promise.resolve(
      decodeWaitRegistration(this.registrations.get(waitId) ?? null, waitId),
    );
  }

  async listRegistrations(): Promise<WaitRegistration[]> {
    const found: WaitRegistration[] = [];
    for (const waitId of [...this.registrations.keys()]) {
      const stored = await this.findRegistration(waitId);
      if (stored.kind === "found") found.push(stored.record);
    }
    return found;
  }

  findOutcome(waitId: string): Promise<StoredWaitRecord<WaitOutcome>> {
    return Promise.resolve(
      decodeWaitOutcome(this.outcomes.get(waitId) ?? null, waitId),
    );
  }

  async listOutcomes(): Promise<WaitOutcome[]> {
    const found: WaitOutcome[] = [];
    for (const waitId of [...this.outcomes.keys()]) {
      const stored = await this.findOutcome(waitId);
      if (stored.kind === "found") found.push(stored.record);
    }
    return found;
  }

  settle(outcome: WaitOutcome): Promise<StoredWaitRecord<WaitOutcome>> {
    if (!this.outcomes.has(outcome.waitId)) {
      this.outcomes.set(outcome.waitId, encodeWaitRecord(outcome));
    }
    return this.findOutcome(outcome.waitId);
  }

  removeRegistration(waitId: string): Promise<void> {
    this.registrations.delete(waitId);
    return Promise.resolve();
  }

  removeOutcome(waitId: string): Promise<void> {
    this.outcomes.delete(waitId);
    return Promise.resolve();
  }
}

/** Wait support backed by a fresh {@link InMemorySignalWaitStore}. */
export function inMemorySignalWaits(): {
  supported: true;
  store: InMemorySignalWaitStore;
} & SignalWaitSupport {
  return { supported: true, store: new InMemorySignalWaitStore() };
}

/** The outcome a signal accepted at `at` leaves for `wait`, for tests. */
export function acceptedOutcomeFor(
  wait: { id: string; deadline: Date },
  payload: Record<string, unknown>,
  options: { at?: Date; submittedBy?: string; runId?: string } = {},
): Extract<WaitOutcome, { kind: "accepted" }> {
  const at = (options.at ?? new Date()).toISOString();
  return {
    kind: "accepted",
    waitId: wait.id,
    workflowId: "wf-test",
    runId: options.runId ?? "00000000-0000-4000-8000-000000000001",
    deadline: wait.deadline.toISOString(),
    settledAt: at,
    receipt: {
      id: crypto.randomUUID(),
      waitId: wait.id,
      receivedAt: at,
      submittedBy: options.submittedBy ?? "ada",
    },
    payload,
  };
}

/** The outcome a timeout or a cancel leaves for `wait`, for tests. */
export function unsignalledOutcomeFor(
  wait: { id: string; deadline: Date },
  kind: "timed_out" | "cancelled",
  options: { runId?: string } = {},
): WaitOutcome {
  return {
    kind,
    waitId: wait.id,
    workflowId: "wf-test",
    runId: options.runId ?? "00000000-0000-4000-8000-000000000001",
    deadline: wait.deadline.toISOString(),
    settledAt: new Date(wait.deadline.getTime() + 1).toISOString(),
  };
}
