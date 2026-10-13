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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { createLibSwampContext } from "../context.ts";
import type { AuthLoginEvent } from "../auth/login.ts";
import { BRIEF_HEADER, renderBrief } from "../../domain/start/brief.ts";
import { UserError } from "../../domain/errors.ts";
import type { HarnessLaunchSpec } from "../../domain/start/harness.ts";
import { StartSession } from "../../domain/start/start_session.ts";
import type { StartSessionRepository } from "../../domain/start/start_session_repository.ts";
import { StartTask } from "../../domain/start/start_task.ts";
import { parseWorkspaceName } from "../../domain/start/workspace_name.ts";
import type { LaunchOutcome } from "../../domain/start/terminal_launcher.ts";
import { StartSessionFileRepository } from "../../infrastructure/persistence/start_session_file_repository.ts";
import { WorkspaceRegistryFileRepository } from "../../infrastructure/persistence/workspace_registry_file_repository.ts";
import { assertPathEquals } from "../../infrastructure/persistence/path_test_helpers.ts";
import {
  buildStartStatus,
  buildUnboundStatus,
  expandHome,
  PICK_FOLDER_PROMPT,
  type SignedInState,
  startAddTools,
  startBack,
  startCheckFolder,
  startChooseHarness,
  type StartDeps,
  startImportWorkspace,
  startInspect,
  startLaunch,
  type StartLaunchEvent,
  startListHarnesses,
  startListTasks,
  startListWorkspaces,
  startOpenAgent,
  startOpenWorkspace,
  startPickFolder,
  startPrepare,
  type StartPrepareEvent,
  startResume,
  startSaveTask,
  startSignIn,
  type StartSignInEvent,
  type StartStatus,
  startStatus,
  type StartStatusEvent,
  startWorkspacePath,
} from "./start.ts";

const SIGNALS = { kubeconfig: true, awsConfig: false, gcloudAdc: false };
const SIGNED_IN: SignedInState = {
  kind: "signed_in",
  username: "ada",
  source: "file",
};

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  // The real path (macOS temp dirs sit behind /var -> /private/var), as
  // import registers folders by their real path.
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "swamp-start-libswamp-" }),
  );
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

interface Fakes {
  deps: StartDeps;
  signedIn: SignedInState;
  apiKeyFromEnv: boolean;
  repos: Set<string>;
  inits: string[];
  tools: Map<string, string[]>;
  setToolsCalls: Array<{ path: string; tools: string[] }>;
  onPath: Record<string, string[]>;
  opened: Array<{ spec: HarnessLaunchSpec; workspacePath: string }>;
  outcome: LaunchOutcome;
  briefs: Array<{ workspacePath: string; briefFile: string; content: string }>;
  /** The task `trustReady` (or `newTask`) created last. */
  taskId?: string;
  signInEvents: AuthLoginEvent[];
  /** Workspace paths another `swamp start` is serving. */
  running: Set<string>;
  random: () => number;
}

function makeFakes(dataDir: string, os = "darwin"): Fakes {
  let ids = 0;
  const f: Fakes = {
    deps: undefined as unknown as StartDeps,
    signedIn: SIGNED_IN,
    apiKeyFromEnv: false,
    repos: new Set(),
    inits: [],
    tools: new Map(),
    setToolsCalls: [],
    onPath: { claude: ["/usr/local/bin/claude"] },
    opened: [],
    outcome: {
      method: "macos_terminal",
      opened: true,
      command: "cd '/w' && 'claude'",
    },
    briefs: [],
    signInEvents: [],
    running: new Set(),
    random: () => 0,
  };
  f.deps = {
    dataDir,
    os,
    checkSignedIn: () => Promise.resolve(f.signedIn),
    apiKeyFromEnv: () => f.apiKeyFromEnv,
    repo: {
      isRepo: (path) => Promise.resolve(f.repos.has(path)),
      init: (path) => {
        f.inits.push(path);
        f.repos.add(path);
        f.tools.set(path, []);
        return Promise.resolve();
      },
      enrolledTools: (path) => Promise.resolve([...(f.tools.get(path) ?? [])]),
      setTools: (path, tools) => {
        f.setToolsCalls.push({ path, tools: [...tools] });
        f.tools.set(path, [...tools]);
        return Promise.resolve();
      },
    },
    sessions: new StartSessionFileRepository(),
    lookup: (name) => Promise.resolve(f.onPath[name] ?? []),
    terminalLauncher: {
      open: (spec, workspacePath) => {
        f.opened.push({ spec, workspacePath });
        return Promise.resolve(f.outcome);
      },
    },
    writeBrief: (workspacePath, briefFile, content) => {
      f.briefs.push({ workspacePath, briefFile, content });
      return Promise.resolve();
    },
    signals: () => Promise.resolve(SIGNALS),
    signIn: async function* () {
      for (const event of f.signInEvents) yield event;
    },
    now: () => new Date("2026-10-03T10:00:00.000Z"),
    randomUUID: () => `session-${++ids}`,
    random: () => f.random(),
    isRunning: (path) => Promise.resolve(f.running.has(path)),
    registry: new WorkspaceRegistryFileRepository(join(dataDir, ".config")),
  };
  return f;
}

const ctx = createLibSwampContext();

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function status(
  events: AsyncIterable<StartStatusEvent>,
): Promise<StartStatus> {
  const all = await collect(events);
  assertEquals(all.length, 1);
  const [event] = all;
  if (event.kind !== "completed") {
    throw new Error(`expected a status, got ${JSON.stringify(event)}`);
  }
  return event.data;
}

function lastOf<T extends { kind: string }>(events: T[]): T {
  return events[events.length - 1];
}

/** A workspace folder that is a repo, with a session at the trust step. */
async function trustReady(f: Fakes, harness = "claude"): Promise<string> {
  const ws = startWorkspacePath(f.deps.dataDir, "first-workspace");
  await Deno.mkdir(ws, { recursive: true });
  f.repos.add(ws);
  f.tools.set(ws, []);
  // Registered, as opening a workspace does, so trust can be recorded.
  await f.deps.registry.update((r) =>
    r.register({
      name: "first-workspace",
      path: ws,
      createdAt: "2026-10-11T00:00:00.000Z",
    })
  );
  const taskId = await newTask(f, ws, "list my pods");
  await status(
    startChooseHarness(ctx, f.deps, { workspacePath: ws, taskId, harness }),
  );
  return ws;
}

/** Saves a new task in the workspace; returns (and remembers) its id. */
async function newTask(f: Fakes, ws: string, text: string): Promise<string> {
  const s = await status(
    startSaveTask(ctx, f.deps, { workspacePath: ws, text }),
  );
  assert(s.taskId);
  f.taskId = s.taskId;
  return s.taskId;
}

// ---------------------------------------------------------------------------
// Workspace states
// ---------------------------------------------------------------------------

Deno.test("startWorkspacePath: is <dataDir>/workspaces/<name>", () => {
  assertPathEquals(
    startWorkspacePath("/data", "first-workspace"),
    join("/data", "workspaces", "first-workspace"),
  );
});

Deno.test("startPrepare: creates and inits the workspace when the folder is missing", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const events = await collect(
      startPrepare(ctx, f.deps, { workspaceName: "first-workspace" }),
    );
    const ws = join(dir, "workspaces", "first-workspace");
    assertEquals(events.map((e) => e.kind), [
      "signed_in_checked",
      "workspace_ready",
      "completed",
    ]);
    assertEquals(events[1], {
      kind: "workspace_ready",
      path: ws,
      created: true,
    });
    assertEquals(f.inits, [ws]);
    assert((await Deno.stat(ws)).isDirectory);
    const done = lastOf(events) as Extract<
      StartPrepareEvent,
      { kind: "completed" }
    >;
    // A new workspace has no tasks: it starts on writing one, and nothing
    // is saved until the task is.
    assertEquals(done.data.screen, "task");
    assertEquals(done.data.taskId, undefined);
    assertEquals(done.data.tasks, []);
    assertEquals(done.data.signedIn, "signed_in");
    assertEquals(done.data.username, "ada");
    assertEquals(await f.deps.sessions.list(ws), []);
  });
});

