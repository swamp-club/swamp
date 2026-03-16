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

import { assertEquals } from "@std/assert";
import type { SwampError } from "./errors.ts";
import type { HasTerminals, StreamEvent } from "./stream.ts";

/** Accumulates all events from a stream into an array. */
export async function collect<E extends StreamEvent>(
  stream: AsyncIterable<E>,
): Promise<E[]> {
  const events: E[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/**
 * Asserts that a stream ends with a `completed` event matching the expected value.
 * Returns the completed event for further inspection.
 */
export async function assertCompletes<E extends StreamEvent>(
  stream: AsyncIterable<HasTerminals<E>>,
  expected: Extract<E, { kind: "completed" }>,
): Promise<Extract<E, { kind: "completed" }>> {
  const events = await collect(stream);
  const last = events[events.length - 1];
  assertEquals(last, expected as unknown as E);
  return last as unknown as Extract<E, { kind: "completed" }>;
}

/**
 * Asserts that a stream ends with an `error` event with the given code.
 * Returns the SwampError for further inspection.
 */
export async function assertErrors<E extends StreamEvent>(
  stream: AsyncIterable<HasTerminals<E>>,
  expectedCode: string,
): Promise<SwampError> {
  const events = await collect(stream);
  const last = events[events.length - 1] as {
    kind: string;
    error?: SwampError;
  };
  assertEquals(last.kind, "error");
  const error = last.error!;
  assertEquals(error.code, expectedCode);
  return error;
}
