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
        skillsCopied: ["swamp"],
        instructionsFileCreated: true,
        settingsCreated: true,
        gitignoreAction: "created",
        tools: ["claude"],
        removedTools: [],
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
        skillsUpdated: ["swamp"],
        instructionsUpdated: true,
        settingsUpdated: false,
        gitignoreAction: "updated",
        previousTools: ["claude"],
        tools: ["claude"],
        addedTools: [],
        removedTools: [],
        extensionsToReinstall: [],
        localSkillCopies: [],
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
      tools: ["claude"],
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
  assertEquals(completed.data.skillsCopied, ["swamp"]);
  assertEquals(completed.data.instructionsFileCreated, true);
  assertEquals(completed.data.settingsCreated, true);
  assertEquals(completed.data.gitignoreAction, "created");
  assertEquals(completed.data.tools, ["claude"]);
  assertEquals(completed.data.tool, "claude");
});

Deno.test('repoInit: legacy `tool` field returns "none" for empty tools (--tool none)', async () => {
  const deps = makeInitDeps({
    init: () =>
      Promise.resolve({
        path: "/repo",
        version: "1.0.0",
        initializedAt: "2026-01-01T00:00:00Z",
        skillsCopied: [],
        instructionsFileCreated: false,
        settingsCreated: false,
        gitignoreAction: "created",
        tools: [],
        removedTools: [],
      }),
  });

  const events = await collect<RepoInitEvent>(
    repoInit(createLibSwampContext(), deps, {
      path: "/repo",
      force: false,
      tools: [],
      version: "1.0.0",
    }),
  );

  const completed = events[1] as Extract<
    RepoInitEvent,
    { kind: "completed" }
  >;
  // `--tool none` users see `tool: "none"` matching what they passed,
  // preserving the legacy contract. Multi-tool returns `null` (next test).
  assertEquals(completed.data.tools, []);
  assertEquals(completed.data.tool, "none");
});

Deno.test("repoInit: legacy `tool` field returns null for multi-tool repos", async () => {
  const deps = makeInitDeps({
    init: () =>
      Promise.resolve({
        path: "/repo",
        version: "1.0.0",
        initializedAt: "2026-01-01T00:00:00Z",
        skillsCopied: [],
        instructionsFileCreated: true,
        settingsCreated: true,
        gitignoreAction: "created",
        tools: ["claude", "kiro"],
        removedTools: [],
      }),
  });

  const events = await collect<RepoInitEvent>(
    repoInit(createLibSwampContext(), deps, {
      path: "/repo",
      force: false,
      tools: ["claude", "kiro"],
      version: "1.0.0",
    }),
  );

  const completed = events[1] as Extract<
    RepoInitEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.data.tools, ["claude", "kiro"]);
  assertEquals(completed.data.tool, null);
});

Deno.test("repoInit: legacy `tool` input wraps into the tools array", async () => {
  let capturedOptions: { tools?: string[] } | undefined;
  const deps = makeInitDeps({
    init: (_repoPath, options) => {
      capturedOptions = options;
      return Promise.resolve({
        path: "/repo",
        version: "1.0.0",
        initializedAt: "2026-01-01T00:00:00Z",
        skillsCopied: [],
        instructionsFileCreated: true,
        settingsCreated: true,
        gitignoreAction: "created",
        tools: ["kiro"],
        removedTools: [],
      });
    },
  });

  await collect<RepoInitEvent>(
    repoInit(createLibSwampContext(), deps, {
      path: "/repo",
      force: false,
      tool: "kiro",
      version: "1.0.0",
    }),
  );

  assertEquals(capturedOptions?.tools, ["kiro"]);
});

Deno.test("repoInit: when both `tools` and `tool` are passed, `tools` wins", async () => {
  let capturedOptions: { tools?: string[] } | undefined;
  const deps = makeInitDeps({
    init: (_repoPath, options) => {
      capturedOptions = options;
      return Promise.resolve({
        path: "/repo",
        version: "1.0.0",
        initializedAt: "2026-01-01T00:00:00Z",
        skillsCopied: [],
        instructionsFileCreated: true,
        settingsCreated: true,
        gitignoreAction: "created",
        tools: ["claude", "kiro"],
        removedTools: [],
      });
    },
  });

  await collect<RepoInitEvent>(
    repoInit(createLibSwampContext(), deps, {
      path: "/repo",
      force: false,
      tools: ["claude", "kiro"],
      tool: "opencode",
      version: "1.0.0",
    }),
  );

  assertEquals(capturedOptions?.tools, ["claude", "kiro"]);
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
  assertEquals(completed.data.skillsUpdated, ["swamp"]);
  assertEquals(completed.data.instructionsUpdated, true);
  assertEquals(completed.data.settingsUpdated, false);
  assertEquals(completed.data.gitignoreAction, "updated");
  assertEquals(completed.data.tools, ["claude"]);
  assertEquals(completed.data.tool, "claude");
});
