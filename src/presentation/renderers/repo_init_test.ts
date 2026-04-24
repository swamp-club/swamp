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

import { assertEquals } from "@std/assert";
import type {
  ExtensionInstallEvent,
  RepoUpgradeEvent,
} from "../../libswamp/mod.ts";
import { createRepoUpgradeRenderer } from "./repo_init.ts";

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
          tool: "none",
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
          tool: "none",
        },
      },
    ]);

    const parsed = JSON.parse(output);
    assertEquals(parsed.extensionInstall, undefined);
  },
);
