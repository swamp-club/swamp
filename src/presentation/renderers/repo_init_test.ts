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
import type {
  ExtensionInstallEvent,
  RepoInitEvent,
  RepoUpgradeEvent,
} from "../../libswamp/mod.ts";
import {
  createRepoInitRenderer,
  createRepoUpgradeRenderer,
} from "./repo_init.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

await initializeLogging({ noColor: true });

function makeInitData(tools: string[]) {
  return {
    path: "/tmp/test",
    version: "0.1.0",
    initializedAt: "2026-05-24T00:00:00Z",
    skillsCopied: [],
    instructionsFileCreated: true,
    settingsCreated: true,
    gitignoreAction: "created",
    tools,
    removedTools: [],
    tool: tools.length === 1 ? tools[0] : null,
  };
}

function captureLog(fn: () => void): string {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((m) => [m, console[m]] as const);
  for (const [m] of originals) {
    console[m] = (...args: unknown[]) => {
      lines.push(
        args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
      );
    };
  }
  try {
    fn();
  } finally {
    for (const [m, orig] of originals) {
      console[m] = orig;
    }
  }
  // deno-lint-ignore no-control-regex
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

function captureInitOutput(
  events: RepoInitEvent[],
  mode: "log" | "json",
): string {
  return captureLog(() => {
    const renderer = createRepoInitRenderer(mode);
    const handlers = renderer.handlers();
    for (const event of events) {
      switch (event.kind) {
        case "initializing":
          handlers.initializing?.(event);
          break;
        case "completed":
          handlers.completed?.(event);
          break;
        case "error":
          handlers.error?.(event);
          break;
      }
    }
  });
}

Deno.test(
  "LogRepoInitRenderer: shows claude-specific next step for claude tool",
  () => {
    const output = captureInitOutput([
      { kind: "initializing" },
      { kind: "completed", data: makeInitData(["claude"]) },
    ], "log");

    assertStringIncludes(output, "What's next:");
    assertStringIncludes(output, "/swamp-getting-started");
  },
);

Deno.test(
  "LogRepoInitRenderer: shows cursor-specific next step for cursor tool",
  () => {
    const output = captureInitOutput([
      { kind: "initializing" },
      { kind: "completed", data: makeInitData(["cursor"]) },
    ], "log");

    assertStringIncludes(output, "What's next:");
    assertStringIncludes(output, "Cursor");
  },
);

Deno.test(
  "LogRepoInitRenderer: shows multiple next steps for multi-tool init",
  () => {
    const output = captureInitOutput([
      { kind: "initializing" },
      { kind: "completed", data: makeInitData(["claude", "cursor"]) },
    ], "log");

    assertStringIncludes(output, "/swamp-getting-started");
    assertStringIncludes(output, "Cursor");
  },
);

Deno.test(
  "LogRepoInitRenderer: shows generic next step when no tools enrolled",
  () => {
    const output = captureInitOutput([
      { kind: "initializing" },
      { kind: "completed", data: makeInitData([]) },
    ], "log");

    assertStringIncludes(output, "swamp --help");
  },
);

Deno.test(
  "JsonRepoInitRenderer: includes nextSteps array in JSON output",
  () => {
    const output = captureInitOutput([
      { kind: "initializing" },
      { kind: "completed", data: makeInitData(["claude"]) },
    ], "json");

    const parsed = JSON.parse(output);
    assertEquals(Array.isArray(parsed.nextSteps), true);
    assertEquals(parsed.nextSteps.length, 1);
    assertStringIncludes(parsed.nextSteps[0], "/swamp-getting-started");
  },
);

Deno.test(
  "JsonRepoInitRenderer: includes generic nextStep when no tools enrolled",
  () => {
    const output = captureInitOutput([
      { kind: "initializing" },
      { kind: "completed", data: makeInitData([]) },
    ], "json");

    const parsed = JSON.parse(output);
    assertEquals(parsed.nextSteps.length, 1);
    assertStringIncludes(parsed.nextSteps[0], "swamp --help");
  },
);

/**
 * Runs a sequence of `RepoUpgradeEvent`s through the JSON renderer and
 * captures everything written to stdout. Used to assert the "exactly
 * one top-level JSON object per invocation" invariant.
 */
function captureStdout(
  events: RepoUpgradeEvent[],
): string {
  const originalLog = console.log;
  const chunks: string[] = [];
  console.log = (...args: unknown[]) => {
    chunks.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const renderer = createRepoUpgradeRenderer("json");
    const handlers = renderer.handlers();
    for (const event of events) {
      switch (event.kind) {
        case "upgrading":
          handlers.upgrading?.(event);
          break;
        case "extensions":
          handlers.extensions?.(event);
          break;
        case "completed":
          handlers.completed?.(event);
          break;
        case "error":
          handlers.error?.(event);
          break;
      }
    }
  } finally {
    console.log = originalLog;
  }
  return chunks.join("\n");
}

Deno.test(
  "JsonRepoUpgradeRenderer: emits exactly one top-level JSON object (no double-JSON)",
  () => {
    // Regression guard for the bug where delegating the `extensions`
    // envelope to JsonExtensionInstallRenderer emitted its own
    // `console.log(JSON.stringify(...))` mid-stream, then the upgrade's
    // `completed` handler emitted a second one. Downstream tools
    // parsing stdout as a single JSON document broke.
    const installCompleted: ExtensionInstallEvent = {
      kind: "completed",
      data: {
        entries: [
          { name: "@me/ext", version: "1.0.0", status: "migrated" },
        ],
        installed: 0,
        migrated: 1,
        upToDate: 0,
        failed: 0,
      },
    };
    const output = captureStdout([
      { kind: "upgrading" },
      { kind: "extensions", event: { kind: "resolving" } },
      {
        kind: "extensions",
        event: { kind: "migrating", name: "@me/ext", version: "1.0.0" },
      },
      { kind: "extensions", event: installCompleted },
      {
        kind: "completed",
        data: {
          path: "/tmp/x",
          previousVersion: "0.1.0",
          newVersion: "0.1.1",
          upgradedAt: "2026-04-24T00:00:00Z",
          skillsUpdated: [],
          instructionsUpdated: false,
          settingsUpdated: false,
          gitignoreAction: "unchanged",
          previousTools: [],
          tools: [],
          addedTools: [],
          removedTools: [],
          extensionsToReinstall: [],
          tool: null,
        },
      },
    ]);

    // Parsing the whole output must yield a single object.
    const parsed = JSON.parse(output);
    assertEquals(typeof parsed, "object");
    assertEquals(parsed.newVersion, "0.1.1");
    // The install summary is folded into the single output.
    assertEquals(parsed.extensionInstall.migrated, 1);
    assertEquals(parsed.extensionInstall.entries[0].name, "@me/ext");
  },
);

Deno.test(
  "JsonRepoUpgradeRenderer: omits extensionInstall when no install pass ran",
  () => {
    const output = captureStdout([
      { kind: "upgrading" },
      {
        kind: "completed",
        data: {
          path: "/tmp/x",
          previousVersion: "0.1.0",
          newVersion: "0.1.1",
          upgradedAt: "2026-04-24T00:00:00Z",
          skillsUpdated: [],
          instructionsUpdated: false,
          settingsUpdated: false,
          gitignoreAction: "unchanged",
          previousTools: [],
          tools: [],
          addedTools: [],
          removedTools: [],
          extensionsToReinstall: [],
          tool: null,
        },
      },
    ]);

    const parsed = JSON.parse(output);
    assertEquals(parsed.extensionInstall, undefined);
  },
);
