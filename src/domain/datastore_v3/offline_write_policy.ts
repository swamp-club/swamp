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
 * reads run from the copy; a changing method or step runs only under an
 * unexpired explicit lease taken online, else it is refused before starting;
 * definition edits are refused, as serve judges if one is stale
 */

import { UserError } from "../errors.ts";
import { isMutatingKind, type MethodKind } from "../models/model.ts";
import type { ModelRef } from "./intent.ts";
import type { PartitionKey } from "./partition_key.ts";
import { WRITER_LEASE_CLOCK_SKEW_MS } from "./writer_lease.ts";

export const OFFLINE_LEASE_REQUIRED_CODE =
  "datastore_v3_offline_lease_required";

export const OFFLINE_CONFIG_EDIT_CODE = "datastore_v3_offline_config_edit";

export interface HeldOfflineLease {
  readonly model: ModelRef;
  readonly expiresAt: string;
}

export interface OfflineContext {
  readonly heldLeases: readonly HeldOfflineLease[];
  readonly now: number;
  /**
   * Serve's clock minus the local one, measured at the last contact;
   * undefined when never measured, which is read as no offset.
   */
  readonly clockOffsetMs?: number;
  readonly skewMs?: number;
}

export type OfflineWork =
  | { readonly kind: "read" }
  | {
    readonly kind: "method";
    readonly model: ModelRef;
    readonly behaviorName: string;
    readonly method: string;
    /** The method's resolved kind; undefined counts as one that changes things. */
    readonly methodKind: MethodKind | undefined;
  }
  | { readonly kind: "config-edit"; readonly what: string };

export type OfflineDecision =
  | {
    readonly allowed: true;
    readonly lease?: HeldOfflineLease;
  }
  | {
    readonly allowed: false;
    readonly error: OfflineLeaseRequiredError | OfflineConfigEditError;
  };

export class OfflineLeaseRequiredError extends UserError {
  constructor(
    readonly behaviorName: string,
    readonly method: string,
  ) {
    super(
      `Serve is unreachable, so ${method} on ${behaviorName} cannot run: ` +
        `it changes things and needs the behavior's lease, which this ` +
        `checkout does not hold. Nothing was changed. To work offline, take ` +
        `the lease while online: swamp behavior lease acquire ` +
        `${behaviorName} --for <duration>.`,
      OFFLINE_LEASE_REQUIRED_CODE,
    );
    this.name = "OfflineLeaseRequiredError";
  }
}

export class OfflineConfigEditError extends UserError {
  constructor(readonly what: string, readonly verb = "edited") {
    super(
      `Serve is unreachable, so ${what} cannot be ${verb}: serve decides ` +
        `whether an edit is current. Nothing was changed. Try again once ` +
        `serve is reachable.`,
      OFFLINE_CONFIG_EDIT_CODE,
    );
    this.name = "OfflineConfigEditError";
  }
}

/**
 * The live lease the checkout holds on `model`, or undefined: one whose end,
 * by serve's clock, is later than serve's now plus the allowed skew.
 */
export function liveOfflineLease(
  model: ModelRef,
  context: OfflineContext,
): HeldOfflineLease | undefined {
  const serveNow = context.now + (context.clockOffsetMs ?? 0);
  const skew = context.skewMs ?? WRITER_LEASE_CLOCK_SKEW_MS;
  return context.heldLeases.find((lease) => {
    if (!sameModel(lease.model, model)) return false;
    const ends = Date.parse(lease.expiresAt);
    return Number.isFinite(ends) && ends - skew > serveNow;
  });
}

export function decideOfflineWork(
  work: OfflineWork,
  context: OfflineContext,
): OfflineDecision {
  switch (work.kind) {
    case "read":
      return { allowed: true };
    case "config-edit":
      return { allowed: false, error: new OfflineConfigEditError(work.what) };
    case "method": {
      if (!isMutatingKind(work.methodKind)) return { allowed: true };
      const lease = liveOfflineLease(work.model, context);
      return lease === undefined
        ? {
          allowed: false,
          error: new OfflineLeaseRequiredError(work.behaviorName, work.method),
        }
        : { allowed: true, lease };
    }
  }
}

/**
 * the decision at command entry is the main guard; this only keeps an entry
 * point that skipped it from queuing a write. Run records and auto-definitions
 * always queue, config files and the lockfile never
 */
export function checkOfflineCommit(
  partition: PartitionKey,
  context: OfflineContext & { readonly registered: ReadonlySet<string> },
): boolean {
  const identity = partition.identity;
  switch (identity.kind) {
    case "run":
    case "definition":
      return true;
    case "config":
    case "lockfile":
      return false;
    case "model":
      return context.registered.has(partition.toString()) ||
        liveOfflineLease(
            { type: identity.type, id: identity.id },
            context,
          ) !== undefined;
  }
}

function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.type === b.type && a.id.toLowerCase() === b.id.toLowerCase();
}
