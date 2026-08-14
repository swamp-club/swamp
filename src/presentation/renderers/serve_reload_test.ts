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
