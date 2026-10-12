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
import { z } from "zod";
import { UserError } from "../errors.ts";
import { SignalReceiptSchema } from "./signal_wait.ts";

const SignalRefusalLastWaitSchema = z.object({
  waitId: z.string(),
  settledAs: z.enum(["accepted", "timed_out", "cancelled"]),
  settledAt: z.string(),
  receipt: SignalReceiptSchema.optional(),
});

/**
 * The wait that last held a key, as a refused signal's error carries it: how
 * it was settled and when, and the signal that settled it when the caller
 * may be told.
 */
export type SignalRefusalLastWait = z.infer<typeof SignalRefusalLastWaitSchema>;

const SignalRefusalPendingSchema = z.object({
  heldUntil: z.string(),
  receipt: z.object({
    id: z.string(),
    receivedAt: z.string(),
    submittedBy: z.string(),
  }).optional().catch(undefined),
});

/**
 * The signal already pending for a key, as an `already_pending` refusal
 * carries it: until when it is held, and its receipt when the caller may be
 * told.
 */
export type SignalRefusalPending = z.infer<typeof SignalRefusalPendingSchema>;

// The use case puts `heldUntil` and `receipt` beside the refusal; a server
// sends them under `pending`.
const SignalRefusalDetailsSchema = z.object({
  refusal: z.string().min(1),
  lastWait: SignalRefusalLastWaitSchema.optional().catch(undefined),
  pending: SignalRefusalPendingSchema.optional().catch(undefined),
  heldUntil: z.string().optional().catch(undefined),
  receipt: SignalRefusalPendingSchema.shape.receipt,
});

/**
 * A signal the wait refused, as the command reports it. It keeps what the
 * message cannot be relied on for: `--json` output carries `refusal` and,
 * for a key no open wait holds, `lastWait`, so a sender can set the time the
 * key's last wait was settled against its own attempt. For a key that
 * already holds a pending signal it carries `pending`, so a sender knows
 * when it can send again.
 */
export class SignalRefusedUserError extends UserError {
  readonly refusal: string;
  readonly lastWait?: SignalRefusalLastWait;
  readonly pending?: SignalRefusalPending;

  constructor(
    message: string,
    code: string | undefined,
    refusal: string,
    lastWait?: SignalRefusalLastWait,
    pending?: SignalRefusalPending,
  ) {
    super(message, code);
    this.name = "SignalRefusedUserError";
    this.refusal = refusal;
    if (lastWait) this.lastWait = lastWait;
    if (pending) this.pending = pending;
  }
}

/**
 * The refusal an error's details describe, if they describe one. The details
 * may come from a server, so nothing in them is taken on trust: a `lastWait`
 * or a `pending` that is not in the form of one is dropped.
 */
export function signalRefusalFromDetails(
  details: unknown,
): {
  refusal: string;
  lastWait?: SignalRefusalLastWait;
  pending?: SignalRefusalPending;
} | undefined {
  const parsed = SignalRefusalDetailsSchema.safeParse(details);
  if (!parsed.success) return undefined;
  const { refusal, lastWait, heldUntil, receipt } = parsed.data;
  // Other refusals carry a `receipt` of their own beside the refusal.
  const pending = refusal !== "already_pending"
    ? undefined
    : parsed.data.pending ??
      (heldUntil !== undefined
        ? { heldUntil, ...(receipt ? { receipt } : {}) }
        : undefined);
  return {
    refusal,
    ...(lastWait ? { lastWait } : {}),
    ...(pending ? { pending } : {}),
  };
}
