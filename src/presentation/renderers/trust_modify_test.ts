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
import { consumeStream, type TrustModifyEvent } from "../../libswamp/mod.ts";
import { createTrustModifyRenderer } from "./trust_modify.ts";
import { UserError } from "../../domain/errors.ts";

async function* toStream(
  events: TrustModifyEvent[],
): AsyncGenerator<TrustModifyEvent> {
  for (const event of events) {
    yield event;
  }
}

Deno.test("LogTrustModifyRenderer - add completed event runs without error", async () => {
  const renderer = createTrustModifyRenderer("log");
  const events: TrustModifyEvent[] = [
    { kind: "resolving" },
    {
      kind: "completed",
      data: {
        action: "added",
        collective: "myorg",
        trustedCollectives: ["swamp", "si", "myorg"],
      },
    },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("LogTrustModifyRenderer - remove completed event runs without error", async () => {
  const renderer = createTrustModifyRenderer("log");
  const events: TrustModifyEvent[] = [
    { kind: "resolving" },
    {
      kind: "completed",
      data: {
        action: "removed",
        collective: "myorg",
        trustedCollectives: ["swamp", "si"],
      },
    },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("LogTrustModifyRenderer - error event throws UserError", () => {
  const renderer = createTrustModifyRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: {
          code: "already_exists",
          message: "Trusted collective already exists: swamp",
        },
      }),
    UserError,
    "Trusted collective already exists: swamp",
  );
});

Deno.test("JsonTrustModifyRenderer - completed serializes correct JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createTrustModifyRenderer("json");
    const events: TrustModifyEvent[] = [
      { kind: "resolving" },
      {
        kind: "completed",
        data: {
          action: "added",
          collective: "myorg",
          trustedCollectives: ["swamp", "si", "myorg"],
        },
      },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.action, "added");
    assertEquals(parsed.collective, "myorg");
    assertEquals(parsed.trustedCollectives, ["swamp", "si", "myorg"]);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonTrustModifyRenderer - error event throws UserError", () => {
  const renderer = createTrustModifyRenderer("json");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: {
          code: "not_found",
          message: "Trusted collective not found: x",
        },
      }),
    UserError,
    "Trusted collective not found: x",
  );
});
