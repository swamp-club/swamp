// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

/** Base constraint for all stream events — must have a `kind` discriminant. */
export type StreamEvent = { kind: string };

/**
 * Compile-time check that an event union includes both `completed` and `error`
 * terminal variants. Resolves to `E` when valid, `never` when invalid.
 */
export type HasTerminals<E extends StreamEvent> = Extract<
  E,
  { kind: "completed" }
> extends never ? never
  : Extract<E, { kind: "error" }> extends never ? never
  : E;

/**
 * Mapped type enforcing exhaustive handler objects.
 * Every step in the event union becomes a required key.
 */
export type EventHandlers<E extends StreamEvent> = {
  [K in E["kind"]]: (
    event: Extract<E, { kind: K }>,
  ) => void | Promise<void>;
};

/**
 * Iterates a stream and dispatches each event to the matching handler.
 * Handlers are exhaustiveness-checked at compile time.
 */
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

/**
 * Fast-forwards through a stream to the `completed` event.
 * Throws the `SwampError` if an `error` event is encountered.
 * Throws a generic error if the stream ends without a terminal event.
 */
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

/**
 * Fills missing handlers with no-ops (or a provided fallback).
 * Uses Proxy since step names exist only in the type system at runtime.
 */
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
