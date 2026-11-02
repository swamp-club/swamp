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

import type { SwampError } from "./errors.ts";

export type StreamEvent = { kind: string };

export type HasTerminals<E extends StreamEvent> = Extract<
  E,
  { kind: "completed" }
> extends never ? never
  : Extract<E, { kind: "error" }> extends never ? never
  : E;

export type EventHandlers<E extends StreamEvent> = {
  [K in E["kind"]]: (
    event: Extract<E, { kind: K }>,
  ) => void | Promise<void>;
};

export async function consumeStream<E extends StreamEvent>(
  stream: AsyncIterable<HasTerminals<E>>,
  handlers: EventHandlers<E>,
): Promise<void> {
  for await (const event of stream) {
    const handler = handlers[event.kind as E["kind"]];
    // deno-lint-ignore no-explicit-any
    await handler(event as any);
  }
}

export async function result<E extends StreamEvent>(
  stream: AsyncIterable<HasTerminals<E>>,
): Promise<Extract<E, { kind: "completed" }>> {
  for await (const event of stream) {
    if (event.kind === "completed") {
      return event as unknown as Extract<E, { kind: "completed" }>;
    }
    if (event.kind === "error") {
      throw (event as unknown as { error: SwampError }).error;
    }
  }
  throw new Error("Stream ended without a completed or error event");
}

/** uses a Proxy because step names exist only in the type system at runtime */
export function withDefaults<E extends StreamEvent>(
  partial: Partial<EventHandlers<E>>,
  fallback?: (event: E) => void | Promise<void>,
): EventHandlers<E> {
  const noop = () => {};
  return new Proxy(partial as EventHandlers<E>, {
    get(target, prop, receiver) {
      const handler = Reflect.get(target, prop, receiver);
      if (handler) return handler;
      if (fallback) return fallback;
      return noop;
    },
  });
}
