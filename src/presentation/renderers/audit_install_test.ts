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
import { consumeStream } from "../../libswamp/stream.ts";
import type {
  AuditUserHookData,
  AuditUserHookEvent,
} from "../../libswamp/audit/install.ts";
import { UserError } from "../../domain/errors.ts";
import type { OutputMode } from "../output/output.ts";
import { createAuditUserHookHandlers } from "./audit_install.ts";

async function* toStream<E>(events: E[]): AsyncGenerator<E> {
  for (const event of events) yield event;
}

async function render(
  mode: OutputMode,
  data: Partial<AuditUserHookData>,
): Promise<string[]> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(stripAnsiCode(msg));
  try {
    await consumeStream(
      toStream<AuditUserHookEvent>([{
        kind: "completed",
        data: {
          action: "install",
          scope: "user",
          tool: "claude",
          settingsPath: "/home/u/.claude/settings.json",
          changed: true,
          ...data,
        },
      }]),
      createAuditUserHookHandlers(mode),
    );
  } finally {
    console.log = originalLog;
  }
  return logs;
}

Deno.test("createAuditUserHookHandlers: log mode names the file and the per-call scope", async () => {
  const text = (await render("log", {})).join("\n");
  assertEquals(
    text.startsWith(
      "✓ Added swamp's audit hook to /home/u/.claude/settings.json",
    ),
    true,
  );
  assertEquals(
    text.includes("calls outside a swamp repo are not recorded"),
    true,
  );
});

Deno.test("createAuditUserHookHandlers: log mode says when nothing changed", async () => {
  assertEquals(
    (await render("log", { changed: false }))[0].split("\n")[0],
    "• /home/u/.claude/settings.json already runs swamp's audit hook",
  );
  assertEquals(
    await render("log", { action: "uninstall", changed: true }),
    ["✓ Removed swamp's audit hook from /home/u/.claude/settings.json"],
  );
  assertEquals(
    await render("log", { action: "uninstall", changed: false }),
    ["• /home/u/.claude/settings.json has no audit hook that swamp added"],
  );
});

Deno.test("createAuditUserHookHandlers: json mode prints the data", async () => {
  const logs = await render("json", { changed: false });
  assertEquals(JSON.parse(logs.join("\n")), {
    action: "install",
    scope: "user",
    tool: "claude",
    settingsPath: "/home/u/.claude/settings.json",
    changed: false,
  });
});

Deno.test("createAuditUserHookHandlers: an error event throws a UserError", async () => {
  await assertRejects(
    () =>
      consumeStream(
        toStream<AuditUserHookEvent>([{
          kind: "error",
          error: { code: "user_error", message: "not valid JSON" },
        }]),
        createAuditUserHookHandlers("log"),
      ),
    UserError,
    "not valid JSON",
  );
});