Deno.test("startPrepare: reuses a folder that is already a repo", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = join(dir, "workspaces", "first-workspace");
    await Deno.mkdir(ws, { recursive: true });
    await Deno.writeTextFile(join(ws, ".swamp.yaml"), "x: 1\n");
    f.repos.add(ws);
    const events = await collect(
      startPrepare(ctx, f.deps, { workspaceName: "first-workspace" }),
    );
    assertEquals(events[1], {
      kind: "workspace_ready",
      path: ws,
      created: false,
    });
    assertEquals(f.inits, []);
  });
});

Deno.test("startPrepare: inits an existing empty folder", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = join(dir, "workspaces", "first-workspace");
    await Deno.mkdir(ws, { recursive: true });
    const events = await collect(
      startPrepare(ctx, f.deps, { workspaceName: "first-workspace" }),
    );
    assertEquals(events[1], {
      kind: "workspace_ready",
      path: ws,
      created: true,
    });
    assertEquals(f.inits, [ws]);
  });
});

Deno.test("startPrepare: refuses a non-empty folder that is not a repo", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = join(dir, "workspaces", "first-workspace");
    await Deno.mkdir(ws, { recursive: true });
    await Deno.writeTextFile(join(ws, "notes.txt"), "mine");
    const events = await collect(
      startPrepare(ctx, f.deps, { workspaceName: "first-workspace" }),
    );
    const last = lastOf(events);
    assertEquals(last.kind, "error");
    assert(last.kind === "error");
    assertEquals(last.error.code, "not_a_workspace");
    assertStringIncludes(last.error.message, "isn't a Swamp workspace");
    assertEquals(f.inits, []);
    assertEquals(await Deno.readTextFile(join(ws, "notes.txt")), "mine");
  });
});

Deno.test("startPrepare: refuses an invalid workspace name", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const events = await collect(
      startPrepare(ctx, f.deps, { workspaceName: "../escape" }),
    );
    const last = lastOf(events);
    assert(last.kind === "error");
    assertEquals(last.error.code, "invalid_name");
    assertEquals(f.inits, []);
  });
});

Deno.test("startPrepare: opens on the workspace's newest task", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    const events = await collect(
      startPrepare(ctx, f.deps, { workspaceName: "first-workspace" }),
    );
    const done = lastOf(events) as Extract<
      StartPrepareEvent,
      { kind: "completed" }
    >;
    assertEquals(done.data.screen, "trust");
    assertEquals(done.data.taskId, f.taskId);
    assertEquals(done.data.task?.text, "list my pods");
    assertPathEquals(done.data.workspacePath ?? "", ws);
    assertEquals(done.data.workspaceName, "first-workspace");
  });
});

Deno.test("startPrepare: without a name only checks sign-in and reports the workspace screen", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const events = await collect(startPrepare(ctx, f.deps, {}));
    assertEquals(events, [
      { kind: "signed_in_checked", state: SIGNED_IN },
      {
        kind: "completed",
        data: {
          workspacePath: null,
          workspaceName: null,
          signedIn: "signed_in",
          username: "ada",
          screen: "workspace",
          trusted: false,
          canPickFolder: false,
          apiKeyFromEnv: false,
          signals: SIGNALS,
        },
      },
    ]);
    assertEquals(f.inits, []);
    const entries = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry.name);
    assertEquals(entries, []);
  });
});

Deno.test("startPrepare: without a name reports the blocked screen when sign-in is blocked", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    f.signedIn = { kind: "blocked", reason: "managed config" };
    const last = lastOf(await collect(startPrepare(ctx, f.deps, {})));
    assert(last.kind === "completed");
    assertEquals(last.data.screen, "blocked");
    assertEquals(last.data.blockedReason, "managed config");
    assertEquals(last.data.workspacePath, null);
  });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function sessionAt(
  step: "task" | "agent" | "trust" | "launched",
): StartSession {
  const session = StartSession.create("s", "/w", new Date(0));
  if (step === "task") return session;
  session.saveTask(StartTask.create("list pods"));
  if (step === "agent") return session;
  session.chooseHarness("claude");
  if (step === "trust") return session;
  session.confirmTrustAndRecordLaunch(
    { method: "copy_command", command: "cmd", opened: false },
    new Date(0),
  );
  return session;
}

Deno.test("buildStartStatus: a blocked sign-in shows the blocked screen at every step", () => {
  for (const step of ["task", "agent", "trust", "launched"] as const) {
    const s = buildStartStatus(
      "/w",
      sessionAt(step),
      { kind: "blocked", reason: "managed config" },
      false,
      SIGNALS,
    );
    assertEquals(s.screen, "blocked", step);
    assertEquals(s.blockedReason, "managed config");
    assertEquals(s.signedIn, "blocked");
  }
});

Deno.test("buildStartStatus: not signed in shows sign_in at every step", () => {
  const notSignedIn: SignedInState = { kind: "not_signed_in" };
  for (const step of ["task", "agent", "trust", "launched"] as const) {
    assertEquals(
      buildStartStatus("/w", sessionAt(step), notSignedIn, false, SIGNALS)
        .screen,
      "sign_in",
      step,
    );
  }
});

Deno.test("buildStartStatus: signed in shows the task's step, or a new task with none open", () => {
  for (const step of ["task", "agent", "trust", "launched"] as const) {
    assertEquals(
      buildStartStatus("/w", sessionAt(step), SIGNED_IN, false, SIGNALS).screen,
      step,
    );
  }
  const none = buildStartStatus("/w", null, SIGNED_IN, false, SIGNALS);
  assertEquals(none.screen, "task");
  assertEquals(none.taskId, undefined);
  assertEquals(none.task, undefined);
});

Deno.test("buildStartStatus: carries task, harness and launch without secrets", () => {
  const task = sessionAt("launched");
  task.assignBriefFile("tasks/1970-01-01-list-pods.md");
  const s = buildStartStatus("/w", task, SIGNED_IN, true, SIGNALS);
  assertEquals(s, {
    workspacePath: "/w",
    workspaceName: "w",
    signedIn: "signed_in",
    username: "ada",
    screen: "launched",
    taskId: "s",
    task: {
      text: "list pods",
      title: "list pods",
      createdAt: "1970-01-01T00:00:00.000Z",
      briefFile: "tasks/1970-01-01-list-pods.md",
    },
    harness: {
      id: "claude",
      displayName: "Claude Code",
      trustMode: "dialog",
      canResume: true,
    },
    launch: {
      method: "copy_command",
      command: "cmd",
      opened: false,
      at: s.launch!.at,
    },
    tools: ["claude"],
    trusted: false,
    canPickFolder: false,
    apiKeyFromEnv: true,
    signals: SIGNALS,
  });
});

Deno.test("buildUnboundStatus: asks for sign-in first, then reports the workspace screen", () => {
  assertEquals(buildUnboundStatus(SIGNED_IN, true, SIGNALS), {
    workspacePath: null,
    workspaceName: null,
    signedIn: "signed_in",
    username: "ada",
    screen: "workspace",
    trusted: false,
    canPickFolder: false,
    apiKeyFromEnv: true,
    signals: SIGNALS,
  });
  const notSignedIn = buildUnboundStatus(
    { kind: "not_signed_in" },
    false,
    SIGNALS,
  );
  assertEquals(notSignedIn.screen, "sign_in");
  assertEquals(notSignedIn.signedIn, "not_signed_in");
  assertEquals(notSignedIn.username, undefined);
});

Deno.test("buildUnboundStatus: a blocked sign-in shows the blocked screen", () => {
  const s = buildUnboundStatus(
    { kind: "blocked", reason: "managed config" },
    false,
    SIGNALS,
  );
  assertEquals(s.screen, "blocked");
  assertEquals(s.blockedReason, "managed config");
  assertEquals(s.workspacePath, null);
});

Deno.test("startStatus: with no workspace reports the unbound status and creates nothing", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const s = await status(startStatus(ctx, f.deps, { workspacePath: null }));
    assertEquals(s, buildUnboundStatus(SIGNED_IN, false, SIGNALS));
    f.signedIn = { kind: "blocked", reason: "policy" };
    assertEquals(
      (await status(startStatus(ctx, f.deps, { workspacePath: null }))).screen,
      "blocked",
    );
    const entries = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry.name);
    assertEquals(entries, []);
  });
});

