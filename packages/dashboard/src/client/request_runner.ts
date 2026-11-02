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

import { createRequestSequence } from "./request_sequence.ts";

export interface ApplyReply<T> {
  result(value: T): void;
  error(err: unknown): void;
}

/**
 * only the newest request applies its reply, and each run reports when it has
 * settled, so a poller can wait for its read instead of stacking another on a
 * slow serve
 */
export interface RequestRunner {
  send<T>(start: () => Promise<T>, apply: ApplyReply<T>): Promise<void>;
  join<T>(start: () => Promise<T>, apply: ApplyReply<T>): Promise<void>;
  /**
   * Waits for the request in flight and then reads once more, or starts
   * one when none is in flight. For a re-read after something changed: the
   * read in flight still answers, and the change is not lost. Refreshes
   * while a read is in flight cost one more read between them; a send or
   * invalidate drops it. Resolves once the last read settles.
   */
  refresh<T>(start: () => Promise<T>, apply: ApplyReply<T>): Promise<void>;
  invalidate(): void;
}

export function createRequestRunner(): RequestRunner {
  const sequence = createRequestSequence();
  let pending: { ticket: number; settled: Promise<void> } | null = null;
  // The read a refresh owes once the request in flight settles. Every
  // request starts through `send`, which clears it, so it is only set
  // while a read is in flight.
  let queued: (() => Promise<void>) | null = null;

  const send = <T>(
    start: () => Promise<T>,
    apply: ApplyReply<T>,
  ): Promise<void> => {
    queued = null;
    const ticket = sequence.next();
    let reply: Promise<T>;
    try {
      reply = start();
    } catch (err) {
      reply = Promise.reject(err);
    }
    const settled = reply
      .then(
        (value) => {
          if (sequence.isCurrent(ticket)) apply.result(value);
        },
        (err) => {
          if (sequence.isCurrent(ticket)) apply.error(err);
        },
      )
      .finally(() => {
        if (pending?.ticket === ticket) pending = null;
      });
    pending = { ticket, settled };
    return settled;
  };

  const drain = (): Promise<void> => {
    const owed = queued;
    if (owed) return owed();
    return pending ? pending.settled : Promise.resolve();
  };

  return {
    send,
    join: (start, apply) => pending ? pending.settled : send(start, apply),
    refresh: (start, apply) => {
      if (!pending) return send(start, apply);
      queued = () => send(start, apply);
      return pending.settled.then(drain);
    },
    invalidate: () => {
      sequence.invalidate();
      pending = null;
      queued = null;
    },
  };
}
