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
 * a serve-mode checkout holds a fenced lease on a behavior's lock across
 * commands; every command in the checkout renews it and a command taking the
 * lock uses it. Team mode only: other checkouts keep local locks
 */

import type { LibSwampContext } from "../context.ts";
import {
  behaviorNotFound,
  type SwampError,
  validationFailed,
} from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface LeaseBehavior {
  readonly name: string;
  readonly type: string;
  readonly id: string;
}

export interface ModelLeaseView {
  readonly lockKey: string;
  readonly fence: number;
  readonly holdMs: number;
  readonly expiresAt: string;
}

export interface ModelLeaseAcquireData extends ModelLeaseView {
  readonly behavior: LeaseBehavior;
  readonly existing: boolean;
}

export interface ModelLeaseReleaseData {
  readonly behavior: LeaseBehavior;
  readonly lockKey: string;
  readonly released: boolean;
}

export interface ModelLeaseStatusData {
  readonly leases: readonly (ModelLeaseView & {
    readonly state: "held" | "expired";
  })[];
}

export type ModelLeaseAcquireEvent =
  | { kind: "completed"; data: ModelLeaseAcquireData }
  | { kind: "error"; error: SwampError };

export type ModelLeaseReleaseEvent =
  | { kind: "completed"; data: ModelLeaseReleaseData }
  | { kind: "error"; error: SwampError };

export type ModelLeaseStatusEvent =
  | { kind: "completed"; data: ModelLeaseStatusData }
  | { kind: "error"; error: SwampError };

export interface ModelLeaseDeps {
  readonly teamMode: boolean;
  readonly lookupBehavior: (
    idOrName: string,
  ) => Promise<LeaseBehavior | undefined>;
  readonly lockKeyOf: (behavior: LeaseBehavior) => string;
  readonly acquire: (
    lockKey: string,
    holdMs: number,
  ) => Promise<{ lease: ModelLeaseView; existing: boolean }>;
  readonly release: (lockKey: string) => Promise<boolean>;
  readonly list: () => Promise<readonly ModelLeaseView[]>;
  readonly now?: () => number;
}

/** serve's own bound, a day, so a lease can be checked out to work offline */
export const MAX_LEASE_HOLD_MS = 86_400_000;
export const MIN_LEASE_HOLD_MS = 5_000;

function teamModeOnly(): SwampError {
  return {
    code: "lease_team_mode_only",
    message: "Leases are held at serve: this checkout's datastore is not " +
      "written through serve, so its local locks already keep its commands " +
      "apart",
  };
}

export async function* modelLeaseAcquire(
  _ctx: LibSwampContext,
  deps: ModelLeaseDeps,
  input: { readonly behavior: string; readonly holdMs: number },
): AsyncIterable<ModelLeaseAcquireEvent> {
  yield* withGeneratorSpan(
    "swamp.model.lease.acquire",
    { "model.id_or_name": input.behavior },
    (async function* () {
      if (!deps.teamMode) {
        yield { kind: "error", error: teamModeOnly() };
        return;
      }
      if (
        !Number.isSafeInteger(input.holdMs) ||
        input.holdMs < MIN_LEASE_HOLD_MS || input.holdMs > MAX_LEASE_HOLD_MS
      ) {
        yield {
          kind: "error",
          error: validationFailed(
            `--for must be between ${MIN_LEASE_HOLD_MS / 1000}s and ` +
              `${MAX_LEASE_HOLD_MS / 3_600_000}h`,
          ),
        };
        return;
      }
      const behavior = await deps.lookupBehavior(input.behavior);
      if (behavior === undefined) {
        yield { kind: "error", error: behaviorNotFound(input.behavior) };
        return;
      }
      const { lease, existing } = await deps.acquire(
        deps.lockKeyOf(behavior),
        input.holdMs,
      );
      yield {
        kind: "completed",
        data: { behavior, existing, ...lease },
      };
    })(),
  );
}

export async function* modelLeaseRelease(
  _ctx: LibSwampContext,
  deps: ModelLeaseDeps,
  input: { readonly behavior: string },
): AsyncIterable<ModelLeaseReleaseEvent> {
  yield* withGeneratorSpan(
    "swamp.model.lease.release",
    { "model.id_or_name": input.behavior },
    (async function* () {
      if (!deps.teamMode) {
        yield { kind: "error", error: teamModeOnly() };
        return;
      }
      const behavior = await deps.lookupBehavior(input.behavior);
      if (behavior === undefined) {
        yield { kind: "error", error: behaviorNotFound(input.behavior) };
        return;
      }
      const lockKey = deps.lockKeyOf(behavior);
      const released = await deps.release(lockKey);
      yield { kind: "completed", data: { behavior, lockKey, released } };
    })(),
  );
}

export async function* modelLeaseStatus(
  _ctx: LibSwampContext,
  deps: ModelLeaseDeps,
): AsyncIterable<ModelLeaseStatusEvent> {
  yield* withGeneratorSpan(
    "swamp.model.lease.status",
    {},
    (async function* () {
      if (!deps.teamMode) {
        yield { kind: "error", error: teamModeOnly() };
        return;
      }
      const now = (deps.now ?? Date.now)();
      const leases = (await deps.list()).map((lease) => ({
        ...lease,
        state: Date.parse(lease.expiresAt) > now
          ? "held" as const
          : "expired" as const,
      }));
      yield { kind: "completed", data: { leases } };
    })(),
  );
}