Deno.test("startStatus: never writes, with or without a task open", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = join(dir, "ws");
    const s = await status(startStatus(ctx, f.deps, { workspacePath: ws }));
    assertEquals(s.screen, "task");
    assertEquals(s.tasks, []);
    assertEquals(await f.deps.sessions.list(ws), []);
    const [event] = await collect(
      startStatus(ctx, f.deps, { workspacePath: ws, taskId: "gone" }),
    );
    assert(event.kind === "error");
    assertEquals(event.error.code, "task_missing");
  });
});

Deno.test("startSaveTask: each new task is its own record with its own brief path", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = join(dir, "ws");
    const first = await status(
      startSaveTask(ctx, f.deps, { workspacePath: ws, text: "List my pods" }),
    );
    const second = await status(
      startSaveTask(ctx, f.deps, { workspacePath: ws, text: "List my pods" }),
    );
    assert(first.taskId && second.taskId && first.taskId !== second.taskId);
    assertEquals(first.screen, "agent");
    assertEquals(first.task?.briefFile, "tasks/2026-10-03-list-my-pods.md");
    assertEquals(second.task?.briefFile, "tasks/2026-10-03-list-my-pods-2.md");
    assertEquals(second.tasks?.map((t) => t.id).length, 2);
    assertEquals((await f.deps.sessions.list(ws)).length, 2);
  });
});

Deno.test("startSaveTask/startBack/startChooseHarness: walk one task's steps and persist each change", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    f.onPath["cursor-agent"] = ["/usr/local/bin/cursor-agent"];
    const ws = join(dir, "ws");
    const taskId = await newTask(f, ws, " t ");
    assertEquals(
      (await status(startBack(ctx, f.deps, { workspacePath: ws, taskId })))
        .screen,
      "task",
    );
    const edited = await status(
      startSaveTask(ctx, f.deps, { workspacePath: ws, taskId, text: "t2" }),
    );
    assertEquals(edited.taskId, taskId);
    assertEquals(edited.task?.text, "t2");
    // The brief path stays the one it got first.
    assertEquals(edited.task?.briefFile, "tasks/2026-10-03-t.md");
    const chosen = await status(
      startChooseHarness(ctx, f.deps, {
        workspacePath: ws,
        taskId,
        harness: "cursor",
      }),
    );
    assertEquals(chosen.screen, "trust");
    assertEquals(chosen.harness?.displayName, "Cursor");
    const reloaded = await f.deps.sessions.load(ws, taskId);
    assertEquals(reloaded?.step, "trust");
    assertEquals(reloaded?.harness, "cursor");
    assertEquals((await f.deps.sessions.list(ws)).length, 1);
  });
});

Deno.test("startSaveTask: a launched task's text can't change", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    await collect(
      startLaunch(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
    );
    const [event] = await collect(
      startSaveTask(ctx, f.deps, {
        workspacePath: ws,
        taskId: f.taskId!,
        text: "something else",
      }),
    );
    assertEquals(event.kind, "error");
    assertEquals(
      (await f.deps.sessions.load(ws, f.taskId!))?.task?.text,
      "list my pods",
    );
  });
});

Deno.test("startSaveTask: an empty task answers with an error and saves nothing", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = join(dir, "ws");
    const [event] = await collect(
      startSaveTask(ctx, f.deps, { workspacePath: ws, text: "  " }),
    );
    assertEquals(event.kind, "error");
    assertEquals(await f.deps.sessions.list(ws), []);
  });
});

Deno.test("startChooseHarness: refuses unknown and non-launchable harnesses", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = join(dir, "ws");
    const taskId = await newTask(f, ws, "t");
    for (const harness of ["emacs", "amp", "antigravity"]) {
      const [event] = await collect(
        startChooseHarness(ctx, f.deps, { workspacePath: ws, taskId, harness }),
      );
      assertEquals(event.kind, "error", harness);
    }
    assertEquals((await f.deps.sessions.load(ws, taskId))?.step, "agent");
  });
});

Deno.test("startChooseHarness: refuses a harness whose binary is not on PATH", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = join(dir, "ws");
    const taskId = await newTask(f, ws, "t");
    const [event] = await collect(
      startChooseHarness(ctx, f.deps, {
        workspacePath: ws,
        taskId,
        harness: "codex",
      }),
    );
    assert(event.kind === "error");
    assertStringIncludes(event.error.message, "isn't on your PATH");
    assertStringIncludes(event.error.message, "`codex`");
    const saved = await f.deps.sessions.load(ws, taskId);
    assertEquals(saved?.step, "agent");
    assertEquals(saved?.harness, undefined);
  });
});

Deno.test("startChooseHarness: remembers the agent picked, so the next new task in any workspace starts with it", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    f.onPath["cursor-agent"] = ["/usr/local/bin/cursor-agent"];
    const ws = join(dir, "ws");
    const first = await newTask(f, ws, "t");
    assertEquals(
      (await status(startStatus(ctx, f.deps, { workspacePath: ws })))
        .lastAgent,
      undefined,
    );
    await status(
      startChooseHarness(ctx, f.deps, {
        workspacePath: ws,
        taskId: first,
        harness: "cursor",
      }),
    );
    // A refused pick changes nothing.
    const second = await newTask(f, ws, "t2");
    await collect(
      startChooseHarness(ctx, f.deps, {
        workspacePath: ws,
        taskId: second,
        harness: "codex",
      }),
    );
    const other = join(dir, "other");
    const fresh = await status(
      startSaveTask(ctx, f.deps, { workspacePath: other, text: "t3" }),
    );
    assertEquals(fresh.screen, "agent");
    assertEquals(fresh.harness, undefined);
    assertEquals(fresh.lastAgent, "cursor");
  });
});

Deno.test("startBack: from the task step answers with a transition error", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = join(dir, "ws");
    const taskId = await newTask(f, ws, "t");
    await status(startBack(ctx, f.deps, { workspacePath: ws, taskId }));
    const [event] = await collect(
      startBack(ctx, f.deps, { workspacePath: ws, taskId }),
    );
    assert(event.kind === "error");
    assertStringIncludes(event.error.message, `"task"`);
  });
});

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

Deno.test("startListHarnesses: lists every harness in table order with whether it is on PATH", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    f.onPath = {
      "cursor-agent": ["/bin/cursor-agent"],
      amp: ["/bin/amp"],
      claude: ["/bin/claude"],
      codex: [],
    };
    const list = await startListHarnesses(ctx, f.deps);
    const missing = (
      id: string,
      displayName: string,
      binary: string,
      trustMode: "dialog" | "passed" | "unknown",
      launchable: boolean,
    ) => ({
      id,
      displayName,
      binary,
      binaryPath: null,
      found: false,
      trustMode,
      launchable,
    });
    assertEquals(list, [
      {
        id: "claude",
        displayName: "Claude Code",
        binary: "claude",
        binaryPath: "/bin/claude",
        found: true,
        trustMode: "dialog",
        launchable: true,
      },
      missing("codex", "Codex", "codex", "passed", true),
      {
        id: "cursor",
        displayName: "Cursor",
        binary: "cursor-agent",
        binaryPath: "/bin/cursor-agent",
        found: true,
        trustMode: "passed",
        launchable: true,
      },
      missing("opencode", "OpenCode", "opencode", "unknown", true),
      missing("copilot", "Copilot", "copilot", "unknown", true),
      missing("kiro", "Kiro", "kiro-cli", "unknown", true),
      missing("pi", "Pi", "pi", "unknown", true),
      {
        id: "amp",
        displayName: "Amp",
        binary: "amp",
        binaryPath: "/bin/amp",
        found: true,
        trustMode: "unknown",
        launchable: false,
      },
      missing("antigravity", "Antigravity", "agy", "unknown", false),
    ]);
  });
});

