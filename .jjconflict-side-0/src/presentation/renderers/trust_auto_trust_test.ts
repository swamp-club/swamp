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

import { assertEquals, assertThrows } from "@std/assert";
import { consumeStream, type TrustAutoTrustEvent } from "../../libswamp/mod.ts";
import { createTrustAutoTrustRenderer } from "./trust_auto_trust.ts";
import { UserError } from "../../domain/errors.ts";

async function* toStream(
  events: TrustAutoTrustEvent[],
): AsyncGenerator<TrustAutoTrustEvent> {
  for (const event of events) {
    yield event;
  }
}

Deno.test("LogTrustAutoTrustRenderer - enabled completed runs without error", async () => {
  const renderer = createTrustAutoTrustRenderer("log");
  const events: TrustAutoTrustEvent[] = [
    { kind: "resolving" },
    { kind: "completed", data: { trustMemberCollectives: true } },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("LogTrustAutoTrustRenderer - disabled completed runs without error", async () => {
  const renderer = createTrustAutoTrustRenderer("log");
  const events: TrustAutoTrustEvent[] = [
    { kind: "resolving" },
    { kind: "completed", data: { trustMemberCollectives: false } },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("LogTrustAutoTrustRenderer - error event throws UserError", () => {
  const renderer = createTrustAutoTrustRenderer("log");
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

Deno.test("JsonTrustAutoTrustRenderer - completed serializes correct JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createTrustAutoTrustRenderer("json");
    const events: TrustAutoTrustEvent[] = [
      { kind: "resolving" },
      { kind: "completed", data: { trustMemberCollectives: true } },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.trustMemberCollectives, true);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonTrustAutoTrustRenderer - error event throws UserError", () => {
  const renderer = createTrustAutoTrustRenderer("json");
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

Deno.test("createTrustAutoTrustRenderer - factory returns correct type per mode", () => {
  const logRenderer = createTrustAutoTrustRenderer("log");
  const jsonRenderer = createTrustAutoTrustRenderer("json");
  assertEquals(typeof logRenderer.handlers, "function");
  assertEquals(typeof jsonRenderer.handlers, "function");
});
