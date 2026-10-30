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
 * What a serve-mode checkout may do while serve is unreachable
 * (swamp-club#4195): the offline rules, as a pure decision.
 *
 * - Reads, and methods of kind `read` or `list`, run from the checkout's
 *   copy. What they record (run records, outputs, data versions) is queued
 *   in the outbox: none of it conflicts, or it is rebased on reconnect.
 * - A method or workflow step that changes things runs only on a behavior
 *   whose explicit lease (`swamp behavior lease acquire --for`) the checkout
 *   holds, taken while online, and only while that lease has not expired by
 *   serve's clock, allowing for clock skew. Without one it is refused before
 *   it starts, with {@link OFFLINE_LEASE_REQUIRED_CODE}.
 * - A definition edit is refused with {@link OFFLINE_CONFIG_EDIT_CODE}:
 *   whether an edit is stale is serve's to decide (swamp-club#4097).
 *
 * {@link checkOfflineCommit} is the commit sink's backstop: it judges a
 * queued commit by its partition, so no entry point can queue a write the
 * rules do not allow.
 *
 * @module
 */

import { UserError } from "../errors.ts";
import { isMutatingKind, type MethodKind } from "../models/model.ts";
import type { ModelRef } from "./intent.ts";
import type { PartitionKey } from "./partition_key.ts";
import { WRITER_LEASE_CLOCK_SKEW_MS } from "./writer_lease.ts";

/** Refused offline: the work changes things and holds no lease. */
export const OFFLINE_LEASE_REQUIRED_CODE =
  "datastore_v3_offline_lease_required";

/** Refused offline: a definition edit needs serve to judge it. */
export const OFFLINE_CONFIG_EDIT_CODE = "datastore_v3_offline_config_edit";

/**
 * An explicit lease the checkout holds, as it recorded it while online:
 * the behavior it covers and when it ends by serve's clock.
 */
export interface HeldOfflineLease {
  readonly model: ModelRef;
  /** ISO instant the lease ends unless renewed, by serve's clock. */
  readonly expiresAt: string;
}

/** What the checkout knows while offline. */
export interface OfflineContext {
  readonly heldLeases: readonly HeldOfflineLease[];
  /** The local clock, in epoch milliseconds. */
  readonly now: number;
  /**
   * Serve's clock minus the local one, measured at the last contact;
   * undefined when never measured, which is read as no offset.
   */
  readonly clockOffsetMs?: number;
  /** The clock skew allowed for; {@link WRITER_LEASE_CLOCK_SKEW_MS} by default. */
  readonly skewMs?: number;
}

/** Work a command is about to do offline. */
export type OfflineWork =
  /** A command that only reads the copy. */
  | { readonly kind: "read" }
  /** A method run, or a workflow step running one. */
  | {
    readonly kind: "method";
    readonly model: ModelRef;
    /** The behavior's name, for the refusal's message. */
    readonly behaviorName: string;
    readonly method: string;
    /** The method's resolved kind; undefined counts as one that changes things. */
    readonly methodKind: MethodKind | undefined;
  }
  /** An edit or removal of a definition. */
  | { readonly kind: "config-edit"; readonly what: string };

/** Whether the work may run offline, and under which lease. */
export type OfflineDecision =
  | {
    readonly allowed: true;
    /** The lease a changing method runs under; absent for read work. */
    readonly lease?: HeldOfflineLease;
  }
  | {
    readonly allowed: false;
    readonly error: OfflineLeaseRequiredError | OfflineConfigEditError;
  };

/**
 * A method that changes things was refused offline because the checkout
 * holds no live lease on its behavior. Nothing ran.
 */
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

/** A definition edit was refused offline. Nothing was changed. */
export class OfflineConfigEditError extends UserError {
  /**
   * `verb` is what the refused change was, past participle: "edited" for
   * an edit, "deleted" for a delete.
   */
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

/** Decides whether `work` may run while serve is unreachable. */
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
 * The commit sink's backstop: whether a commit to `partition` may be queued
 * offline. A run's record and an auto-definition (a `definition`
 * partition) always queue: neither conflicts. A behavior's partition needs a
 * live lease on it, or a registration by the command entry that allowed a
 * read-kind run on it (its partition key as a string in `registered`). A
 * managed-config file (a `config` partition, a user's definition edit) or the
 * extension lockfile never queues. The decision at command entry is the main
 * guard; this one only keeps an entry point that skipped it from queuing a
 * write.
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
