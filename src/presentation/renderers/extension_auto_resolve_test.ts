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
  renderAutoResolveInstalledWithoutType,
  renderAutoResolveInstalling,
  renderAutoResolveLegacyInstallation,
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

Deno.test("renderAutoResolveInstalling: log mode keeps a short description unchanged", () => {
  const lines = captureOutput(() => {
    renderAutoResolveInstalling("@acme/widget", "1.2.0", "A widget", "log");
  });
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0], "@acme/widget@1.2.0 (A widget)");
});

Deno.test("renderAutoResolveInstalling: log mode shows only the first line of a multi-line description", () => {
  const description = [
    "Manage widgets.",
    "Supports frobnication.",
    "",
    "## Usage",
    "",
    "```bash",
    "swamp model create @acme/widget w",
    "```",
  ].join("\n");
  const lines = captureOutput(() => {
    renderAutoResolveInstalling("@acme/widget", "1.2.0", description, "log");
  });
  assertEquals(lines.length, 1);
  assertEquals(lines[0].includes("\n"), false);
  assertStringIncludes(lines[0], "@acme/widget@1.2.0 (Manage widgets.)");
  assertEquals(lines[0].includes("Supports frobnication"), false);
  assertEquals(lines[0].includes("## Usage"), false);
});

Deno.test("renderAutoResolveInstalling: log mode skips leading blank lines and handles CRLF", () => {
  const lines = captureOutput(() => {
    renderAutoResolveInstalling(
      "@acme/widget",
      "1.2.0",
      "\r\n   \r\n  Manage widgets.  \r\nMore detail.\r\n",
      "log",
    );
  });
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0], "@acme/widget@1.2.0 (Manage widgets.)");
  assertEquals(lines[0].includes("\r"), false);
});

Deno.test("renderAutoResolveInstalling: log mode caps a long description with an ellipsis", () => {
  const lines = captureOutput(() => {
    renderAutoResolveInstalling(
      "@acme/widget",
      "1.2.0",
      "x".repeat(200),
      "log",
    );
  });
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0], `(${"x".repeat(79)}…)`);
  assertEquals(lines[0].includes("x".repeat(80)), false);
});

Deno.test("renderAutoResolveInstalling: log mode caps on code points without splitting a surrogate pair", () => {
  const lines = captureOutput(() => {
    renderAutoResolveInstalling(
      "@acme/widget",
      "1.2.0",
      "😀".repeat(100),
      "log",
    );
  });
  assertStringIncludes(lines[0], `(${"😀".repeat(79)}…)`);
});

Deno.test("renderAutoResolveInstalling: log mode omits the parentheses without a usable description", () => {
  for (const description of [undefined, "", "  \n\t\r\n  "]) {
    const lines = captureOutput(() => {
      renderAutoResolveInstalling("@acme/widget", "1.2.0", description, "log");
    });
    assertEquals(lines.length, 1);
    assertStringIncludes(lines[0], "@acme/widget@1.2.0");
    assertEquals(lines[0].includes("("), false);
  }
});

Deno.test("renderAutoResolveInstalling: json mode omits the description", () => {
  const lines = captureOutput(() => {
    renderAutoResolveInstalling(
      "@acme/widget",
      "1.2.0",
      "Manage widgets.\nMore detail.",
      "json",
    );
  });
  assertEquals(lines.length, 1);
  assertEquals(JSON.parse(lines[0]), {
    event: "auto_resolve",
    status: "installing",
    extension: "@acme/widget",
    version: "1.2.0",
  });
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

Deno.test("renderAutoResolveInstalledWithoutType: log mode names the newer version and update command", () => {
  const lines = captureOutput(() => {
    renderAutoResolveInstalledWithoutType(
      "@acme/send",
      "@acme/send-webhook",
      "2026.09.19.2",
      "2026.09.24.1",
      "log",
    );
  });
  const output = lines.join("\n");
  assertStringIncludes(
    output,
    "@acme/send@2026.09.19.2 is installed but does not provide @acme/send-webhook",
  );
  assertStringIncludes(output, "@acme/send@2026.09.24.1 is available");
  assertStringIncludes(output, "swamp extension update @acme/send");
  // swamp-club#2476: an install that loaded cleanly is not "failed to
  // load", and a destructive --force re-pull is not the fix.
  assertEquals(output.includes("failed to load"), false);
  assertEquals(output.includes("--force"), false);
});

Deno.test("renderAutoResolveInstalledWithoutType: log mode without a newer version points at search", () => {
  const lines = captureOutput(() => {
    renderAutoResolveInstalledWithoutType(
      "@acme/send",
      "@acme/send-webhook",
      "2026.09.24.1",
      undefined,
      "log",
    );
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "does not provide @acme/send-webhook");
  assertStringIncludes(output, "swamp extension search");
  assertEquals(output.includes("swamp extension update"), false);
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

Deno.test("renderAutoResolveLegacyInstallation: log mode requires an explicit pull", () => {
  const lines = captureOutput(() => {
    renderAutoResolveLegacyInstallation(
      "@acme/widget",
      [".claude/skills/widget"],
      "log",
    );
  });
  const output = lines.join("\n");
  assertStringIncludes(output, "Error");
  assertEquals(output.includes("Warning"), false);
  assertStringIncludes(output, "legacy file(s)");
  assertStringIncludes(output, "swamp extension pull @acme/widget");
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

Deno.test("renderAutoResolveInstalledWithoutType: json mode emits type_not_provided", () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    renderAutoResolveInstalledWithoutType(
      "@acme/send",
      "@acme/send-webhook",
      "2026.09.19.2",
      undefined,
      "json",
    );
    assertEquals(logs.length, 1);
    assertEquals(JSON.parse(logs[0]), {
      event: "auto_resolve",
      status: "failed",
      extension: "@acme/send",
      type: "@acme/send-webhook",
      reason: "type_not_provided",
      installedVersion: "2026.09.19.2",
      newerVersion: null,
    });
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

Deno.test("renderAutoResolveLegacyInstallation: json mode emits legacy paths", () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    renderAutoResolveLegacyInstallation(
      "@acme/widget",
      [".claude/skills/widget"],
      "json",
    );
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.status, "failed");
    assertEquals(parsed.reason, "legacy_on_disk");
    assertEquals(parsed.paths, [".claude/skills/widget"]);
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
