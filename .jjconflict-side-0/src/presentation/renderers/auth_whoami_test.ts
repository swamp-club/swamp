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
import { type AuthWhoamiEvent, consumeStream } from "../../libswamp/mod.ts";
import { createAuthWhoamiRenderer } from "./auth_whoami.ts";
import { UserError } from "../../domain/errors.ts";

function makeIdentity(opts?: { collectives?: string[] }) {
  return {
    serverUrl: "https://club.example.com",
    id: "user-1",
    username: "alice",
    email: "alice@example.com",
    name: "Alice",
    ...(opts?.collectives ? { collectives: opts.collectives } : {}),
  };
}

async function* toStream(
  events: AuthWhoamiEvent[],
): AsyncGenerator<AuthWhoamiEvent> {
  for (const event of events) {
    yield event;
  }
}

Deno.test("LogAuthWhoamiRenderer - completed event runs without error", async () => {
  const renderer = createAuthWhoamiRenderer("log");
  const events: AuthWhoamiEvent[] = [
    { kind: "loading_credentials" },
    { kind: "contacting_server", serverUrl: "https://club.example.com" },
    { kind: "completed", identity: makeIdentity() },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("LogAuthWhoamiRenderer - collectives handled without error", async () => {
  const renderer = createAuthWhoamiRenderer("log");
  const events: AuthWhoamiEvent[] = [
    { kind: "loading_credentials" },
    { kind: "contacting_server", serverUrl: "https://club.example.com" },
    {
      kind: "completed",
      identity: makeIdentity({ collectives: ["org-a", "org-b"] }),
    },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("LogAuthWhoamiRenderer - error event throws UserError", () => {
  const renderer = createAuthWhoamiRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_authenticated", message: "Not authenticated" },
      }),
    UserError,
    "Not authenticated",
  );
});

Deno.test("JsonAuthWhoamiRenderer - completed serializes correct JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createAuthWhoamiRenderer("json");
    const events: AuthWhoamiEvent[] = [
      { kind: "loading_credentials" },
      { kind: "contacting_server", serverUrl: "https://club.example.com" },
      { kind: "completed", identity: makeIdentity() },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.authenticated, true);
    assertEquals(parsed.serverUrl, "https://club.example.com");
    assertEquals(parsed.username, "alice");
    assertEquals(parsed.email, "alice@example.com");
    assertEquals(parsed.id, "user-1");
    assertEquals(parsed.name, "Alice");
    assertEquals(parsed.collectives, undefined);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonAuthWhoamiRenderer - collectives included when present", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createAuthWhoamiRenderer("json");
    const events: AuthWhoamiEvent[] = [
      { kind: "loading_credentials" },
      {
        kind: "completed",
        identity: makeIdentity({ collectives: ["org-a"] }),
      },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.collectives, ["org-a"]);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonAuthWhoamiRenderer - intermediate events produce no output", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createAuthWhoamiRenderer("json");
    const handlers = renderer.handlers();
    handlers.loading_credentials({ kind: "loading_credentials" });
    handlers.contacting_server({
      kind: "contacting_server",
      serverUrl: "https://club.example.com",
    });
    assertEquals(logs.length, 0);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonAuthWhoamiRenderer - error event throws UserError", () => {
  const renderer = createAuthWhoamiRenderer("json");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_authenticated", message: "Not authenticated" },
      }),
    UserError,
    "Not authenticated",
  );
});

Deno.test("createAuthWhoamiRenderer - factory returns correct type per mode", () => {
  const logRenderer = createAuthWhoamiRenderer("log");
  const jsonRenderer = createAuthWhoamiRenderer("json");
  assertEquals(typeof logRenderer.handlers, "function");
  assertEquals(typeof jsonRenderer.handlers, "function");
});
