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
import { setColorEnabled } from "@std/fmt/colors";
import {
  renderAutoResolveAlreadyInstalled,
  renderAutoResolveCollectiveNotTrusted,
  renderAutoResolveInstalled,
  renderAutoResolveInstalling,
  renderAutoResolveLocalSourceFailed,
  renderAutoResolveNetworkError,
  renderAutoResolveNoStableVersion,
  renderAutoResolveNotFound,
  renderAutoResolveSearching,
  renderAutoResolveTruncated,
} from "./extension_auto_resolve.ts";

function captureOutput(fn: () => void): string[] {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(
      args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
    );
  };
  setColorEnabled(false);
  try {
    fn();
  } finally {
    console.log = origLog;
    setColorEnabled(true);
  }
  return lines;
}

// --- log mode: info-level (non-failure) renderers ---

Deno.test("renderAutoResolveSearching: log mode shows Resolving", () => {
  const lines = captureOutput(() => {
    renderAutoResolveSearching("@acme/widget", "log");
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "Resolving");
  assertStringIncludes(output, "@acme/widget");
});

Deno.test("renderAutoResolveInstalling: log mode shows Installing", () => {
  const lines = captureOutput(() => {
    renderAutoResolveInstalling("@acme/widget", "1.2.0", "A widget", "log");
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "Installing");
  assertStringIncludes(output, "@acme/widget@1.2.0");
});

Deno.test("renderAutoResolveInstalled: log mode shows Installed", () => {
  const lines = captureOutput(() => {
    renderAutoResolveInstalled("@acme/widget", "1.2.0", 3, "log");
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "Installed");
  assertStringIncludes(output, "3 models registered");
});

// --- log mode: hard-failure renderers must show "Error" ---

Deno.test("renderAutoResolveNotFound: log mode shows Error not Warning", () => {
  const lines = captureOutput(() => {
    renderAutoResolveNotFound("@acme/widget", "log");
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "Error");
  assertEquals(output.includes("Warning"), false);
  assertStringIncludes(output, "no extension publishes this type");
  assertStringIncludes(output, "swamp extension pull");
});

Deno.test("renderAutoResolveAlreadyInstalled: log mode shows Error not Warning", () => {
  const lines = captureOutput(() => {
    renderAutoResolveAlreadyInstalled(
      "@acme/widget",
      "/path/to/widget",
      "log",
    );
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "Error");
  assertEquals(output.includes("Warning"), false);
  assertStringIncludes(output, "already installed at");
  assertStringIncludes(output, "failed to load");
  assertStringIncludes(output, 'swamp extension pull "@acme/widget" --force');
});

Deno.test("renderAutoResolveTruncated: log mode shows Error not Warning", () => {
  const lines = captureOutput(() => {
    renderAutoResolveTruncated(
      "@acme/widget",
      "/path/to/widget",
      ["file1.ts", "file2.ts"],
      "log",
    );
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "Error");
  assertEquals(output.includes("Warning"), false);
  assertStringIncludes(output, "incomplete");
  assertStringIncludes(output, "2 file(s)");
});

Deno.test("renderAutoResolveNetworkError: log mode shows Error not Warning", () => {
  const lines = captureOutput(() => {
    renderAutoResolveNetworkError("@acme/widget", "connection refused", "log");
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "Error");
  assertEquals(output.includes("Warning"), false);
  assertStringIncludes(output, "connection refused");
});

// --- log mode: soft-failure renderers remain Warning ---

Deno.test("renderAutoResolveCollectiveNotTrusted: log mode shows Warning", () => {
  const lines = captureOutput(() => {
    renderAutoResolveCollectiveNotTrusted("acme", "@acme/widget", "log");
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "Warning");
  assertStringIncludes(output, "not trusted");
  assertStringIncludes(output, "swamp extension trust add");
});

Deno.test("renderAutoResolveNoStableVersion: log mode shows Warning", () => {
  const lines = captureOutput(() => {
    renderAutoResolveNoStableVersion("@acme/widget", "log");
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "Warning");
  assertStringIncludes(output, "no stable version");
});

// --- JSON mode: all failure renderers emit status: "failed" ---

Deno.test("renderAutoResolveNotFound: json mode emits failed status", () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    renderAutoResolveNotFound("@acme/widget", "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.status, "failed");
    assertEquals(parsed.reason, "not_found");
  } finally {
    console.log = origLog;
  }
});

Deno.test("renderAutoResolveNetworkError: json mode emits failed status", () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    renderAutoResolveNetworkError("@acme/widget", "timeout", "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.status, "failed");
    assertEquals(parsed.reason, "network_error");
  } finally {
    console.log = origLog;
  }
});

Deno.test("renderAutoResolveAlreadyInstalled: json mode emits failed status", () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    renderAutoResolveAlreadyInstalled("@acme/widget", "/path", "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.status, "failed");
    assertEquals(parsed.reason, "already_installed");
  } finally {
    console.log = origLog;
  }
});

Deno.test("renderAutoResolveTruncated: json mode emits failed status", () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    renderAutoResolveTruncated("@acme/widget", "/path", ["a.ts"], "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.status, "failed");
    assertEquals(parsed.reason, "truncated");
  } finally {
    console.log = origLog;
  }
});

// --- renderAutoResolveLocalSourceFailed ---

Deno.test("renderAutoResolveLocalSourceFailed: log mode shows Error with doctor suggestion", () => {
  const lines = captureOutput(() => {
    renderAutoResolveLocalSourceFailed("@acme/widget", "log");
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "Error");
  assertStringIncludes(output, "local source extension failed to index");
  assertStringIncludes(output, "swamp doctor extensions");
});

Deno.test("renderAutoResolveLocalSourceFailed: json mode emits local_source_failed reason", () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    renderAutoResolveLocalSourceFailed("@acme/widget", "json");
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.status, "failed");
    assertEquals(parsed.reason, "local_source_failed");
    assertEquals(parsed.type, "@acme/widget");
  } finally {
    console.log = origLog;
  }
});
