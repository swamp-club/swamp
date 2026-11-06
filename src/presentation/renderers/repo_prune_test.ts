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
  RepoPruneData,
  RepoPruneEvent,
} from "../../libswamp/repo/prune.ts";
import {
  createRepoPruneRenderer,
  renderRepoPrunePreview,
} from "./repo_prune.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";

await initializeLogging({ noColor: true });

function captureLog(fn: () => void): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  // deno-lint-ignore no-control-regex
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

function makeData(overrides: Partial<RepoPruneData> = {}): RepoPruneData {
  return {
    path: "/repo",
    dryRun: false,
    enrolledTools: ["codex"],
    pruned: [{
      tool: "claude",
      path: ".claude/settings.local.json",
      action: "edit",
      removed: ["PostToolUse: swamp audit record --from-hook"],
    }],
    skipped: [],
    ...overrides,
  };
}

function render(mode: "log" | "json", data: RepoPruneData): string {
  const event: RepoPruneEvent = { kind: "completed", data };
  return captureLog(() =>
    createRepoPruneRenderer(mode).handlers().completed(event)
  );
}

Deno.test("createRepoPruneRenderer: log mode lists each pruned file and what was removed", () => {
  const out = render("log", makeData());
  assertStringIncludes(out, "Pruned swamp settings for tools not enrolled");
  assertStringIncludes(out, "(enrolled: codex)");
  assertStringIncludes(out, ".claude/settings.local.json edited (claude)");
  assertStringIncludes(out, "PostToolUse: swamp audit record --from-hook");
});

Deno.test("createRepoPruneRenderer: log mode says what a dry run would do", () => {
  const out = render(
    "log",
    makeData({
      dryRun: true,
      pruned: [{
        tool: "kiro",
        path: ".kiro/agents/swamp.json",
        action: "delete",
        removed: ["swamp agent"],
      }],
    }),
  );
  assertStringIncludes(out, "Would prune swamp settings");
  assertStringIncludes(out, ".kiro/agents/swamp.json delete (kiro)");
});

Deno.test("createRepoPruneRenderer: log mode reports nothing to prune and skipped files", () => {
  const out = render(
    "log",
    makeData({
      enrolledTools: [],
      pruned: [],
      skipped: [{
        tool: "claude",
        path: ".claude/settings.local.json",
        reason: "it is a symbolic link",
      }],
    }),
  );
  assertStringIncludes(out, "No swamp settings to prune");
  assertStringIncludes(out, "(enrolled: none)");
  assertStringIncludes(out, "Skipped:");
  assertStringIncludes(
    out,
    ".claude/settings.local.json (claude) - it is a symbolic link",
  );
});

Deno.test("createRepoPruneRenderer: json mode prints the data object", () => {
  const data = makeData();
  assertEquals(JSON.parse(render("json", data)), data);
});

Deno.test("renderRepoPrunePreview: shows the plan in the future tense", () => {
  const data = makeData();
  const out = captureLog(() =>
    renderRepoPrunePreview({
      path: data.path,
      enrolledTools: data.enrolledTools,
      items: data.pruned,
      skipped: [],
      plan: { actions: [], skipped: [] },
    })
  );
  assertStringIncludes(out, "Will prune swamp settings");
  assertStringIncludes(out, ".claude/settings.local.json edit (claude)");
});
