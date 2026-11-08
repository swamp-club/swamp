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

import { assertEquals } from "@std/assert";
import { assertStringIncludes } from "@std/assert";
import { createServeReloadRenderer } from "./serve_reload.ts";
import type { ServeReloadResponse } from "../../serve/protocol.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { configure, reset } from "@logtape/logtape";

await initializeLogging({});

function captureRender(
  mode: "log" | "json",
  result: ServeReloadResponse,
): string[] {
  const renderer = createServeReloadRenderer(mode);
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    renderer.render(result);
  } finally {
    console.log = origLog;
  }
  return output;
}

Deno.test("createServeReloadRenderer: returns renderer for log mode", () => {
  const renderer = createServeReloadRenderer("log");
  assertEquals(typeof renderer.render, "function");
});

Deno.test("createServeReloadRenderer: returns renderer for json mode", () => {
  const renderer = createServeReloadRenderer("json");
  assertEquals(typeof renderer.render, "function");
});

Deno.test("serveReloadRenderer json: outputs full result as JSON", () => {
  const result: ServeReloadResponse = {
    success: true,
    reloadedCount: 5,
    errors: [],
  };
  const output = captureRender("json", result);
  const parsed = JSON.parse(output.join(""));
  assertEquals(parsed.success, true);
  assertEquals(parsed.reloadedCount, 5);
  assertEquals(parsed.errors, []);
});

Deno.test("serveReloadRenderer json: includes errors on failure", () => {
  const result: ServeReloadResponse = {
    success: false,
    reloadedCount: 0,
    errors: ["Reload already in progress"],
  };
  const output = captureRender("json", result);
  const parsed = JSON.parse(output.join(""));
  assertEquals(parsed.success, false);
  assertStringIncludes(parsed.errors[0], "already in progress");
});

Deno.test("serveReloadRenderer json: includes triggerOverridesChanged in output", () => {
  const result: ServeReloadResponse = {
    success: true,
    reloadedCount: 2,
    triggerOverridesChanged: 3,
    errors: [],
  };
  const output = captureRender("json", result);
  const parsed = JSON.parse(output.join(""));
  assertEquals(parsed.triggerOverridesChanged, 3);
});

async function captureLog(result: ServeReloadResponse): Promise<string[]> {
  const messages: string[] = [];
  await configure({
    reset: true,
    sinks: {
      kept: (record) => {
        messages.push(record.message.map((part) => String(part)).join(""));
      },
    },
    loggers: [
      { category: ["serve"], sinks: ["kept"], lowestLevel: "info" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "fatal" },
    ],
  });
  try {
    createServeReloadRenderer("log").render(result);
  } finally {
    await reset();
    await initializeLogging({});
  }
  return messages;
}

Deno.test("serveReloadRenderer log: reports webhook route changes and warnings", async () => {
  const messages = await captureLog({
    success: true,
    reloadedCount: 0,
    webhooksReloaded: 2,
    warnings: ["Ignored the webhooks list"],
    errors: [],
  });
  assertEquals(
    messages.some((m) => m.includes("Applied 2 webhook route change(s)")),
    true,
  );
  assertEquals(
    messages.some((m) => m.includes("Ignored the webhooks list")),
    true,
  );
});

Deno.test("serveReloadRenderer json: includes warnings", () => {
  const output = captureRender("json", {
    success: true,
    reloadedCount: 0,
    warnings: ["Ignored the webhooks list"],
    errors: [],
  });
  assertEquals(JSON.parse(output.join("")).warnings, [
    "Ignored the webhooks list",
  ]);
});