Deno.test("startListHarnesses: on Windows prefers the .cmd hit and reports codex as dialog", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir, "windows");
    f.onPath = { codex: ["C:\\npm\\codex", "C:\\npm\\codex.cmd"] };
    const codex = (await startListHarnesses(ctx, f.deps)).find((h) =>
      h.id === "codex"
    );
    assert(codex);
    assertEquals(codex.binaryPath, "C:\\npm\\codex.cmd");
    assertEquals(codex.found, true);
    assertEquals(codex.trustMode, "dialog");
  });
});

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

Deno.test("startLaunch: enrols the tool, writes the brief, opens the window and records the launch", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    f.tools.set(ws, ["codex"]);
    const events = await collect(
      startLaunch(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
    );
    assertEquals(events.map((e) => e.kind), [
      "checking",
      "enrolling",
      "brief_written",
      "window_opening",
      "launched",
      "completed",
    ]);
    assertEquals(f.setToolsCalls, [{ path: ws, tools: ["codex", "claude"] }]);
    assertEquals(f.briefs.length, 1);
    assert(f.briefs[0].content.startsWith(BRIEF_HEADER));
    assertStringIncludes(f.briefs[0].content, "list my pods");
    const written = events[2] as Extract<
      StartLaunchEvent,
      { kind: "brief_written" }
    >;
    assertPathEquals(
      written.path,
      join(ws, "tasks", "2026-10-03-list-my-pods.md"),
    );
    assertEquals(f.briefs[0].briefFile, "tasks/2026-10-03-list-my-pods.md");
    assertEquals(f.opened.length, 1);
    // The agent is told to read this task's brief.
    assertEquals(f.opened[0].spec.args, [
      "Read tasks/2026-10-03-list-my-pods.md and use the swamp-getting-started skill.",
    ]);
    assertEquals(f.opened[0].spec.binaryPath, "/usr/local/bin/claude");
    assertEquals(f.opened[0].spec.harness, "claude");
    const done = lastOf(events) as Extract<
      StartLaunchEvent,
      { kind: "completed" }
    >;
    assertEquals(done.data.screen, "launched");
    assertEquals(done.data.launch, {
      method: "macos_terminal",
      opened: true,
      command: f.outcome.command,
      at: done.data.launch!.at,
    });
    const saved = await f.deps.sessions.load(ws, f.taskId!);
    assertEquals(saved?.step, "launched");
    assert(saved?.trustConfirmedAt);
  });
});

Deno.test('startLaunch: "Launch again" is idempotent and keeps the tool list', async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    await collect(
      startLaunch(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
    );
    const again = await collect(
      startLaunch(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
    );
    assertEquals(lastOf(again).kind, "completed");
    assertEquals(f.tools.get(ws), ["claude"]);
    assertEquals(f.setToolsCalls.map((c) => c.tools), [["claude"], ["claude"]]);
    assertEquals(f.opened.length, 2);
    assertEquals(f.briefs[0].content, f.briefs[1].content);
    assertEquals((await f.deps.sessions.load(ws, f.taskId!))?.step, "launched");
  });
});

Deno.test("startLaunch: a launch that can't be recorded after the window opened still reports the agent as launched", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    const sessions = f.deps.sessions;
    const failingSave: StartSessionRepository = {
      list: (w) => sessions.list(w),
      load: (w, id) => sessions.load(w, id),
      migrateLegacy: (w) => sessions.migrateLegacy(w),
      reserveBriefFile: (w, createdAt, title) =>
        sessions.reserveBriefFile(w, createdAt, title),
      save: (task) =>
        task.step === "launched"
          ? Promise.reject(new Error("disk full"))
          : sessions.save(task),
    };
    const deps = { ...f.deps, sessions: failingSave };
    const events = await collect(
      startLaunch(ctx, deps, { workspacePath: ws, taskId: f.taskId! }),
    );
    assertEquals(events.map((e) => e.kind).slice(-2), [
      "launched",
      "completed",
    ]);
    assertEquals(f.opened.length, 1);
  });
});

Deno.test("startLaunch: refuses when not signed in, without touching anything", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    f.signedIn = { kind: "not_signed_in" };
    const events = await collect(
      startLaunch(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
    );
    const last = lastOf(events);
    assert(last.kind === "error");
    assertStringIncludes(last.error.message, "Sign in");
    assertEquals(f.setToolsCalls, []);
    assertEquals(f.briefs, []);
    assertEquals(f.opened, []);
    assertEquals((await f.deps.sessions.load(ws, f.taskId!))?.step, "trust");
  });
});

Deno.test("startLaunch: refuses when the harness binary is gone", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    f.onPath = {};
    const last = lastOf(
      await collect(
        startLaunch(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
      ),
    );
    assert(last.kind === "error");
    assertStringIncludes(last.error.message, "no longer on your PATH");
    assertEquals(f.opened, []);
  });
});

Deno.test("startLaunch: refuses before the trust step", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = join(dir, "ws");
    await newTask(f, ws, "t");
    const last = lastOf(
      await collect(
        startLaunch(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
      ),
    );
    assertEquals(last.kind, "error");
    assertEquals(f.opened, []);
  });
});

Deno.test("startLaunch: records a copy-command fallback", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    f.outcome = { method: "copy_command", opened: false, command: "paste me" };
    const last = lastOf(
      await collect(
        startLaunch(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
      ),
    );
    assert(last.kind === "completed");
    assertEquals(last.data.launch, {
      method: "copy_command",
      opened: false,
      command: "paste me",
      at: last.data.launch!.at,
    });
  });
});

// ---------------------------------------------------------------------------
// Several tasks
// ---------------------------------------------------------------------------

Deno.test("startLaunch: two tasks in one workspace each launch with their own brief", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    const first = f.taskId!;
    await collect(
      startLaunch(ctx, f.deps, { workspacePath: ws, taskId: first }),
    );
    const second = await newTask(f, ws, "Watch my queues");
    await status(
      startChooseHarness(ctx, f.deps, {
        workspacePath: ws,
        taskId: second,
        harness: "claude",
      }),
    );
    await collect(
      startLaunch(ctx, f.deps, { workspacePath: ws, taskId: second }),
    );
    assertEquals(f.briefs.map((b) => b.briefFile), [
      "tasks/2026-10-03-list-my-pods.md",
      "tasks/2026-10-03-watch-my-queues.md",
    ]);
    assertStringIncludes(f.opened[1].spec.args[0], "watch-my-queues");
    // The first task is untouched by the second.
    const one = await f.deps.sessions.load(ws, first);
    assertEquals(one?.task?.text, "list my pods");
    assertEquals(one?.step, "launched");
  });
});

Deno.test("startListTasks: every task, newest first by when it was created", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = join(dir, "ws");
    let now = new Date("2026-10-01T09:00:00.000Z");
    f.deps = { ...f.deps, now: () => now };
    const oldest = await newTask(f, ws, "Oldest task");
    now = new Date("2026-10-03T09:00:00.000Z");
    const newest = await newTask(f, ws, "Newest task");
    now = new Date("2026-10-02T09:00:00.000Z");
    const middle = await newTask(f, ws, "Middle task");
    const tasks = await startListTasks(ctx, f.deps, { workspacePath: ws });
    assertEquals(tasks.map((t) => t.id), [newest, middle, oldest]);
    assertEquals(tasks[0], {
      id: newest,
      title: "Newest task",
      step: "agent",
      harness: null,
      harnessDisplayName: null,
      createdAt: "2026-10-03T09:00:00.000Z",
      launchedAt: null,
      briefFile: "tasks/2026-10-03-newest-task.md",
    });
  });
});

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

Deno.test("startSignIn: never forwards the API key or email", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    f.signInEvents = [
      { kind: "opening_browser" },
      {
        kind: "device_verification",
        userCode: "ABCD-EFGH",
        verificationUri: "https://club/device",
        verificationUriComplete: "https://club/device?code=ABCD-EFGH",
      },
      { kind: "polling" },
      { kind: "securing_session" },
      {
        kind: "completed",
        data: {
          username: "ada",
          email: "ada@example.com",
          name: "Ada",
          serverUrl: "https://club",
          apiKey: "swamp_live_secret",
        },
      },
    ];
    const events = await collect(startSignIn(ctx, f.deps));
    assertEquals(
      events,
      [
        {
          kind: "device_verification",
          userCode: "ABCD-EFGH",
          verificationUri: "https://club/device",
          verificationUriComplete: "https://club/device?code=ABCD-EFGH",
        },
        { kind: "polling" },
        { kind: "securing_session" },
        { kind: "completed", username: "ada" },
      ] satisfies StartSignInEvent[],
    );
    const serialized = JSON.stringify(events);
    assert(!serialized.includes("swamp_live_secret"));
    assert(!serialized.includes("ada@example.com"));
  });
});

