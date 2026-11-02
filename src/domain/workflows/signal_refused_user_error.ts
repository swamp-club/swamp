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

export type SignalRefusalLastWait = z.infer<typeof SignalRefusalLastWaitSchema>;

const SignalRefusalPendingSchema = z.object({
  heldUntil: z.string(),
  receipt: z.object({
    id: z.string(),
    receivedAt: z.string(),
    submittedBy: z.string(),
  }).optional().catch(undefined),
});

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
 * details may come from a server, so nothing is taken on trust: a lastWait or
 * pending not in the expected form is dropped
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
