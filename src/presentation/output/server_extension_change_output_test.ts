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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import {
  renderServerExtensionChange,
  type ServerExtensionChangeData,
} from "./server_extension_change_output.ts";

const RELOAD_COMMAND = "swamp serve reload --server ws://127.0.0.1:9090";

interface Captured {
  stdout: string[];
  records: { level: string; text: string }[];
}

async function render(
  data: ServerExtensionChangeData,
  mode: "log" | "json",
): Promise<Captured> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => records.push(record) },
    loggers: [
      { category: ["cli", "remote"], lowestLevel: "debug", sinks: ["capture"] },
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: [] },
    ],
    reset: true,
  });
  const stdout: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => stdout.push(msg);
  try {
    renderServerExtensionChange(data, mode);
  } finally {
    console.log = originalLog;
    await reset();
  }
  return {
    stdout,
    records: records.map((r) => ({
      level: r.level,
      text: r.message.map((p) => String(p)).join(""),
    })),
  };
}

Deno.test("renderServerExtensionChange: log mode without a reload warns to run serve reload", async () => {
  const { stdout, records } = await render(
    { reloadCommand: RELOAD_COMMAND },
    "log",
  );
  assertEquals(stdout, []);
  assertEquals(records.length, 1);
  assertEquals(records[0].level, "warning");
  assertStringIncludes(records[0].text, RELOAD_COMMAND);
});

Deno.test("renderServerExtensionChange: log mode after a reload says serve runs the change, without the warning", async () => {
  const { records } = await render(
    {
      reloadCommand: RELOAD_COMMAND,
      serveReload: { status: "ok", reloadedCount: 3, errors: [] },
    },
    "log",
  );
  assertEquals(records.length, 1);
  assertEquals(records[0].level, "info");
  assertStringIncludes(records[0].text, "reloaded 3 extension type(s)");
});

Deno.test("renderServerExtensionChange: log mode warns on a successful reload's soft errors", async () => {
  const { records } = await render(
    {
      reloadCommand: RELOAD_COMMAND,
      serveReload: {
        status: "ok",
        reloadedCount: 1,
        errors: ["Failed to reload workflows: x"],
      },
    },
    "log",
  );
  assertEquals(records.map((r) => r.level), ["info", "warning"]);
  assertStringIncludes(records[1].text, "Failed to reload workflows: x");
});

Deno.test("renderServerExtensionChange: log mode after a failed reload warns with the errors and the reload command", async () => {
  const { records } = await render(
    {
      reloadCommand: RELOAD_COMMAND,
      serveReload: {
        status: "failed",
        reloadedCount: 0,
        errors: ["Hot-reload failed: boom"],
      },
    },
    "log",
  );
  assertEquals(records.length, 1);
  assertEquals(records[0].level, "warning");
  assertStringIncludes(records[0].text, RELOAD_COMMAND);
  assertStringIncludes(records[0].text, "Hot-reload failed: boom");
});

Deno.test("renderServerExtensionChange: json mode prints the reload outcome as its own document", async () => {
  const serveReload = { status: "ok" as const, reloadedCount: 2, errors: [] };
  const { stdout, records } = await render(
    { reloadCommand: RELOAD_COMMAND, serveReload },
    "json",
  );
  assertEquals(records, []);
  assertEquals(stdout.length, 1);
  assertEquals(JSON.parse(stdout[0]), { serveReload });
});

Deno.test("renderServerExtensionChange: json mode prints nothing when serve did not reload", async () => {
  const { stdout, records } = await render(
    { reloadCommand: RELOAD_COMMAND },
    "json",
  );
  assertEquals(stdout, []);
  assertEquals(records, []);
});