Deno.test("startSignIn: refuses when an API key comes from the environment", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    f.apiKeyFromEnv = true;
    let called = false;
    f.deps = {
      ...f.deps,
      signIn: async function* () {
        called = true;
        yield { kind: "polling" };
      },
    };
    const events = await collect(startSignIn(ctx, f.deps));
    assertEquals(events.length, 1);
    assertEquals(events[0].kind, "error");
    assertEquals(called, false);
  });
});

Deno.test("startSignIn: turns a thrown error into an error event", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    f.deps = {
      ...f.deps,
      // deno-lint-ignore require-yield
      signIn: async function* () {
        throw new Error("network down");
      },
    };
    assertEquals(await collect(startSignIn(ctx, f.deps)), [
      { kind: "error", message: "network down" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/** A workspace repo under the data dir whose `.swamp.yaml` has `mtime`. */
async function makeWorkspace(
  f: Fakes,
  name: string,
  mtime: Date,
): Promise<string> {
  const ws = startWorkspacePath(f.deps.dataDir, name);
  await Deno.mkdir(ws, { recursive: true });
  const marker = join(ws, ".swamp.yaml");
  await Deno.writeTextFile(marker, "x: 1\n");
  await Deno.utime(marker, mtime, mtime);
  f.repos.add(ws);
  f.tools.set(ws, []);
  return ws;
}

Deno.test("startListWorkspaces: with no workspaces folder returns none and a suggestion", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    assertEquals(await startListWorkspaces(ctx, f.deps), {
      workspaces: [],
      suggestedName: "amber-alligator",
    });
  });
});

Deno.test("startListWorkspaces: lists workspace repos newest first with their tasks", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const alpha = await makeWorkspace(
      f,
      "alpha",
      new Date("2026-01-01T00:00:00.000Z"),
    );
    const beta = await makeWorkspace(
      f,
      "beta",
      new Date("2026-01-01T00:00:00.000Z"),
    );
    // Made before the first registry write (picking an agent), as folders
    // from before the registry are: adoption only runs once.
    const gamma = await makeWorkspace(
      f,
      "gamma",
      new Date("2026-02-01T00:00:00.000Z"),
    );
    f.running.add(gamma);
    f.deps = { ...f.deps, now: () => new Date("2026-03-01T00:00:00.000Z") };
    const taskId = await newTask(f, beta, "list my pods");
    await status(
      startChooseHarness(ctx, f.deps, {
        workspacePath: beta,
        taskId,
        harness: "claude",
      }),
    );

    const { workspaces } = await startListWorkspaces(ctx, f.deps);
    assertEquals(workspaces.map((w) => w.name), ["beta", "gamma", "alpha"]);
    const [b, g, a] = workspaces;
    assertPathEquals(b.path, beta);
    assertEquals(b, {
      name: "beta",
      path: b.path,
      step: "trust",
      taskTitle: "list my pods",
      harness: "claude",
      harnessDisplayName: "Claude Code",
      tasks: [{
        id: taskId,
        title: "list my pods",
        step: "trust",
        harness: "claude",
        harnessDisplayName: "Claude Code",
        createdAt: "2026-03-01T00:00:00.000Z",
        launchedAt: null,
        briefFile: "tasks/2026-03-01-list-my-pods.md",
      }],
      enrolledTools: b.enrolledTools,
      createdAt: null,
      updatedAt: "2026-03-01T00:00:00.000Z",
      running: false,
      imported: false,
    });
    assertPathEquals(g.path, gamma);
    assertEquals(g.running, true);
    assertEquals(g.step, null);
    assertEquals(g.taskTitle, null);
    assertEquals(g.harness, null);
    assertEquals(g.harnessDisplayName, null);
    assertEquals(g.updatedAt, "2026-02-01T00:00:00.000Z");
    assertPathEquals(a.path, alpha);
    assertEquals(a.updatedAt, "2026-01-01T00:00:00.000Z");
    assertEquals(a.running, false);
  });
});

Deno.test("startListWorkspaces: skips folders that are not repos and loose files", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    await makeWorkspace(f, "real", new Date("2026-01-01T00:00:00.000Z"));
    const stray = join(dir, "workspaces", "stray");
    await Deno.mkdir(stray);
    await Deno.writeTextFile(join(stray, "notes.txt"), "mine");
    await Deno.writeTextFile(join(dir, "workspaces", "loose.txt"), "x");
    const { workspaces } = await startListWorkspaces(ctx, f.deps);
    assertEquals(workspaces.map((w) => w.name), ["real"]);
    assertEquals(f.inits, []);
  });
});

Deno.test("startListWorkspaces: the suggestion avoids every existing folder name", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    // random() = 0 always draws "amber-alligator".
    await makeWorkspace(
      f,
      "amber-alligator",
      new Date("2026-01-01T00:00:00.000Z"),
    );
    // A folder that is not a repo still takes its name.
    await Deno.mkdir(join(dir, "workspaces", "amber-alligator-2"));
    const { suggestedName } = await startListWorkspaces(ctx, f.deps);
    assertEquals(suggestedName, "amber-alligator-3");
  });
});

// ---------------------------------------------------------------------------
// Inspect
// ---------------------------------------------------------------------------

Deno.test("startInspect: reports no workspaces without creating anything", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const result = await startInspect(ctx, f.deps, {
      workspaceName: "first-workspace",
    });
    assertEquals(result.signedIn, "signed_in");
    assertEquals(result.workspaces, []);
    assertEquals(result.agents.length, 9);
    assertEquals(f.inits, []);
    const entries = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry.name);
    assertEquals(entries, []);
  });
});

Deno.test("startInspect: reports the sessions, agents and an unknown sign-in state on failure", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    f.running.add(ws);
    f.deps = {
      ...f.deps,
      checkSignedIn: () => Promise.reject(new Error("offline")),
    };
    const result = await startInspect(ctx, f.deps, {});
    assertEquals(result.signedIn, "unknown");
    assertEquals(result.workspaces.length, 1);
    const [summary] = result.workspaces;
    assertEquals(summary.name, "first-workspace");
    assertEquals(summary.running, true);
    assertEquals(summary.step, "trust");
    assertEquals(summary.taskTitle, "list my pods");
    assertEquals(summary.harness, "claude");
    const claude = result.agents.find((a) => a.id === "claude");
    assertEquals(claude?.found, true);
    assertEquals(result.agents.filter((a) => a.found).length, 1);
  });
});

Deno.test("startInspect: filters the workspaces by name", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    await makeWorkspace(f, "alpha", new Date("2026-01-01T00:00:00.000Z"));
    await makeWorkspace(f, "beta", new Date("2026-02-01T00:00:00.000Z"));
    const all = await startInspect(ctx, f.deps, {});
    assertEquals(all.workspaces.map((w) => w.name), ["beta", "alpha"]);
    const one = await startInspect(ctx, f.deps, { workspaceName: "alpha" });
    assertEquals(one.workspaces.map((w) => w.name), ["alpha"]);
    const none = await startInspect(ctx, f.deps, { workspaceName: "gamma" });
    assertEquals(none.workspaces, []);
  });
});

Deno.test("startResume: reopens the launched agent with --continue and leaves the brief alone", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    await collect(
      startLaunch(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
    );
    const events = await collect(
      startResume(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
    );
    assertEquals(events.map((e) => e.kind), [
      "checking",
      "enrolling",
      "window_opening",
      "launched",
      "completed",
    ]);
    assertEquals(f.briefs.length, 1);
    assertEquals(f.opened.length, 2);
    assertEquals(f.opened[1].spec.args, ["--continue"]);
    const done = lastOf(events);
    assert(done.kind === "completed");
    assertEquals(done.data.harness?.canResume, true);
    assertEquals(done.data.contents, {
      models: 0,
      workflows: 0,
      modelList: [],
      workflowList: [],
    });
  });
});

