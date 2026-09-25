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
import { consumeStream } from "../../libswamp/mod.ts";
import type { ExtensionListEvent } from "../../libswamp/mod.ts";
import { createExtensionListRenderer } from "./extension_list.ts";
import { UserError } from "../../domain/errors.ts";

async function* toStream(
  events: ExtensionListEvent[],
): AsyncGenerator<ExtensionListEvent> {
  for (const event of events) {
    yield event;
  }
}

Deno.test("JsonExtensionListRenderer - completed outputs JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createExtensionListRenderer("json");
    await consumeStream(
      toStream([
        { kind: "resolving" },
        {
          kind: "completed",
          data: {
            extensions: [
              {
                name: "@ns/ext",
                version: "1.0.0",
                pulledAt: "2026-01-01",
                files: [],
              },
            ],
          },
        },
      ]),
      renderer.handlers(),
    );
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.extensions.length, 1);
    assertEquals(parsed.extensions[0].name, "@ns/ext");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("ExtensionListRenderer - error throws UserError", () => {
  const renderer = createExtensionListRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "test", message: "boom" },
      }),
    UserError,
    "boom",
  );
});

Deno.test("JsonExtensionListRenderer - emits enrichment fields when present", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createExtensionListRenderer("json");
    await renderer.handlers().completed({
      kind: "completed",
      data: {
        extensions: [
          {
            name: "@ns/ext",
            version: "2026.01.01.1",
            pulledAt: "2026-01-01",
            files: [],
            latestVersion: "2026.02.01.1",
            updateStatus: "update_available",
          },
          {
            name: "@ns/offline",
            version: "2026.01.01.1",
            pulledAt: "2026-01-01",
            files: [],
            latestVersion: null,
            updateStatus: "unknown_offline",
          },
        ],
      },
    });
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.extensions[0].latestVersion, "2026.02.01.1");
    assertEquals(parsed.extensions[0].updateStatus, "update_available");
    assertEquals(parsed.extensions[1].latestVersion, null);
    assertEquals(parsed.extensions[1].updateStatus, "unknown_offline");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonExtensionListRenderer - omits enrichment fields when absent", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createExtensionListRenderer("json");
    await renderer.handlers().completed({
      kind: "completed",
      data: {
        extensions: [
          {
            name: "@ns/ext",
            version: "2026.01.01.1",
            pulledAt: "2026-01-01",
            files: [],
          },
        ],
      },
    });
    const parsed = JSON.parse(logs[0]);
    assertEquals(
      "latestVersion" in parsed.extensions[0],
      false,
      "latestVersion should not appear when enrichment was not run",
    );
    assertEquals(
      "updateStatus" in parsed.extensions[0],
      false,
      "updateStatus should not appear when enrichment was not run",
    );
  } finally {
    console.log = originalLog;
  }
});

Deno.test("LogExtensionListRenderer - flags an on-disk version that differs from the pin", async () => {
  const { initializeLogging } = await import(
    "../../infrastructure/logging/logger.ts"
  );
  await initializeLogging({
    _reset: true,
    logLevel: "info",
    _logsConfig: { exporterKind: "none" },
  });
  const lines: string[] = [];
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
  };
  const capture = (...args: unknown[]) => lines.push(args.join(" "));
  console.log = capture;
  console.info = capture;
  console.warn = capture;
  try {
    const renderer = createExtensionListRenderer("log");
    await consumeStream(
      toStream([
        { kind: "resolving" },
        {
          kind: "completed",
          data: {
            extensions: [
              {
                name: "@swamp/s3-datastore",
                version: "2026.08.27.1",
                pulledAt: "2026-01-01",
                files: [],
                onDiskVersion: "2026.09.01.1",
              },
            ],
          },
        },
      ]),
      renderer.handlers(),
    );
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
  }
  const row = lines.find((l) => l.includes("(pulled 2026-01-01)")) ?? "";
  assertEquals(row.includes("(on disk v2026.09.01.1)"), true, row);
  assertEquals(row.includes("(auto-resolved)"), false, row);
  assertEquals(
    lines.some((l) => l.includes("Auto-resolved extensions")),
    false,
    lines.join("\n"),
  );
  const remedy = lines.find((l) => l.includes("on disk, not the pinned")) ??
    "";
  assertEquals(
    remedy.includes(
      "swamp extension pull @swamp/s3-datastore@2026.08.27.1 --force",
    ),
    true,
    remedy,
  );
});

Deno.test("LogExtensionListRenderer - an auto-resolved skew remedy deletes what it installed instead of pulling", async () => {
  const { initializeLogging } = await import(
    "../../infrastructure/logging/logger.ts"
  );
  await initializeLogging({
    _reset: true,
    logLevel: "info",
    _logsConfig: { exporterKind: "none" },
  });
  const lines: string[] = [];
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
  };
  const capture = (...args: unknown[]) => lines.push(args.join(" "));
  console.log = capture;
  console.info = capture;
  console.warn = capture;
  try {
    const renderer = createExtensionListRenderer("log");
    await consumeStream(
      toStream([
        { kind: "resolving" },
        {
          kind: "completed",
          data: {
            extensions: [
              {
                name: "@swamp/aws/ec2",
                version: "2026.08.27.1",
                pulledAt: "2026-01-01",
                files: [],
                onDiskVersion: "2026.09.01.1",
                autoResolved: true,
                removeToReinstall: [
                  ".swamp/config/pulled-extensions/@swamp/aws/ec2",
                  ".swamp/pulled-extensions/skills/ec2",
                ],
              },
            ],
          },
        },
      ]),
      renderer.handlers(),
    );
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
  }
  const row = lines.find((l) => l.includes("(pulled 2026-01-01)")) ?? "";
  assertEquals(row.includes("(auto-resolved)"), true, row);
  const remedy = lines.find((l) => l.includes("on disk, not the pinned")) ??
    "";
  assertEquals(
    remedy.includes(
      "delete .swamp/config/pulled-extensions/@swamp/aws/ec2, " +
        ".swamp/pulled-extensions/skills/ec2 and it is reinstalled",
    ),
    true,
    remedy,
  );
  assertEquals(remedy.includes("extension pull"), false, remedy);
  // One footer explains why update and rm do not act on the row.
  assertEquals(
    lines.filter((l) => l.includes("Auto-resolved extensions are not managed"))
      .length,
    1,
    lines.join("\n"),
  );
});
