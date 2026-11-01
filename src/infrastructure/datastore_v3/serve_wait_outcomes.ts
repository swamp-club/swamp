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
 * Signal outcomes a serve-mode checkout reads from serve (swamp-club#4245).
 *
 * A checkout's wait records live under its local root, and a signal is decided
 * by serve's handler, whose outcome lives in serve's control plane. A run this
 * checkout drives must see that outcome, so the outcome a checkout finds or
 * settles is serve's when serve holds one. It is copied into the local store,
 * where it is written once, so the run keeps it offline. An unreachable serve
 * leaves the local store to answer: a local outcome is only ever a timeout or
 * a cancel, which serve judges from the run record.
 *
 * @module
 */

import {
  type StoredWaitRecord,
  type WaitOutcome,
  WaitOutcomeSchema,
} from "../../domain/workflows/signal_wait_records.ts";
import type { SignalWaitStore } from "../../domain/workflows/signal_wait_store.ts";

/** How long a read of serve's outcome may hold up a run. */
const OUTCOME_READ_TIMEOUT_MS = 5_000;

/** `local`, its outcomes taken from `readFromServe` when serve holds one. */
export function withServeOutcomes(
  local: SignalWaitStore,
  readFromServe: (waitId: string, signal: AbortSignal) => Promise<unknown>,
): SignalWaitStore {
  const fromServe = async (
    waitId: string,
  ): Promise<StoredWaitRecord<WaitOutcome> | undefined> => {
    let raw: unknown;
    try {
      raw = await readFromServe(
        waitId,
        AbortSignal.timeout(OUTCOME_READ_TIMEOUT_MS),
      );
    } catch {
      return undefined;
    }
    const parsed = WaitOutcomeSchema.safeParse(raw);
    if (!parsed.success || parsed.data.waitId !== waitId.toLowerCase()) {
      return undefined;
    }
    await local.settle(parsed.data);
    return { kind: "found", record: parsed.data };
  };
  const overrides: Partial<SignalWaitStore> = {
    findOutcome: async (waitId) =>
      await fromServe(waitId) ?? await local.findOutcome(waitId),
    settle: async (outcome) =>
      await fromServe(outcome.waitId) ?? await local.settle(outcome),
  };
  return new Proxy(local, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) {
        return overrides[property as keyof SignalWaitStore];
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  });
}
