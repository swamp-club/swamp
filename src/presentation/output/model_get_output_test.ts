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
import { stripAnsiCode } from "@std/fmt/colors";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { ModelGetData } from "../../libswamp/mod.ts";
import { renderModelGet } from "../renderers/model_get.ts";

await initializeLogging({});

const testData: ModelGetData = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  name: "test-echo",
  type: "swamp/echo",
  version: 1,
  tags: { env: "test", project: "demo" },
  globalArguments: { message: "Hello World" },
};

Deno.test("renderModelGet with json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelGet(testData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.id, testData.id);
    assertEquals(parsed.name, testData.name);
    assertEquals(parsed.type, testData.type);
    assertEquals(parsed.version, testData.version);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelGet JSON includes tags and attributes", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelGet(testData, "json");
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.tags.env, "test");
    assertEquals(parsed.tags.project, "demo");
    assertEquals(parsed.globalArguments.message, "Hello World");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderModelGet with log mode does not throw", () => {
  renderModelGet(testData, "log");
});

Deno.test("renderModelGet log mode shows model details", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderModelGet(testData, "log");
    const combined = stripAnsiCode(logs.join("\n"));
    assertStringIncludes(combined, "Name:");
    assertStringIncludes(combined, "test-echo");
    assertStringIncludes(combined, "(swamp/echo)");
    assertStringIncludes(combined, "Tags:");
    assertStringIncludes(combined, "env:");
    assertStringIncludes(combined, "Global Arguments:");
    assertStringIncludes(combined, "message:");
  } finally {
    console.log = originalLog;
  }
});
