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

/** Where a request's reply goes while it is still the newest request. */
export interface ApplyReply<T> {
  result(value: T): void;
  error(err: unknown): void;
}

/**
 * Runs one hook's requests. Only the newest request applies its reply, and
 * each run reports when its request has settled, so a poller can wait for
 * the read it started instead of stacking another on a slow serve.
 */
export interface RequestRunner {
  /**
   * Starts a new request, superseding any in flight. Resolves once it
   * settles; its failure goes to `apply.error`, never to the caller.
   */
  send<T>(start: () => Promise<T>, apply: ApplyReply<T>): Promise<void>;
  /**
   * Waits for the request in flight, or starts one when none is. A read
   * that is already on its way answers as well as a new one would.
   */
  join<T>(start: () => Promise<T>, apply: ApplyReply<T>): Promise<void>;
  /** Retires the request in flight, e.g. when the payload changes. */
  invalidate(): void;
}

export function createRequestRunner(): RequestRunner {
  const sequence = createRequestSequence();
  let pending: { ticket: number; settled: Promise<void> } | null = null;

  const send = <T>(
    start: () => Promise<T>,
    apply: ApplyReply<T>,
  ): Promise<void> => {
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

  return {
    send,
    join: (start, apply) => pending ? pending.settled : send(start, apply),
    invalidate: () => {
      sequence.invalidate();
      pending = null;
    },
  };
}
