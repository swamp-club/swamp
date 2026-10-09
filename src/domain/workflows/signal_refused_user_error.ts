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

const SignalRefusalDetailsSchema = z.object({
  refusal: z.string().min(1),
  lastWait: SignalRefusalLastWaitSchema.optional().catch(undefined),
});

/**
 * A signal the wait refused, as the command reports it. It keeps what the
 * message cannot be relied on for: `--json` output carries `refusal` and,
 * for a key no open wait holds, `lastWait`, so a sender can set the time the
 * key's last wait was settled against its own attempt.
 */
export class SignalRefusedUserError extends UserError {
  readonly refusal: string;
  readonly lastWait?: SignalRefusalLastWait;

  constructor(
    message: string,
    code: string | undefined,
    refusal: string,
    lastWait?: SignalRefusalLastWait,
  ) {
    super(message, code);
    this.name = "SignalRefusedUserError";
    this.refusal = refusal;
    if (lastWait) this.lastWait = lastWait;
  }
}

/**
 * The refusal an error's details describe, if they describe one. The details
 * may come from a server, so nothing in them is taken on trust: a `lastWait`
 * that is not in the form of one is dropped.
 */
export function signalRefusalFromDetails(
  details: unknown,
): { refusal: string; lastWait?: SignalRefusalLastWait } | undefined {
  const parsed = SignalRefusalDetailsSchema.safeParse(details);
  if (!parsed.success) return undefined;
  const { refusal, lastWait } = parsed.data;
  return { refusal, ...(lastWait ? { lastWait } : {}) };
}
