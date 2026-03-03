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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  type AuthLoginSuccessData,
  renderAuthLoginSuccess,
  renderDeviceVerification,
} from "./auth_login_output.ts";

await initializeLogging({});

const testData: AuthLoginSuccessData = {
  username: "john",
  email: "john@example.com",
  name: "John Watson",
  serverUrl: "https://swamp.club",
  apiKey: "swamp_abc123def456ghi789",
};

Deno.test("renderDeviceVerification shows code in a styled card", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderDeviceVerification("NDUZ-32AA");
    const combined = stripAnsiCode(logs.join("\n"));
    assertStringIncludes(combined, "Verify your device");
    assertStringIncludes(combined, "Code");
    assertStringIncludes(combined, "NDUZ-32AA");
    assertStringIncludes(combined, "╔");
    assertStringIncludes(combined, "╚");
    assertStringIncludes(
      combined,
      "Confirm this code matches in your browser before signing in.",
    );
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderAuthLoginSuccess json mode outputs valid JSON", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderAuthLoginSuccess(testData, "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.authenticated, true);
    assertEquals(parsed.username, "john");
    assertEquals(parsed.serverUrl, "https://swamp.club");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderAuthLoginSuccess log mode shows identity section", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderAuthLoginSuccess(testData, "log");
    const combined = stripAnsiCode(logs.join("\n"));
    assertStringIncludes(combined, "Authenticated");
    assertStringIncludes(combined, "@john");
    assertStringIncludes(combined, "John Watson");
    assertStringIncludes(combined, "john@example.com");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderAuthLoginSuccess log mode shows session section", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderAuthLoginSuccess(testData, "log");
    const combined = stripAnsiCode(logs.join("\n"));
    assertStringIncludes(combined, "https://swamp.club");
    assertStringIncludes(combined, "swamp_abc123");
    assertStringIncludes(combined, "•••");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderAuthLoginSuccess log mode uses double-line box drawing", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderAuthLoginSuccess(testData, "log");
    const combined = stripAnsiCode(logs.join("\n"));
    assertStringIncludes(combined, "╔");
    assertStringIncludes(combined, "╗");
    assertStringIncludes(combined, "╚");
    assertStringIncludes(combined, "╝");
    assertStringIncludes(combined, "║");
    assertStringIncludes(combined, "╠");
    assertStringIncludes(combined, "╣");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderAuthLoginSuccess log mode omits missing optional fields", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderAuthLoginSuccess({
      username: "anon",
      serverUrl: "https://swamp.club",
      apiKey: "swamp_shortkey",
    }, "log");
    const combined = stripAnsiCode(logs.join("\n"));
    assertStringIncludes(combined, "@anon");
    assertStringIncludes(combined, "Server");
    assertEquals(combined.includes("Name"), false);
    assertEquals(combined.includes("Email"), false);
  } finally {
    console.log = originalLog;
  }
});

Deno.test("renderAuthLoginSuccess masks long API keys", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    renderAuthLoginSuccess({
      ...testData,
      apiKey: "swamp_abcdefghijklmnopqrstuvwxyz",
    }, "log");
    const combined = stripAnsiCode(logs.join("\n"));
    // Shows first 12 chars
    assertStringIncludes(combined, "swamp_abcdef");
    // Shows last 4 chars
    assertStringIncludes(combined, "wxyz");
    // Has mask dots
    assertStringIncludes(combined, "•••");
    // Does NOT show the full key
    assertEquals(combined.includes("swamp_abcdefghijklmnopqrstuvwxyz"), false);
  } finally {
    console.log = originalLog;
  }
});
