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
import { stripAnsiCode } from "@std/fmt/colors";
import type { SubscriptionStartEvent } from "../../libswamp/subscription/start.ts";
import type { OutputMode } from "../output/output.ts";
import { UserError } from "../../domain/errors.ts";
import { createSubscriptionStartRenderer } from "./subscription_start.ts";

const url = "https://swamp-club.com/o/acme/billing";

function capture(event: SubscriptionStartEvent, mode: OutputMode): string {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    const handlers = createSubscriptionStartRenderer(mode).handlers();
    const handler = handlers[event.kind] as (
      e: SubscriptionStartEvent,
    ) => void;
    handler(event);
  } finally {
    console.log = originalLog;
  }
  return stripAnsiCode(logs.join("\n"));
}

Deno.test("LogSubscriptionStartRenderer: an opened browser names the URL", () => {
  assertEquals(
    capture({
      kind: "completed",
      result: { url, collective: "acme", browser: "opened" },
    }, "log"),
    `Opening ${url} in your browser.`,
  );
});

Deno.test("LogSubscriptionStartRenderer: --no-browser prints the URL to manage billing", () => {
  assertEquals(
    capture({
      kind: "completed",
      result: { url, collective: "acme", browser: "skipped" },
    }, "log"),
    `Manage billing at ${url}`,
  );
});

Deno.test("LogSubscriptionStartRenderer: a launcher failure prints the URL indented", () => {
  assertEquals(
    capture({
      kind: "completed",
      result: { url, collective: null, browser: "failed" },
    }, "log"),
    "Could not open a browser. Open this URL to manage billing:\n" +
      `  ${url}`,
  );
});

Deno.test("JsonSubscriptionStartRenderer: prints exactly url, opened and collective", () => {
  const output = capture({
    kind: "completed",
    result: { url, collective: "acme", browser: "opened" },
  }, "json");
  assertEquals(Object.keys(JSON.parse(output)), [
    "url",
    "opened",
    "collective",
  ]);
  assertEquals(JSON.parse(output), { url, opened: true, collective: "acme" });
});

Deno.test("JsonSubscriptionStartRenderer: opened is false for --no-browser and a launcher failure", () => {
  const billing = "https://swamp-club.com/billing";
  assertEquals(
    JSON.parse(
      capture({
        kind: "completed",
        result: { url: billing, collective: null, browser: "skipped" },
      }, "json"),
    ),
    { url: billing, opened: false, collective: null },
  );
  assertEquals(
    JSON.parse(
      capture(
        {
          kind: "completed",
          result: { url: billing, collective: null, browser: "failed" },
        },
        "json",
      ),
    ),
    { url: billing, opened: false, collective: null },
  );
});

Deno.test("SubscriptionStartRenderer: opening_browser prints nothing in either mode", () => {
  for (const mode of ["log", "json"] as const) {
    assertEquals(capture({ kind: "opening_browser", url }, mode), "", mode);
  }
});

Deno.test("SubscriptionStartRenderer: an error throws UserError in either mode", () => {
  for (const mode of ["log", "json"] as const) {
    assertThrows(
      () =>
        createSubscriptionStartRenderer(mode).handlers().error({
          kind: "error",
          error: { code: "not_authenticated", message: "Not authenticated" },
        }),
      UserError,
      "Not authenticated",
    );
  }
});