Deno.test("startResume: refuses a task that hasn't been launched", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    const events = await collect(
      startResume(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
    );
    const last = lastOf(events);
    assert(last.kind === "error");
    assertEquals(f.opened.length, 0);
  });
});

Deno.test("startChooseHarness: sets the workspace up for extra tools, harness first", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    await status(
      startBack(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
    );
    const chosen = await status(
      startChooseHarness(ctx, f.deps, {
        workspacePath: ws,
        taskId: f.taskId!,
        harness: "claude",
        tools: ["kiro", "claude", "codex"],
      }),
    );
    assertEquals(chosen.tools, ["claude", "kiro", "codex"]);
    await collect(
      startLaunch(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
    );
    assertEquals(f.tools.get(ws), ["claude", "kiro", "codex"]);
    assertEquals(f.opened.at(-1)?.spec.harness, "claude");
  });
});

Deno.test("startChooseHarness: refuses an unknown extra tool", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    await status(
      startBack(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
    );
    const events = await collect(
      startChooseHarness(ctx, f.deps, {
        workspacePath: ws,
        taskId: f.taskId!,
        harness: "claude",
        tools: ["emacs"],
      }),
    );
    assertEquals(lastOf(events).kind, "error");
  });
});

Deno.test("startLaunch: keeps tools the workspace is already set up for", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    f.tools.set(ws, ["copilot"]);
    await collect(
      startLaunch(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
    );
    assertEquals(f.tools.get(ws), ["copilot", "claude"]);
  });
});

Deno.test("startAddTools: sets the workspace up for more agents without removing any", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    f.tools.set(ws, ["claude"]);
    const s = await status(
      startAddTools(ctx, f.deps, {
        workspacePath: ws,
        tools: ["codex", "claude", "kiro"],
      }),
    );
    assertEquals(f.tools.get(ws), ["claude", "codex", "kiro"]);
    assertEquals(s.enrolledTools, ["claude", "codex", "kiro"]);
    const bad = await collect(
      startAddTools(ctx, f.deps, { workspacePath: ws, tools: ["emacs"] }),
    );
    assertEquals(lastOf(bad).kind, "error");
  });
});

Deno.test("startOpenAgent: opens a fresh session for an agent new to the workspace, and resumes one used before", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir, "darwin");
    const ws = await trustReady(f);
    await collect(
      startLaunch(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
    );
    f.onPath["codex"] = ["/usr/local/bin/codex"];

    await collect(
      startOpenAgent(ctx, f.deps, { workspacePath: ws, harness: "codex" }),
    );
    const codex = f.opened.at(-1)!.spec;
    assertEquals(codex.harness, "codex");
    assert(!codex.args.includes("resume"));
    assert(f.tools.get(ws)!.includes("codex"));

    await collect(
      startOpenAgent(ctx, f.deps, { workspacePath: ws, harness: "claude" }),
    );
    assertEquals(f.opened.at(-1)!.spec.args, ["--continue"]);
    // No task went to either window, and the session is untouched.
    assertEquals(f.briefs.length, 1);
    assertEquals(
      (await f.deps.sessions.load(ws, f.taskId!))?.harness,
      "claude",
    );
  });
});

Deno.test("startListWorkspaces: adopts existing workspace folders into the registry on first read", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = join(dir, "workspaces", "old-one");
    await Deno.mkdir(ws, { recursive: true });
    f.repos.add(ws);
    const { workspaces } = await startListWorkspaces(ctx, f.deps);
    assertEquals(workspaces.map((w) => w.name), ["old-one"]);
    const saved = await f.deps.registry.load();
    assertEquals(saved?.get("old-one")?.path, ws);
  });
});

Deno.test("startPickFolder: needs a sign-in and a chooser, and answers the chosen folder", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const prompts: string[] = [];
    let chosen: string | null = "/Users/ada/code/infra";
    let available = true;
    const deps: StartDeps = {
      ...f.deps,
      folderPicker: {
        available: () => Promise.resolve(available),
        pick: (prompt) => {
          prompts.push(prompt);
          return Promise.resolve(chosen);
        },
      },
    };

    assertEquals(await startPickFolder(ctx, deps), {
      path: "/Users/ada/code/infra",
    });
    assertEquals(prompts, [PICK_FOLDER_PROMPT]);
    chosen = null;
    assertEquals(await startPickFolder(ctx, deps), { path: null });

    const statusEvents = await collect(
      startStatus(ctx, deps, { workspacePath: null }),
    );
    const status = statusEvents.at(-1) as { kind: string; data: StartStatus };
    assertEquals(status.data.canPickFolder, true);

    available = false;
    const unavailable = await assertRejects(
      () => startPickFolder(ctx, deps),
      UserError,
    );
    assertEquals(unavailable.code, "picker_unavailable");
    assertEquals(
      await assertRejects(
        () => startPickFolder(ctx, f.deps),
        UserError,
      ).then((e) => e.code),
      "picker_unavailable",
    );

    f.signedIn = { kind: "not_signed_in" };
    available = true;
    const refused = await assertRejects(
      () => startPickFolder(ctx, deps),
      UserError,
    );
    assertEquals(refused.code, "not_signed_in");
    assertEquals(prompts.length, 2);
  });
});

Deno.test("startCheckFolder: ticks a swamp repo, says why it can't import anything else, and names a registered one", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const repo = join(dir, "code", "infra");
    const plain = join(dir, "code", "notes");
    await Deno.mkdir(repo, { recursive: true });
    await Deno.mkdir(plain, { recursive: true });
    f.repos.add(repo);

    assertEquals(await startCheckFolder(ctx, f.deps, { path: repo }), {
      ok: true,
      path: repo,
    });
    const missing = await startCheckFolder(ctx, f.deps, {
      path: join(dir, "nope"),
    });
    assertEquals(missing.ok ? null : missing.code, "not_found");
    const notRepo = await startCheckFolder(ctx, f.deps, { path: plain });
    assertEquals(notRepo.ok ? null : notRepo.code, "not_a_repo");

    // Checking reads only: nothing was registered.
    assertEquals(await f.deps.registry.load(), null);

    await startImportWorkspace(ctx, f.deps, { path: repo });
    assertEquals(await startCheckFolder(ctx, f.deps, { path: repo }), {
      ok: true,
      path: repo,
      registeredAs: "infra",
    });

    f.signedIn = { kind: "not_signed_in" };
    const error = await assertRejects(
      () => startCheckFolder(ctx, f.deps, { path: repo }),
      UserError,
    );
    assertEquals(error.code, "not_signed_in");
  });
});

Deno.test("startImportWorkspace: registers a repo where it is, and it opens by name", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const project = join(dir, "code", "My Infra");
    await Deno.mkdir(project, { recursive: true });
    f.repos.add(project);

    const imported = await startImportWorkspace(ctx, f.deps, { path: project });
    assertEquals(imported, { name: "my-infra", path: project });

    const again = await startImportWorkspace(ctx, f.deps, { path: project });
    assertEquals(again.name, "my-infra");

    const { workspaces } = await startListWorkspaces(ctx, f.deps);
    const listed = workspaces.find((w) => w.name === "my-infra")!;
    assertEquals(listed.imported, true);
    assertEquals(listed.path, project);

    const events = await collect(
      startPrepare(ctx, f.deps, { workspaceName: "my-infra" }),
    );
    assertEquals(events[1], {
      kind: "workspace_ready",
      path: project,
      created: false,
    });
    assertEquals(f.inits, []);
  });
});

Deno.test("startImportWorkspace: a taken long name gets a suffix that stays a valid name", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const first = join(dir, "a", "x".repeat(70));
    const second = join(dir, "b", "x".repeat(70));
    for (const p of [first, second]) {
      await Deno.mkdir(p, { recursive: true });
      f.repos.add(p);
    }
    const one = await startImportWorkspace(ctx, f.deps, { path: first });
    const two = await startImportWorkspace(ctx, f.deps, { path: second });
    assertEquals(one.name, "x".repeat(63));
    assertEquals(two.name, `${"x".repeat(61)}-2`);
    assertEquals(parseWorkspaceName(two.name), two.name);
  });
});

