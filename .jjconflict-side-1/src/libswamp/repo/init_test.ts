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
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  repoInit,
  type RepoInitDeps,
  type RepoInitEvent,
  repoUpgrade,
  type RepoUpgradeDeps,
  type RepoUpgradeEvent,
} from "./init.ts";

function makeInitDeps(
  overrides: Partial<RepoInitDeps> = {},
): RepoInitDeps {
  return {
    init: () =>
      Promise.resolve({
        path: "/repo",
        version: "1.0.0",
        initializedAt: "2026-01-01T00:00:00Z",
        skillsCopied: ["swamp-model", "swamp-workflow"],
        instructionsFileCreated: true,
        settingsCreated: true,
        gitignoreAction: "created",
        tool: "claude",
      }),
    ...overrides,
  };
}

function makeUpgradeDeps(
  overrides: Partial<RepoUpgradeDeps> = {},
): RepoUpgradeDeps {
  return {
    upgrade: () =>
      Promise.resolve({
        path: "/repo",
        previousVersion: "0.9.0",
        newVersion: "1.0.0",
        upgradedAt: "2026-01-01T00:00:00Z",
        skillsUpdated: ["swamp-model"],
        instructionsUpdated: true,
        settingsUpdated: false,
        gitignoreAction: "updated",
        tool: "claude",
      }),
    ...overrides,
  };
}

Deno.test("repoInit: yields completed on successful init", async () => {
  const deps = makeInitDeps();

  const events = await collect<RepoInitEvent>(
    repoInit(createLibSwampContext(), deps, {
      path: "/repo",
      force: false,
      tool: "claude",
      version: "1.0.0",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "initializing" });
  const completed = events[1] as Extract<
    RepoInitEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.path, "/repo");
  assertEquals(completed.data.version, "1.0.0");
  assertEquals(completed.data.skillsCopied, ["swamp-model", "swamp-workflow"]);
  assertEquals(completed.data.instructionsFileCreated, true);
  assertEquals(completed.data.settingsCreated, true);
  assertEquals(completed.data.gitignoreAction, "created");
  assertEquals(completed.data.tool, "claude");
});

Deno.test("repoUpgrade: yields completed on successful upgrade", async () => {
  const deps = makeUpgradeDeps();

  const events = await collect<RepoUpgradeEvent>(
    repoUpgrade(createLibSwampContext(), deps, {
      path: "/repo",
      version: "1.0.0",
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "upgrading" });
  const completed = events[1] as Extract<
    RepoUpgradeEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.path, "/repo");
  assertEquals(completed.data.previousVersion, "0.9.0");
  assertEquals(completed.data.newVersion, "1.0.0");
  assertEquals(completed.data.skillsUpdated, ["swamp-model"]);
  assertEquals(completed.data.instructionsUpdated, true);
  assertEquals(completed.data.settingsUpdated, false);
  assertEquals(completed.data.gitignoreAction, "updated");
  assertEquals(completed.data.tool, "claude");
});
