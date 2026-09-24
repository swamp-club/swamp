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

import { assertEquals, assertRejects } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import {
  type AuthLogoutData,
  type AuthLogoutEvent,
  consumeStream,
} from "../../libswamp/mod.ts";
import { createAuthLogoutRenderer } from "./auth_logout.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";

async function* toStream(
  events: AuthLogoutEvent[],
): AsyncGenerator<AuthLogoutEvent> {
  for (const event of events) {
    yield event;
  }
}

async function render(
  mode: OutputMode,
  data: AuthLogoutData,
): Promise<string[]> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(stripAnsiCode(msg));
  try {
    await consumeStream(
      toStream([{ kind: "completed", data }]),
      createAuthLogoutRenderer(mode).handlers(),
    );
  } finally {
    console.log = originalLog;
  }
  return logs;
}

const LOGGED_OUT: AuthLogoutData = {
  loggedOut: true,
  username: "alice",
  serverUrl: "https://club.example.com",
};

Deno.test("LogAuthLogoutRenderer - reports a revoked key", async () => {
  const logs = await render("log", {
    ...LOGGED_OUT,
    keyRevocation: "revoked",
    keyId: "key-1",
  });
  assertEquals(logs, [
    "Logged out alice from https://club.example.com",
    "Revoked the stored API key on https://club.example.com.",
  ]);
});

Deno.test("LogAuthLogoutRenderer - reports an already invalid key", async () => {
  const logs = await render("log", {
    ...LOGGED_OUT,
    keyRevocation: "already_invalid",
  });
  assertEquals(logs, [
    "Logged out alice from https://club.example.com",
    "The stored API key was already invalid on https://club.example.com.",
  ]);
});

Deno.test("LogAuthLogoutRenderer - prints no key line when no key was stored", async () => {
  const logs = await render("log", { ...LOGGED_OUT, keyRevocation: "no_key" });
  assertEquals(logs, ["Logged out alice from https://club.example.com"]);
});

Deno.test("LogAuthLogoutRenderer - reports when not authenticated", async () => {
  const logs = await render("log", {
    loggedOut: false,
    reason: "not authenticated",
  });
  assertEquals(logs, ["Not currently authenticated."]);
});

Deno.test("JsonAuthLogoutRenderer - emits keyRevocation and keyId", async () => {
  const data: AuthLogoutData = {
    ...LOGGED_OUT,
    keyRevocation: "revoked",
    keyId: "key-1",
  };
  const logs = await render("json", data);
  assertEquals(logs.length, 1);
  assertEquals(JSON.parse(logs[0]), data);
});

for (const mode of ["log", "json"] as const) {
  Deno.test(`AuthLogoutRenderer (${mode}) - error event throws UserError`, async () => {
    await assertRejects(
      () =>
        consumeStream(
          toStream([{
            kind: "error",
            error: { code: "revoke_failed", message: "Could not revoke" },
          }]),
          createAuthLogoutRenderer(mode).handlers(),
        ),
      UserError,
      "Could not revoke",
    );
  });
}