Deno.test("startImportWorkspace: refuses a missing folder or one that isn't a swamp repo", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const plain = join(dir, "plain");
    await Deno.mkdir(plain);
    for (
      const [path, code] of [[join(dir, "nope"), "not_found"], [
        plain,
        "not_a_repo",
      ]]
    ) {
      try {
        await startImportWorkspace(ctx, f.deps, { path });
        throw new Error("expected a refusal");
      } catch (error) {
        assertEquals((error as { code?: string }).code, code);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Sign-in first
// ---------------------------------------------------------------------------

function errorCode(events: Array<{ kind: string }>): string | undefined {
  const last = lastOf(events) as { kind: string; error?: { code: string } };
  return last.kind === "error" ? last.error?.code : undefined;
}

Deno.test("start operations that write refuse when not signed in or blocked, and change nothing", async () => {
  for (
    const [state, code] of [
      [{ kind: "not_signed_in" }, "not_signed_in"],
      [{ kind: "blocked", reason: "Your API key was revoked." }, "blocked"],
    ] as const
  ) {
    await withTempDir(async (dir) => {
      const f = makeFakes(dir);
      const ws = await trustReady(f);
      const project = join(dir, "project");
      await Deno.mkdir(project);
      f.repos.add(project);
      const before = (await f.deps.sessions.load(ws, f.taskId!))!.toData();
      f.signedIn = state;
      const p = { workspacePath: ws, taskId: f.taskId! };
      const taskCount = (await f.deps.sessions.list(ws)).length;
      const results: Array<[string, Array<{ kind: string }>]> = [
        [
          "open",
          await collect(
            startOpenWorkspace(ctx, f.deps, { workspaceName: "new-one" }),
          ),
        ],
        [
          "open existing",
          await collect(
            startOpenWorkspace(ctx, f.deps, {
              workspaceName: "first-workspace",
            }),
          ),
        ],
        [
          "prepare",
          await collect(
            startPrepare(ctx, f.deps, { workspaceName: "new-one" }),
          ),
        ],
        [
          "save",
          await collect(startSaveTask(ctx, f.deps, { ...p, text: "x" })),
        ],
        [
          "save new",
          await collect(
            startSaveTask(ctx, f.deps, { workspacePath: ws, text: "x" }),
          ),
        ],
        [
          "choose",
          await collect(
            startChooseHarness(ctx, f.deps, { ...p, harness: "claude" }),
          ),
        ],
        [
          "add tools",
          await collect(startAddTools(ctx, f.deps, { ...p, tools: ["codex"] })),
        ],
        ["launch", await collect(startLaunch(ctx, f.deps, p))],
        [
          "agent",
          await collect(
            startOpenAgent(ctx, f.deps, { ...p, harness: "claude" }),
          ),
        ],
      ];
      for (const [name, events] of results) {
        assertEquals(errorCode(events), code, name);
      }
      const error = await assertRejects(
        () => startImportWorkspace(ctx, f.deps, { path: project }),
        UserError,
      );
      assertEquals((error as UserError).code, code);
      assertEquals(f.inits, []);
      assertEquals(f.setToolsCalls, []);
      assertEquals(f.opened, []);
      assertEquals(
        (await f.deps.sessions.load(ws, f.taskId!))!.toData(),
        before,
      );
      assertEquals((await f.deps.sessions.list(ws)).length, taskCount);
      assertEquals((await f.deps.registry.load())?.get("project"), undefined);
    });
  }
});

Deno.test("startOpenWorkspace: a blocked error carries the reason", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    f.signedIn = { kind: "blocked", reason: "Your API key was revoked." };
    const events = await collect(
      startOpenWorkspace(ctx, f.deps, { workspaceName: "w" }),
    );
    const last = lastOf(events);
    assert(last.kind === "error");
    assertEquals(last.error.message, "Your API key was revoked.");
  });
});

// ---------------------------------------------------------------------------
// Briefs, imported workspaces and the registry
// ---------------------------------------------------------------------------

Deno.test("startLaunch: refuses a file at the brief's path swamp didn't write and leaves it untouched", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    const brief = join(ws, "tasks", "2026-10-03-list-my-pods.md");
    await Deno.mkdir(join(ws, "tasks"));
    await Deno.writeTextFile(brief, "my own task list");
    const events = await collect(
      startLaunch(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
    );
    assertEquals(errorCode(events), "task_file_exists");
    assertEquals(await Deno.readTextFile(brief), "my own task list");
    assertEquals(f.briefs, []);
    assertEquals(f.setToolsCalls, []);
    assertEquals(f.opened, []);
    assertEquals((await f.deps.sessions.load(ws, f.taskId!))?.step, "trust");
  });
});

Deno.test("startLaunch: replaces a brief swamp wrote", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    await Deno.mkdir(join(ws, "tasks"));
    await Deno.writeTextFile(
      join(ws, "tasks", "2026-10-03-list-my-pods.md"),
      `${BRIEF_HEADER}\nold`,
    );
    const events = await collect(
      startLaunch(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
    );
    assertEquals(lastOf(events).kind, "completed");
    assertEquals(f.briefs.length, 1);
  });
});

Deno.test("startLaunch: the brief describes a created workspace and an imported one differently", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    await collect(
      startLaunch(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
    );
    assertStringIncludes(f.briefs[0].content, "it holds only Swamp's files.");

    const project = join(dir, "code", "app");
    await Deno.mkdir(project, { recursive: true });
    f.repos.add(project);
    f.tools.set(project, []);
    await startImportWorkspace(ctx, f.deps, { path: project });
    const taskId = await newTask(f, project, "list pods");
    await status(
      startChooseHarness(ctx, f.deps, {
        workspacePath: project,
        taskId,
        harness: "claude",
      }),
    );
    await collect(startLaunch(ctx, f.deps, { workspacePath: project, taskId }));
    const brief = f.briefs[1].content;
    assertStringIncludes(brief, "the user's existing project");
    assert(!brief.includes("only Swamp's files"));
  });
});

Deno.test("startOpenWorkspace: refuses an imported workspace whose folder is gone, creating nothing", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const project = join(dir, "code", "app");
    await Deno.mkdir(project, { recursive: true });
    f.repos.add(project);
    await startImportWorkspace(ctx, f.deps, { path: project });
    f.repos.delete(project);
    await Deno.remove(project);

    const events = await collect(
      startOpenWorkspace(ctx, f.deps, { workspaceName: "app" }),
    );
    assertEquals(errorCode(events), "workspace_missing");
    const last = lastOf(events);
    assert(last.kind === "error");
    assertStringIncludes(last.error.message, project);
    assertEquals(f.inits, []);
    await assertRejects(() => Deno.stat(project));
  });
});

Deno.test("startOpenWorkspace: refuses an unreadable registry without overwriting it", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const file = join(dir, ".config", "workspaces.json");
    await Deno.mkdir(join(dir, ".config"));
    const content = JSON.stringify({ schemaVersion: 9, workspaces: [] });
    await Deno.writeTextFile(file, content);
    const events = await collect(
      startOpenWorkspace(ctx, f.deps, { workspaceName: "w" }),
    );
    assertEquals(errorCode(events), "registry_unreadable");
    assertEquals(await Deno.readTextFile(file), content);
    assertEquals(f.inits, []);
  });
});

Deno.test({
  name: "startImportWorkspace: a symlinked path registers the real folder once",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const f = makeFakes(dir);
      const project = join(dir, "code", "app");
      await Deno.mkdir(project, { recursive: true });
      const link = join(dir, "link");
      await Deno.symlink(project, link, { type: "dir" });
      f.repos.add(project);
      f.repos.add(link);

      const viaLink = await startImportWorkspace(ctx, f.deps, { path: link });
      assertEquals(viaLink, { name: "app", path: project });
      const viaReal = await startImportWorkspace(ctx, f.deps, {
        path: project,
      });
      assertEquals(viaReal, { name: "app", path: project });
      const again = await startImportWorkspace(ctx, f.deps, { path: link });
      assertEquals(again.name, "app");
      assertEquals(
        (await f.deps.registry.load())?.list().map((e) => e.path),
        [project],
      );
    });
  },
});

