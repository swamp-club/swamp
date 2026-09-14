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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import type { AuthLoginEvent } from "../../libswamp/mod.ts";
import { consumeStream } from "../../libswamp/mod.ts";
import {
  type AuthLoginNextStepsOptions,
  createAuthLoginRenderer,
} from "./auth_login.ts";
import { UserError } from "../../domain/errors.ts";

function makeCompletedEvent(): AuthLoginEvent {
  return {
    kind: "completed",
    data: {
      username: "alice",
      email: "alice@example.com",
      name: "Alice",
      serverUrl: "https://swamp-club.com",
      apiKey: "swamp_test_key_1234567890abcdef",
    },
  };
}

async function* toStream(
  events: AuthLoginEvent[],
): AsyncGenerator<AuthLoginEvent> {
  for (const event of events) {
    yield event;
  }
}

function captureOutput(): { output: string; restore: () => void } {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  return {
    get output() {
      return stripAnsiCode(logs.join("\n"));
    },
    restore: () => {
      console.log = originalLog;
    },
  };
}

async function renderCompleted(
  mode: "log" | "json",
  nextStepsOptions: AuthLoginNextStepsOptions,
): Promise<string> {
  const capture = captureOutput();
  try {
    const renderer = createAuthLoginRenderer(mode, false, nextStepsOptions);
    await consumeStream(toStream([makeCompletedEvent()]), renderer.handlers());
    return capture.output;
  } finally {
    capture.restore();
  }
}

// ─── Log renderer ─────────────────────────────────────────────────────

Deno.test("LogAuthLoginRenderer: shows next steps on first interactive login", async () => {
  const output = await renderCompleted("log", {
    isFirstLogin: true,
    isInteractive: true,
  });

  assertStringIncludes(output, "Next steps");
  assertStringIncludes(output, "swamp repo init");
  assertStringIncludes(output, "swamp quest");
});

Deno.test("LogAuthLoginRenderer: omits next steps on returning login", async () => {
  const output = await renderCompleted("log", {
    isFirstLogin: false,
    isInteractive: true,
  });

  assertEquals(output.includes("Next steps"), false);
  assertEquals(output.includes("swamp repo init"), false);
  assertEquals(output.includes("swamp quest"), false);
});

Deno.test("LogAuthLoginRenderer: omits next steps on non-interactive first login", async () => {
  const output = await renderCompleted("log", {
    isFirstLogin: true,
    isInteractive: false,
  });

  assertEquals(output.includes("Next steps"), false);
  assertEquals(output.includes("swamp repo init"), false);
});

Deno.test("LogAuthLoginRenderer: always shows authenticated card", async () => {
  const output = await renderCompleted("log", {
    isFirstLogin: true,
    isInteractive: true,
  });

  assertStringIncludes(output, "Authenticated");
  assertStringIncludes(output, "@alice");
});

Deno.test("LogAuthLoginRenderer: error throws UserError", () => {
  const renderer = createAuthLoginRenderer("log", false, {
    isFirstLogin: false,
    isInteractive: true,
  });
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: {
          code: "user_error",
          message: "Device authorization timed out",
        },
      }),
    UserError,
    "Device authorization timed out",
  );
});

// ─── JSON renderer ────────────────────────────────────────────────────

Deno.test("JsonAuthLoginRenderer: includes nextSteps on first login", async () => {
  const output = await renderCompleted("json", {
    isFirstLogin: true,
    isInteractive: true,
  });

  const parsed = JSON.parse(output);
  assertEquals(parsed.authenticated, true);
  assertEquals(parsed.username, "alice");
  assertEquals(Array.isArray(parsed.nextSteps), true);
  assertEquals(parsed.nextSteps.length, 2);
  assertEquals(parsed.nextSteps[0].command, "swamp repo init");
  assertEquals(parsed.nextSteps[1].command, "swamp quest");
});

Deno.test("JsonAuthLoginRenderer: includes nextSteps on first non-interactive login", async () => {
  const output = await renderCompleted("json", {
    isFirstLogin: true,
    isInteractive: false,
  });

  const parsed = JSON.parse(output);
  assertEquals(Array.isArray(parsed.nextSteps), true);
});

Deno.test("JsonAuthLoginRenderer: omits nextSteps on returning login", async () => {
  const output = await renderCompleted("json", {
    isFirstLogin: false,
    isInteractive: true,
  });

  const parsed = JSON.parse(output);
  assertEquals(parsed.authenticated, true);
  assertEquals("nextSteps" in parsed, false);
});

Deno.test("JsonAuthLoginRenderer: error throws UserError", () => {
  const renderer = createAuthLoginRenderer("json", false, {
    isFirstLogin: false,
    isInteractive: true,
  });
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "user_error", message: "Not authenticated" },
      }),
    UserError,
    "Not authenticated",
  );
});
