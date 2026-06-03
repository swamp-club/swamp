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

import { assertEquals, assertThrows } from "@std/assert";
import { consumeStream, type TrustListEvent } from "../../libswamp/mod.ts";
import { createTrustListRenderer } from "./trust_list.ts";
import { UserError } from "../../domain/errors.ts";

async function* toStream(
  events: TrustListEvent[],
): AsyncGenerator<TrustListEvent> {
  for (const event of events) {
    yield event;
  }
}

const completedEvents: TrustListEvent[] = [
  { kind: "resolving" },
  {
    kind: "completed",
    data: {
      explicit: ["swamp", "si"],
      membership: ["myorg"],
      resolved: ["swamp", "si", "myorg"],
      trustMemberCollectives: true,
    },
  },
];

Deno.test("LogTrustListRenderer - completed event runs without error", async () => {
  const renderer = createTrustListRenderer("log");
  await consumeStream(toStream(completedEvents), renderer.handlers());
});

Deno.test("LogTrustListRenderer - error event throws UserError", () => {
  const renderer = createTrustListRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "validation_failed", message: "Not a swamp repo" },
      }),
    UserError,
    "Not a swamp repo",
  );
});

Deno.test("JsonTrustListRenderer - completed serializes correct JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createTrustListRenderer("json");
    await consumeStream(toStream(completedEvents), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.explicit, ["swamp", "si"]);
    assertEquals(parsed.membership, ["myorg"]);
    assertEquals(parsed.resolved, ["swamp", "si", "myorg"]);
    assertEquals(parsed.trustMemberCollectives, true);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonTrustListRenderer - error event throws UserError", () => {
  const renderer = createTrustListRenderer("json");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "validation_failed", message: "Not a swamp repo" },
      }),
    UserError,
    "Not a swamp repo",
  );
});

Deno.test("createTrustListRenderer - factory returns correct type per mode", () => {
  const logRenderer = createTrustListRenderer("log");
  const jsonRenderer = createTrustListRenderer("json");
  assertEquals(typeof logRenderer.handlers, "function");
  assertEquals(typeof jsonRenderer.handlers, "function");
});
