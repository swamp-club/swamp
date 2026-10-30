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
 * Explicit model leases (swamp-club#4121): `swamp model lease acquire`,
 * `release` and `status`. A serve-mode checkout holds a fenced lease on a
 * behavior's lock across commands; every swamp command in the checkout
 * renews it while it lives, and a command that takes the behavior's lock
 * uses it. Leases are a team-mode feature: a checkout not written through
 * serve keeps its local locks and has none to take.
 *
 * @module
 */

import type { LibSwampContext } from "../context.ts";
import {
  behaviorNotFound,
  type SwampError,
  validationFailed,
} from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

/** A behavior a lease is taken on. */
export interface LeaseBehavior {
  readonly name: string;
  readonly type: string;
  readonly id: string;
}

/** An explicit lease, as the lease commands report it. */
export interface ModelLeaseView {
  /** Serve's lock key for the behavior. */
  readonly lockKey: string;
  readonly fence: number;
  /** Each renewal extends the lease by this long. */
  readonly holdMs: number;
  /** When the lease ends unless renewed, by serve's clock. */
  readonly expiresAt: string;
}

/** What `model lease acquire` reports. */
export interface ModelLeaseAcquireData extends ModelLeaseView {
  readonly behavior: LeaseBehavior;
  /** The checkout already held this lease; it was renewed. */
  readonly existing: boolean;
}

/** What `model lease release` reports. */
export interface ModelLeaseReleaseData {
  readonly behavior: LeaseBehavior;
  readonly lockKey: string;
  /** False when the checkout held no lease on the behavior. */
  readonly released: boolean;
}

/** What `model lease status` reports. */
export interface ModelLeaseStatusData {
  readonly leases: readonly (ModelLeaseView & {
    /** `held` until its expiry passes without a renewal, then `expired`. */
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

/** Dependencies of the lease commands. */
export interface ModelLeaseDeps {
  /** Whether the checkout's datastore is written through serve. */
  readonly teamMode: boolean;
  /** The behavior `idOrName` names, if any. */
  readonly lookupBehavior: (
    idOrName: string,
  ) => Promise<LeaseBehavior | undefined>;
  /** Serve's lock key for `behavior`. */
  readonly lockKeyOf: (behavior: LeaseBehavior) => string;
  readonly acquire: (
    lockKey: string,
    holdMs: number,
  ) => Promise<{ lease: ModelLeaseView; existing: boolean }>;
  readonly release: (lockKey: string) => Promise<boolean>;
  readonly list: () => Promise<readonly ModelLeaseView[]>;
  readonly now?: () => number;
}

/**
 * The longest hold an explicit lease may ask for: serve's own bound, a day,
 * so a lease can be checked out to work offline (swamp-club#4195).
 */
export const MAX_LEASE_HOLD_MS = 86_400_000;
/** The shortest hold an explicit lease may ask for. */
export const MIN_LEASE_HOLD_MS = 5_000;

function teamModeOnly(): SwampError {
  return {
    code: "lease_team_mode_only",
    message: "Leases are held at serve: this checkout's datastore is not " +
      "written through serve, so its local locks already keep its commands " +
      "apart",
  };
}

/** Takes an explicit lease on a behavior, held for `holdMs` between renewals. */
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

/** Ends the explicit lease the checkout holds on a behavior. */
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

/** Lists the explicit leases the checkout holds. */
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