Deno.test("startImportWorkspace: expands ~ to the home folder", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const project = join(dir, "code", "app");
    await Deno.mkdir(project, { recursive: true });
    f.repos.add(project);
    const imported = await startImportWorkspace(
      ctx,
      { ...f.deps, homeDir: dir },
      { path: "~/code/app" },
    );
    assertEquals(imported.path, project);
  });
});

Deno.test("expandHome: expands ~, ~/ and (on Windows) ~\\ only", () => {
  assertEquals(expandHome("~", "/home/u", "linux"), "/home/u");
  assertPathEquals(
    expandHome("~/code/x", "/home/u", "linux"),
    join("/home/u", "code", "x"),
  );
  assertPathEquals(
    expandHome("~\\code", "C:\\Users\\u", "windows"),
    join("C:\\Users\\u", "code"),
  );
  assertEquals(expandHome("~\\code", "/home/u", "linux"), "~\\code");
  assertEquals(expandHome("~other/x", "/home/u", "linux"), "~other/x");
  assertEquals(expandHome("/abs/x", undefined, "linux"), "/abs/x");
  assertThrows(() => expandHome("~/x", undefined, "linux"), UserError, "home");
});

Deno.test("startOpenAgent: leaves the workspace's tools alone when the agent is already set up", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    f.tools.set(ws, ["claude"]);
    await collect(
      startOpenAgent(ctx, f.deps, {
        workspacePath: ws,
        harness: "claude",
        trustConfirmed: true,
      }),
    );
    assertEquals(f.setToolsCalls, []);
    assertEquals(f.opened.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Trust is recorded in the registry, never read from the workspace
// ---------------------------------------------------------------------------

/** A workspace whose own task record says it was launched. */
async function plantedLaunched(f: Fakes): Promise<string> {
  const ws = await trustReady(f);
  await f.deps.sessions.save(
    StartSession.fromData({
      ...(await f.deps.sessions.load(ws, f.taskId!))!.toData(),
      step: "launched",
      launch: {
        method: "macos_terminal",
        command: "",
        opened: true,
        at: "2026-10-11T00:00:00.000Z",
      },
    }),
  );
  return ws;
}

Deno.test("startResume: refuses with trust_required, opening nothing, until trust is confirmed", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await plantedLaunched(f);
    const refused = await collect(
      startResume(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
    );
    assertEquals(errorCode(refused), "trust_required");
    assertEquals(f.opened.length, 0);
    assertEquals(f.setToolsCalls, []);
    assertEquals((await f.deps.registry.load())?.isTrusted(ws), false);

    const confirmed = await collect(
      startResume(ctx, f.deps, {
        workspacePath: ws,
        taskId: f.taskId!,
        trustConfirmed: true,
      }),
    );
    assertEquals(lastOf(confirmed).kind, "completed");
    assertEquals(f.opened.length, 1);
    assertEquals((await f.deps.registry.load())?.isTrusted(ws), true);
    const done = lastOf(confirmed);
    assert(done.kind === "completed");
    assertEquals(done.data.trusted, true);

    // Trusted now: the next resume needs no confirmation.
    await collect(
      startResume(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
    );
    assertEquals(f.opened.length, 2);
  });
});

Deno.test("startOpenAgent: refuses with trust_required, setting nothing up, until trust is confirmed", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await plantedLaunched(f);
    const refused = await collect(
      startOpenAgent(ctx, f.deps, { workspacePath: ws, harness: "claude" }),
    );
    assertEquals(errorCode(refused), "trust_required");
    assertEquals(f.opened.length, 0);
    assertEquals(f.setToolsCalls, []);
    const confirmed = await collect(
      startOpenAgent(ctx, f.deps, {
        workspacePath: ws,
        harness: "claude",
        trustConfirmed: true,
      }),
    );
    assertEquals(lastOf(confirmed).kind, "completed");
    assertEquals(f.opened.length, 1);
  });
});

Deno.test("startLaunch: records trust for the workspace", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    assertEquals((await f.deps.registry.load())?.isTrusted(ws), false);
    await collect(
      startLaunch(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
    );
    assertEquals((await f.deps.registry.load())?.isTrusted(ws), true);
  });
});

Deno.test("startListWorkspaces: leaves out a workspace it can't read, listing the rest", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const good = await trustReady(f);
    const bad = join(dir, "bad-repo");
    await Deno.mkdir(bad, { recursive: true });
    f.repos.add(bad);
    await f.deps.registry.update((r) =>
      r.register({ name: "bad-repo", path: bad, createdAt: "t" })
    );
    const enrolled = f.deps.repo.enrolledTools;
    f.deps.repo.enrolledTools = (path) =>
      path === bad
        ? Promise.reject(new UserError("damaged .swamp.yaml"))
        : enrolled(path);
    const { workspaces } = await startListWorkspaces(ctx, f.deps);
    assertEquals(workspaces.map((w) => w.path), [good]);
  });
});

Deno.test("startInspect: carries the username, or why the account couldn't be verified", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const signedIn = await startInspect(ctx, f.deps, {});
    assertEquals(signedIn.signedIn, "signed_in");
    assertEquals(signedIn.username, "ada");
    assertEquals(signedIn.blockedReason, undefined);
    const blockedDeps = {
      ...f.deps,
      checkSignedIn: () =>
        Promise.resolve({
          kind: "blocked" as const,
          reason: "proxy refused (407)",
        }),
    };
    const blocked = await startInspect(ctx, blockedDeps, {});
    assertEquals(blocked.signedIn, "blocked");
    assertEquals(blocked.blockedReason, "proxy refused (407)");
    assertEquals(blocked.username, undefined);
  });
});

Deno.test("startOpenWorkspace: converts an older workspace's files and opens its newest task", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = startWorkspacePath(f.deps.dataDir, "older");
    await Deno.mkdir(join(ws, ".swamp", "start"), { recursive: true });
    f.repos.add(ws);
    f.tools.set(ws, []);
    const legacy = StartSession.create(
      "legacy-1",
      ws,
      new Date("2026-10-01T09:00:00.000Z"),
    );
    legacy.saveTask(StartTask.create("List my VPCs"));
    const { briefFile: _none, ...data } = legacy.toData();
    await Deno.writeTextFile(
      join(ws, ".swamp", "start", "state.json"),
      JSON.stringify({ schemaVersion: 1, session: data }),
    );
    const vpcsBrief = renderBrief({
      task: StartTask.create("List my VPCs"),
      workspacePath: ws,
      harnessDisplayName: "Codex",
    });
    await Deno.writeTextFile(join(ws, "TASK.md"), vpcsBrief);

    const events = await collect(
      startOpenWorkspace(ctx, f.deps, { workspaceName: "older" }),
    );
    const done = lastOf(events);
    assert(done.kind === "completed");
    assertEquals(done.data.taskId, "legacy-1");
    assertEquals(done.data.task?.briefFile, "tasks/2026-10-01-list-my-vpcs.md");
    assertEquals(
      await Deno.readTextFile(join(ws, "tasks", "2026-10-01-list-my-vpcs.md")),
      vpcsBrief,
    );
    await assertRejects(() => Deno.stat(join(ws, "TASK.md")));
    await assertRejects(() =>
      Deno.stat(join(ws, ".swamp", "start", "state.json"))
    );
  });
});

Deno.test("startOpenAgent: an agent launched for any task in the workspace resumes", async () => {
  await withTempDir(async (dir) => {
    const f = makeFakes(dir);
    const ws = await trustReady(f);
    await collect(
      startLaunch(ctx, f.deps, { workspacePath: ws, taskId: f.taskId! }),
    );
    // A second task, not launched, is open; Claude Code still resumes.
    const second = await newTask(f, ws, "Another task");
    const events = await collect(
      startOpenAgent(ctx, f.deps, {
        workspacePath: ws,
        taskId: second,
        harness: "claude",
      }),
    );
    const done = lastOf(events);
    assert(done.kind === "completed");
    assertEquals(f.opened.at(-1)?.spec.args, ["--continue"]);
    assertEquals(done.data.taskId, second);
  });
});
