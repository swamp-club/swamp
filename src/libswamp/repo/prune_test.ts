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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import type { PrunePlan } from "../../domain/repo/tool_settings_pruner.ts";
import {
  repoPrune,
  type RepoPruneDeps,
  type RepoPruneEvent,
  repoPrunePreview,
} from "./prune.ts";

const PLAN: PrunePlan = {
  actions: [{
    tool: "claude",
    path: ".claude/settings.local.json",
    kind: "edit",
    removed: ["PostToolUse: swamp audit record --from-hook"],
    original: "{}",
    content: "{}\n",
  }],
  skipped: [{
    tool: "kiro",
    path: ".kiro/hooks",
    reason: "it is a symbolic link",
  }],
};

function makeDeps(overrides: Partial<RepoPruneDeps> = {}): {
  deps: RepoPruneDeps;
  calls: { find: string[][]; apply: number };
} {
  const calls = { find: [] as string[][], apply: 0 };
  const deps: RepoPruneDeps = {
    readEnrolledTools: () => Promise.resolve(["codex"]),
    find: (_root, tools) => {
      calls.find.push(tools);
      return Promise.resolve(PLAN);
    },
    apply: (_root, plan) => {
      calls.apply++;
      return Promise.resolve({ applied: plan.actions, skipped: plan.skipped });
    },
    ...overrides,
  };
  return { deps, calls };
}

function completedOf(events: RepoPruneEvent[]) {
  const last = events[events.length - 1];
  if (last.kind !== "completed") throw new Error(`got ${last.kind}`);
  return last.data;
}

Deno.test("repoPrune: dry run reports the plan without applying it", async () => {
  const { deps, calls } = makeDeps();
  const events = await collect<RepoPruneEvent>(
    repoPrune(createLibSwampContext(), deps, { path: "/repo", dryRun: true }),
  );
  const data = completedOf(events);
  assertEquals(calls.apply, 0);
  assertEquals(calls.find, [["codex"]]);
  assertEquals(data.dryRun, true);
  assertEquals(data.enrolledTools, ["codex"]);
  assertEquals(data.pruned, [{
    tool: "claude",
    path: ".claude/settings.local.json",
    action: "edit",
    removed: ["PostToolUse: swamp audit record --from-hook"],
  }]);
  assertEquals(data.skipped.length, 1);
});

Deno.test("repoPrune: applies the plan and reports what was removed", async () => {
  const { deps, calls } = makeDeps();
  const events = await collect<RepoPruneEvent>(
    repoPrune(createLibSwampContext(), deps, { path: "/repo", dryRun: false }),
  );
  assertEquals(events[0], { kind: "pruning" });
  const data = completedOf(events);
  assertEquals(calls.apply, 1);
  assertEquals(data.dryRun, false);
  assertEquals(data.pruned.map((p) => p.path), [".claude/settings.local.json"]);
});

Deno.test("repoPrune: applies a supplied preview without finding again", async () => {
  const { deps, calls } = makeDeps();
  const ctx = createLibSwampContext();
  const preview = await repoPrunePreview(ctx, deps, { path: "/repo" });
  assertEquals(calls.find.length, 1);
  const events = await collect<RepoPruneEvent>(
    repoPrune(ctx, deps, { path: "/repo", dryRun: false, preview: preview! }),
  );
  completedOf(events);
  assertEquals(calls.find.length, 1);
  assertEquals(calls.apply, 1);
});

Deno.test("repoPrune: an empty plan completes with nothing pruned", async () => {
  const { deps } = makeDeps({
    find: () => Promise.resolve({ actions: [], skipped: [] }),
  });
  const data = completedOf(
    await collect<RepoPruneEvent>(
      repoPrune(createLibSwampContext(), deps, {
        path: "/repo",
        dryRun: false,
      }),
    ),
  );
  assertEquals(data.pruned, []);
  assertEquals(data.skipped, []);
});

Deno.test("repoPrune: errors outside a swamp repository", async () => {
  const { deps, calls } = makeDeps({
    readEnrolledTools: () => Promise.resolve(null),
  });
  const events = await collect<RepoPruneEvent>(
    repoPrune(createLibSwampContext(), deps, { path: "/repo", dryRun: false }),
  );
  const last = events[events.length - 1];
  if (last.kind !== "error") throw new Error(`got ${last.kind}`);
  assertStringIncludes(last.error.message, "Not a swamp repository");
  assertEquals(calls.find.length, 0);
});

Deno.test("repoPrune: an apply failure becomes an error event", async () => {
  const { deps } = makeDeps({
    apply: () => Promise.reject(new Error("permission denied")),
  });
  const events = await collect<RepoPruneEvent>(
    repoPrune(createLibSwampContext(), deps, { path: "/repo", dryRun: false }),
  );
  const last = events[events.length - 1];
  if (last.kind !== "error") throw new Error(`got ${last.kind}`);
  assertStringIncludes(last.error.message, "permission denied");
});
