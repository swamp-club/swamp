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
import {
  agentScreenHeading,
  agentsToggleLabel,
  allTasksLabel,
  contentsLabel,
  contentsNames,
  createdLabel,
  extraToolsToSend,
  FIRST_TASK_IDEAS,
  firstLine,
  importNameFromPath,
  importProblem,
  initialAgentPick,
  isHttpsUrl,
  isValidWorkspaceName,
  joinNames,
  keepSuggestion,
  launchChecklist,
  launchChoices,
  launchedLabel,
  launchOpened,
  middleEllipsis,
  nameFromFolder,
  newWorkspaceNameProblem,
  orderExamples,
  parseTokenFromHash,
  pickFirstTaskIdea,
  resumeChecklist,
  resumeGuidance,
  resumeLaunchLabel,
  screenComponentKey,
  setupSummary,
  showExtrasOpen,
  sortWorkspaces,
  splitHarnesses,
  splitTask,
  startErrorText,
  taskCreatedLabel,
  taskStatusLabel,
  TITLE_MAX,
  toLaunchEvent,
  toolDisplayName,
  toolsToAdd,
  toSigninEvent,
  updatedLabel,
  workspaceAgentTags,
  workspaceChooseError,
} from "./helpers.ts";
import type {
  ExamplePrompt,
  StartHarness,
  StartSignals,
  TaskSummary,
  WorkspaceSummary,
} from "./types.ts";

Deno.test("parseTokenFromHash: reads the token from the fragment", () => {
  assertEquals(parseTokenFromHash("#token=abc-DEF_123"), "abc-DEF_123");
  assertEquals(parseTokenFromHash("token=xyz"), "xyz");
  assertEquals(parseTokenFromHash("#other=1&token=t"), "t");
});

Deno.test("parseTokenFromHash: returns null without a token", () => {
  assertEquals(parseTokenFromHash(""), null);
  assertEquals(parseTokenFromHash("#"), null);
  assertEquals(parseTokenFromHash("#token="), null);
  assertEquals(parseTokenFromHash("#tok=abc"), null);
});

Deno.test("screenComponentKey: maps every known screen to itself", () => {
  for (
    const screen of [
      "workspace",
      "task",
      "sign_in",
      "blocked",
      "agent",
      "trust",
      "launched",
      "home",
    ]
  ) {
    assertEquals(screenComponentKey(screen), screen);
  }
  // Screens of older versions are unknown now.
  assertEquals(screenComponentKey("resume"), "unknown");
  assertEquals(screenComponentKey("tasks"), "unknown");
});

Deno.test("screenComponentKey: maps unknown values to unknown", () => {
  assertEquals(screenComponentKey("dashboard"), "unknown");
  assertEquals(screenComponentKey(undefined), "unknown");
  assertEquals(screenComponentKey(3), "unknown");
});

const EXAMPLES: ExamplePrompt[] = [
  { id: "pods", signal: "kubeconfig", text: "pods" },
  { id: "aws", signal: "awsConfig", text: "aws" },
  { id: "gha", text: "gha" },
];

function signals(partial: Partial<StartSignals>): StartSignals {
  return { kubeconfig: false, awsConfig: false, gcloudAdc: false, ...partial };
}

Deno.test("orderExamples: keeps the order when no signal is present", () => {
  assertEquals(
    orderExamples(EXAMPLES, signals({})).map((e) => e.id),
    ["pods", "aws", "gha"],
  );
});

Deno.test("orderExamples: moves examples with a present signal first", () => {
  assertEquals(
    orderExamples(EXAMPLES, signals({ awsConfig: true })).map((e) => e.id),
    ["aws", "pods", "gha"],
  );
  assertEquals(
    orderExamples(EXAMPLES, signals({ kubeconfig: true, awsConfig: true }))
      .map((e) => e.id),
    ["pods", "aws", "gha"],
  );
  assertEquals(
    orderExamples(EXAMPLES, signals({ gcloudAdc: true })).map((e) => e.id),
    ["pods", "aws", "gha"],
  );
});

Deno.test("splitTask: takes the first non-empty line as the title", () => {
  assertEquals(splitTask("\n\n  Fix the pods  \n\nIn staging.\nNow."), {
    title: "Fix the pods",
    rest: "In staging.\nNow.",
  });
  assertEquals(splitTask("One line"), { title: "One line", rest: "" });
  assertEquals(splitTask("a\r\nb"), { title: "a", rest: "b" });
});

Deno.test("splitTask: cuts a long title with an ellipsis", () => {
  const long = "x".repeat(TITLE_MAX + 30);
  const { title, rest } = splitTask(`${long}\nmore`);
  assertEquals(title, `${"x".repeat(TITLE_MAX)}…`);
  assertEquals(rest, "more");
  assertEquals(splitTask("y".repeat(TITLE_MAX)).title, "y".repeat(TITLE_MAX));
});

Deno.test("splitTask: returns empty parts for blank text", () => {
  assertEquals(splitTask("  \n \n"), { title: "", rest: "" });
});

Deno.test("firstLine: shows only the first line of an example", () => {
  assertEquals(firstLine("List the VPCs.\n\nFlag any."), "List the VPCs.");
});

Deno.test("toSigninEvent: accepts kind or type and drops extra fields", () => {
  assertEquals(
    toSigninEvent({
      kind: "device_verification",
      userCode: "ABCD-1234",
      verificationUri: "https://x/device",
    }),
    {
      kind: "device_verification",
      userCode: "ABCD-1234",
      verificationUri: "https://x/device",
    },
  );
  assertEquals(toSigninEvent({ type: "completed", username: "u", apiKey: 1 }), {
    kind: "completed",
    username: "u",
  });
  assertEquals(toSigninEvent({ kind: "opening_browser" }), null);
  assertEquals(toSigninEvent(null), null);
});

Deno.test("toLaunchEvent: normalises launch events", () => {
  assertEquals(toLaunchEvent({ kind: "enrolling" }), { kind: "enrolling" });
  assertEquals(
    toLaunchEvent({ type: "launched", method: "copy_command", command: "c" }),
    { kind: "launched", method: "copy_command", command: "c" },
  );
  assertEquals(
    toLaunchEvent({
      kind: "launched",
      method: "macos_terminal",
      command: "c",
      opened: false,
    }),
    { kind: "launched", method: "macos_terminal", command: "c", opened: false },
  );
  assertEquals(toLaunchEvent({ kind: "error" }), {
    kind: "error",
    message: "Launch failed.",
  });
});

Deno.test("launchChecklist: marks steps done, active and pending", () => {
  assertEquals(
    launchChecklist(null).map((s) => s.state),
    ["pending", "pending", "pending", "pending", "pending"],
  );
  assertEquals(
    launchChecklist("brief_written").map((s) => s.state),
    ["done", "done", "active", "pending", "pending"],
  );
  assertEquals(
    launchChecklist("launched").map((s) => s.state),
    ["done", "done", "done", "done", "done"],
  );
});

function workspace(overrides: Partial<WorkspaceSummary>): WorkspaceSummary {
  return {
    name: "w",
    path: "/home/u/.swamp/workspaces/w",
    step: null,
    taskTitle: null,
    harness: null,
    harnessDisplayName: null,
    updatedAt: null,
    running: false,
    imported: false,
    ...overrides,
  };
}

function harness(overrides: Partial<StartHarness>): StartHarness {
  return {
    id: "h",
    displayName: "H",
    binary: "h",
    binaryPath: null,
    found: false,
    trustMode: "unknown",
    launchable: true,
    ...overrides,
  };
}

Deno.test("isValidWorkspaceName: accepts lowercase, digits and dashes", () => {
  for (
    const name of ["a", "first-workspace", "0abc", "a-b-9", "a".repeat(63)]
  ) {
    assertEquals(isValidWorkspaceName(name), true, name);
  }
});

Deno.test("isValidWorkspaceName: refuses other shapes", () => {
  for (
    const name of ["", "-a", "A", "a_b", "a b", "a.b", "a/b", "a".repeat(64)]
  ) {
    assertEquals(isValidWorkspaceName(name), false, name);
  }
});

Deno.test("newWorkspaceNameProblem: explains an invalid or taken name", () => {
  const existing = [workspace({ name: "taken" })];
  assertEquals(newWorkspaceNameProblem("", existing), null);
  assertEquals(newWorkspaceNameProblem("fresh", existing), null);
  assertEquals(
    newWorkspaceNameProblem("Bad", existing),
    "Use lowercase letters, digits and dashes",
  );
  assertEquals(
    newWorkspaceNameProblem("taken", existing)?.startsWith(
      "A workspace with that name exists",
    ),
    true,
  );
});

Deno.test("sortWorkspaces: newest first, unknown times last", () => {
  const sorted = sortWorkspaces([
    workspace({ name: "none" }),
    workspace({ name: "old", updatedAt: "2026-01-01T00:00:00Z" }),
    workspace({ name: "new", updatedAt: "2026-10-01T00:00:00Z" }),
    workspace({ name: "bad", updatedAt: "not a date" }),
  ]);
  assertEquals(sorted.map((w) => w.name).slice(0, 2), ["new", "old"]);
});

Deno.test("updatedLabel: relative within a week, else the date", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  assertEquals(updatedLabel(null, now), null);
  assertEquals(updatedLabel("nope", now), null);
  assertEquals(updatedLabel("2026-10-11T11:59:30Z", now), "Updated just now");
  assertEquals(
    updatedLabel("2026-10-11T11:59:00Z", now),
    "Updated 1 minute ago",
  );
  assertEquals(
    updatedLabel("2026-10-11T09:00:00Z", now),
    "Updated 3 hours ago",
  );
  assertEquals(updatedLabel("2026-10-09T12:00:00Z", now), "Updated 2 days ago");
  assertEquals(updatedLabel("2026-09-01T12:00:00Z", now), "Updated 2026-09-01");
});

Deno.test("splitHarnesses: found ones launchable first, the rest apart", () => {
  const { available, unavailable } = splitHarnesses([
    harness({ id: "amp", found: true, launchable: false }),
    harness({ id: "claude", found: true, launchable: true }),
    harness({ id: "codex", found: false, launchable: true }),
    harness({ id: "cursor", found: true, launchable: true }),
    harness({ id: "kiro", found: false, launchable: false }),
  ]);
  assertEquals(available.map((h) => h.id), ["claude", "cursor", "amp"]);
  assertEquals(unavailable.map((h) => h.id), ["codex", "kiro"]);
});

Deno.test("importProblem: needs a folder", () => {
  assertEquals(importProblem("", "", []), {
    field: "path",
    message: "Enter the folder to import",
  });
  assertEquals(importProblem("   ", "", [])?.field, "path");
  assertEquals(importProblem("~/code/app", "", []), null);
  assertEquals(importProblem("/abs/app", "  ", ["app"]), null);
});

Deno.test("importProblem: checks the name only when given", () => {
  assertEquals(importProblem("~/a", "Bad Name", [])?.field, "name");
  assertEquals(
    importProblem("~/a", "Bad Name", [])?.message,
    "Use lowercase letters, digits and dashes",
  );
  assertEquals(importProblem("~/a", "taken", ["taken"])?.field, "name");
  assertEquals(
    importProblem("~/a", "taken", ["taken"])?.message.includes("exists"),
    true,
  );
  assertEquals(importProblem("~/a", " fresh ", ["taken"]), null);
});

Deno.test("importProblem: a bad name is reported before an empty folder", () => {
  assertEquals(importProblem("", "Nope!", [])?.field, "name");
});

Deno.test("middleEllipsis: keeps short text and both ends of long text", () => {
  assertEquals(middleEllipsis("short", 10), "short");
  assertEquals(middleEllipsis("abcdefghij", 10), "abcdefghij");
  assertEquals(middleEllipsis("abcdefghijk", 10), "abcde…hijk");
  assertEquals(middleEllipsis("abcdefghijk", 10).length, 10);
  const long = "/Users/someone/code/clients/acme/really-long-project-name/" +
    "infrastructure/swamp";
  const shown = middleEllipsis(long, 60);
  assertEquals(shown.length, 60);
  assertEquals(shown.startsWith("/Users/someone"), true);
  assertEquals(shown.endsWith("infrastructure/swamp"), true);
  assertEquals(middleEllipsis("abc", 1), "…");
  assertEquals(middleEllipsis("abc", 0), "");
});

Deno.test("workspaceChooseError: maps import codes", () => {
  assertEquals(
    workspaceChooseError("not_found", "x").includes("no folder"),
    true,
  );
  assertEquals(
    workspaceChooseError("not_a_repo", "x"),
    "This isn't a swamp folder.",
  );
  assertEquals(
    workspaceChooseError("not_a_repo", "x").includes("repo init"),
    false,
  );
  assertEquals(
    workspaceChooseError("name_taken", "x").includes("already exists"),
    true,
  );
});

Deno.test("workspaceChooseError: maps known codes, else the message", () => {
  assertEquals(
    workspaceChooseError("invalid_name", "x").includes("lowercase"),
    true,
  );
  assertEquals(
    workspaceChooseError("not_a_workspace", "x").includes("isn't a swamp"),
    true,
  );
  assertEquals(workspaceChooseError("other", "Boom"), "Boom");
  assertEquals(
    workspaceChooseError(undefined, ""),
    "Couldn't open that workspace. Try again.",
  );
});

Deno.test("resumeChecklist: leaves out the brief step", () => {
  assertEquals(
    resumeChecklist(null).map((s) => s.step),
    ["checking", "enrolling", "window_opening", "launched"],
  );
  assertEquals(
    resumeChecklist("window_opening").map((s) => s.state),
    ["done", "done", "active", "pending"],
  );
  assertEquals(
    resumeChecklist("launched").map((s) => s.state),
    ["done", "done", "done", "done"],
  );
});

Deno.test("launchedLabel: relative within a week, else the date", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  assertEquals(launchedLabel(undefined, now), null);
  assertEquals(launchedLabel(null, now), null);
  assertEquals(launchedLabel("nope", now), null);
  assertEquals(launchedLabel("2026-10-11T11:59:30Z", now), "launched just now");
  assertEquals(
    launchedLabel("2026-10-11T11:00:00Z", now),
    "launched 1 hour ago",
  );
  assertEquals(
    launchedLabel("2026-10-08T12:00:00Z", now),
    "launched 3 days ago",
  );
  assertEquals(
    launchedLabel("2026-09-01T12:00:00Z", now),
    "launched on 2026-09-01",
  );
});

Deno.test("contentsLabel: pluralises, and says when nothing is built", () => {
  assertEquals(contentsLabel(undefined), null);
  assertEquals(
    contentsLabel({ models: 0, workflows: 0 }),
    "Nothing built yet",
  );
  assertEquals(
    contentsLabel({ models: 1, workflows: 1 }),
    "1 behavior, 1 workflow",
  );
  assertEquals(
    contentsLabel({ models: 3, workflows: 0 }),
    "3 behaviors, 0 workflows",
  );
  assertEquals(
    contentsLabel({ models: 0, workflows: 2 }),
    "0 behaviors, 2 workflows",
  );
});

const CLAUDE = {
  id: "claude",
  displayName: "Claude Code",
  trustMode: "dialog" as const,
  canResume: true,
};

Deno.test("resumeGuidance: earlier session, or a pointer to the task's brief", () => {
  assertEquals(
    resumeGuidance(CLAUDE),
    "Pick up the conversation where you left off. Claude Code opens in a " +
      "new window with your earlier session.",
  );
  assertEquals(
    resumeGuidance(
      { ...CLAUDE, displayName: "Kiro", canResume: false },
      "tasks/2026-10-12-list-pods.md",
    ),
    "Kiro opens in a new window in this workspace. The task is in " +
      "tasks/2026-10-12-list-pods.md if it needs a reminder.",
  );
});

Deno.test("toolDisplayName: maps the nine tool ids, unknown ids as-is", () => {
  assertEquals(toolDisplayName("claude"), "Claude Code");
  assertEquals(toolDisplayName("codex"), "Codex");
  assertEquals(toolDisplayName("cursor"), "Cursor");
  assertEquals(toolDisplayName("opencode"), "OpenCode");
  assertEquals(toolDisplayName("copilot"), "Copilot");
  assertEquals(toolDisplayName("kiro"), "Kiro");
  assertEquals(toolDisplayName("pi"), "Pi");
  assertEquals(toolDisplayName("amp"), "Amp");
  assertEquals(toolDisplayName("antigravity"), "Antigravity");
  assertEquals(toolDisplayName("newtool"), "newtool");
});

Deno.test("joinNames: natural list without an Oxford comma", () => {
  assertEquals(joinNames([]), "");
  assertEquals(joinNames(["A"]), "A");
  assertEquals(joinNames(["A", "B"]), "A and B");
  assertEquals(joinNames(["A", "B", "C"]), "A, B and C");
  assertEquals(joinNames(["A", "B", "C", "D"]), "A, B, C and D");
});

Deno.test("extraToolsToSend: drops the picked agent, enrolled and repeats", () => {
  assertEquals(
    extraToolsToSend(["codex", "claude", "kiro", "codex"], "claude", ["kiro"]),
    ["codex"],
  );
  assertEquals(extraToolsToSend(new Set(["amp"]), "claude", []), ["amp"]);
  assertEquals(extraToolsToSend([], "claude", ["codex"]), []);
});

Deno.test("showExtrasOpen: folds extras only on a first launch with none ticked", () => {
  assertEquals(showExtrasOpen([], []), false);
  assertEquals(showExtrasOpen(undefined, undefined), false);
  assertEquals(showExtrasOpen(["claude"], []), true);
  assertEquals(showExtrasOpen([], ["codex"]), true);
  assertEquals(showExtrasOpen(["claude"], ["codex"]), true);
});

Deno.test("agentScreenHeading: names the one agent, asks to pick among several", () => {
  assertEquals(agentScreenHeading(1, "Claude Code"), {
    heading: "Your agent",
    intro:
      "Swamp found Claude Code on this machine. It opens in a new window and starts on your task.",
  });
  assertEquals(agentScreenHeading(2, "Claude Code"), {
    heading: "Who should do the work?",
    intro:
      "Swamp found 2 agents on this machine. The one you pick opens in a new window and starts on your task.",
  });
  assertEquals(agentScreenHeading(1, undefined), {
    heading: "Who should do the work?",
    intro:
      "Swamp found one agent on this machine. The one you pick opens in a new window and starts on your task.",
  });
  assertEquals(agentScreenHeading(0, undefined), {
    heading: "Who should do the work?",
    intro: null,
  });
});

Deno.test("setupSummary: names every tool, harness first, when more than one", () => {
  assertEquals(setupSummary([], ["claude"], "claude"), null);
  assertEquals(setupSummary(["claude"], undefined, "claude"), null);
  assertEquals(setupSummary(undefined, undefined, undefined), null);
  assertEquals(
    setupSummary(["codex"], ["claude", "cursor"], "claude"),
    "Swamp sets this workspace up for Claude Code, Codex and Cursor. " +
      "Claude Code opens.",
  );
  assertEquals(
    setupSummary(["claude", "codex"], undefined, "codex"),
    "Swamp sets this workspace up for Codex and Claude Code. Codex opens.",
  );
});

Deno.test("workspaceAgentTags: launched agent first, at most three, the rest counted", () => {
  const tags = workspaceAgentTags(
    workspace({
      step: "launched",
      harness: "codex",
      enrolledTools: ["claude", "codex", "copilot", "kiro", "pi"],
    }),
  );
  assertEquals(tags.tags.map((t) => t.name), [
    "Codex",
    "Claude Code",
    "Copilot",
  ]);
  assertEquals(tags.tags[0].launched, true);
  assertEquals(tags.more, 2);
  assertEquals(tags.moreTitle, "Kiro and Pi");
  assertEquals(
    workspaceAgentTags(workspace({ step: null })).tags,
    [],
  );
});

Deno.test("createdLabel: day and month, the year only when it differs", () => {
  const now = new Date(2026, 9, 11, 12);
  assertEquals(
    createdLabel(new Date(2026, 9, 3, 9).toISOString(), now),
    "Created 3 Oct",
  );
  assertEquals(
    createdLabel(new Date(2025, 11, 30, 9).toISOString(), now),
    "Created 30 Dec 2025",
  );
  assertEquals(createdLabel(null, now), null);
  assertEquals(createdLabel("not a date", now), null);
});

function taskSummary(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: crypto.randomUUID(),
    title: "Find failing pods",
    step: "task",
    harness: null,
    harnessDisplayName: null,
    createdAt: "2026-10-01T12:00:00Z",
    launchedAt: null,
    briefFile: null,
    ...overrides,
  };
}

Deno.test("taskStatusLabel: names the step a task that hasn't launched is on", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  assertEquals(
    taskStatusLabel(taskSummary({ step: "task" }), now),
    "Not launched — writing",
  );
  assertEquals(
    taskStatusLabel(taskSummary({ step: "agent" }), now),
    "Not launched — choosing an agent",
  );
  assertEquals(
    taskStatusLabel(taskSummary({ step: "trust" }), now),
    "Not launched — ready to launch",
  );
});

Deno.test("taskStatusLabel: says when a launched task launched", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const launched = (launchedAt: string | null) =>
    taskStatusLabel(taskSummary({ step: "launched", launchedAt }), now);
  assertEquals(launched("2026-10-11T11:59:30Z"), "Launched just now");
  assertEquals(launched("2026-10-11T09:00:00Z"), "Launched 3 hours ago");
  assertEquals(launched("2026-09-01T12:00:00Z"), "Launched on 2026-09-01");
  assertEquals(launched(null), "Launched");
  assertEquals(launched("nope"), "Launched");
});

Deno.test("allTasksLabel: counts every task", () => {
  assertEquals(allTasksLabel(undefined), null);
  assertEquals(allTasksLabel(0), null);
  assertEquals(allTasksLabel(-1), null);
  assertEquals(allTasksLabel(Number.NaN), null);
  assertEquals(allTasksLabel(1), "All tasks (1)");
  assertEquals(allTasksLabel(4), "All tasks (4)");
});

Deno.test("taskCreatedLabel: always the date and time, how long ago for the last week", () => {
  const now = new Date(2026, 9, 12, 16, 5);
  assertEquals(
    taskCreatedLabel(new Date(2026, 9, 12, 14, 5).toISOString(), now),
    "Created 12 Oct, 14:05 · 2 hours ago",
  );
  assertEquals(
    taskCreatedLabel(new Date(2026, 8, 1, 9, 30).toISOString(), now),
    "Created 1 Sep, 09:30",
  );
  assertEquals(
    taskCreatedLabel(new Date(2025, 11, 30, 23, 0).toISOString(), now),
    "Created 30 Dec 2025, 23:00",
  );
  assertEquals(taskCreatedLabel(null, now), null);
  assertEquals(taskCreatedLabel("nope", now), null);
});

Deno.test("toolsToAdd: ticked tools not yet enrolled, once each", () => {
  assertEquals(toolsToAdd(["codex", "claude", "codex", "amp"], ["claude"]), [
    "codex",
    "amp",
  ]);
  assertEquals(toolsToAdd(new Set(["claude"]), ["claude"]), []);
  assertEquals(toolsToAdd([], []), []);
  assertEquals(toolsToAdd(["", "kiro"], []), ["kiro"]);
});

Deno.test("agentsToggleLabel: counts the enrolled agents", () => {
  assertEquals(agentsToggleLabel(0), "Configured agents (0)");
  assertEquals(agentsToggleLabel(3), "Configured agents (3)");
  assertEquals(agentsToggleLabel(-1), "Configured agents (0)");
  assertEquals(agentsToggleLabel(Number.NaN), "Configured agents (0)");
});

Deno.test("launchChoices: configured, installed agents with the task's first", () => {
  const h = (id: string, found = true, launchable = true) => ({
    id,
    displayName: id,
    binary: id,
    binaryPath: found ? `/bin/${id}` : null,
    found,
    trustMode: "unknown" as const,
    launchable,
  });
  const all = [
    h("claude"),
    h("codex"),
    h("opencode"),
    h("kiro", false),
    h("amp", true, false),
  ];
  assertEquals(
    launchChoices(all, ["codex", "claude", "kiro", "amp"], "claude").map((c) =>
      c.id
    ),
    ["claude", "codex"],
  );
  assertEquals(launchChoices(all, ["claude"], "claude").map((c) => c.id), [
    "claude",
  ]);
  assertEquals(
    launchChoices(all, ["claude", "codex"], "kiro").map((c) => c.id),
    ["kiro", "claude", "codex"],
  );
});

Deno.test("launchOpened: false only when no window opened or a command is offered", () => {
  assertEquals(launchOpened(undefined), true);
  assertEquals(launchOpened({ opened: true, method: "macos_terminal" }), true);
  assertEquals(
    launchOpened({ opened: false, method: "macos_terminal" }),
    false,
  );
  assertEquals(launchOpened({ method: "copy_command" }), false);
});

Deno.test("isHttpsUrl: only https URLs", () => {
  assertEquals(isHttpsUrl("https://swamp.club/device?code=X"), true);
  assertEquals(isHttpsUrl("http://swamp.club/device"), false);
  assertEquals(isHttpsUrl("javascript:alert(1)"), false);
  assertEquals(isHttpsUrl("not a url"), false);
  assertEquals(isHttpsUrl(""), false);
});

Deno.test("startErrorText: friendly text for the shared error codes", () => {
  for (
    const code of [
      "not_signed_in",
      "workspace_missing",
      "task_file_exists",
      "registry_unreadable",
    ]
  ) {
    assertEquals(typeof startErrorText(code), "string");
  }
  assertEquals(startErrorText("other"), null);
  assertEquals(startErrorText(undefined), null);
  assertEquals(
    workspaceChooseError("workspace_missing", "raw"),
    startErrorText("workspace_missing"),
  );
});

Deno.test("contentsNames: models as name · short type, workflows by name, the rest counted", () => {
  assertEquals(
    contentsNames({
      models: 3,
      workflows: 1,
      modelList: [{ name: "github-uptime", type: "@gluware/http-endpoint" }],
      workflowList: ["morning-report"],
    }),
    {
      models: ["github-uptime · http-endpoint"],
      moreModels: 2,
      workflows: ["morning-report"],
      moreWorkflows: 0,
    },
  );
  assertEquals(contentsNames(undefined), null);
});

Deno.test("resumeLaunchLabel: asks for trust until the folder is trusted", () => {
  assertEquals(resumeLaunchLabel(false, true), "Launch agent");
  assertEquals(resumeLaunchLabel(false, false), "Trust folder and launch");
  assertEquals(resumeLaunchLabel(true, false), "Launching…");
});

Deno.test("keepSuggestion: keeps the first suggestion until it is taken", () => {
  assertEquals(keepSuggestion("", "misty-heron", []), "misty-heron");
  assertEquals(
    keepSuggestion("misty-heron", "tidy-tadpole", ["other"]),
    "misty-heron",
  );
  assertEquals(
    keepSuggestion("misty-heron", "tidy-tadpole", ["misty-heron"]),
    "tidy-tadpole",
  );
});

Deno.test("nameFromFolder: lowercases and dashes the folder name like the server", () => {
  assertEquals(nameFromFolder("My Infra"), "my-infra");
  assertEquals(nameFromFolder("__Repo__.v2"), "repo-v2");
  assertEquals(nameFromFolder("!!!"), "workspace");
  assertEquals(nameFromFolder("x".repeat(70)).length, 63);
});

Deno.test("importNameFromPath: names the import after the last folder", () => {
  assertEquals(importNameFromPath("~/code/My Infra"), "my-infra");
  assertEquals(importNameFromPath("/srv/ops-repo/"), "ops-repo");
  assertEquals(importNameFromPath("C:\\work\\Billing"), "billing");
  for (const empty of ["", "  ", "~", "~/", ".", ".."]) {
    assertEquals(importNameFromPath(empty), null, empty);
  }
});

Deno.test("FIRST_TASK_IDEAS: at least 20 distinct ideas, each picked by some draw", () => {
  const ideas = FIRST_TASK_IDEAS.map((idea) => idea.trim());
  assertEquals(ideas.every((idea) => idea !== ""), true);
  assertEquals(new Set(ideas).size, ideas.length);
  assertEquals(ideas.length >= 20, true);
  assertEquals(pickFirstTaskIdea(0), FIRST_TASK_IDEAS[0]);
  assertEquals(pickFirstTaskIdea(0.9999999), FIRST_TASK_IDEAS.at(-1));
  assertEquals(pickFirstTaskIdea(1), FIRST_TASK_IDEAS.at(-1));
});

Deno.test("initialAgentPick: keeps the pick, else the task's agent, else the last picked, else the first", () => {
  const ids = ["claude", "codex", "opencode"];
  assertEquals(initialAgentPick(ids, "opencode", "codex", "codex"), "opencode");
  assertEquals(initialAgentPick(ids, null, "codex", "opencode"), "codex");
  assertEquals(initialAgentPick(ids, null, undefined, "opencode"), "opencode");
  assertEquals(initialAgentPick(ids, null, undefined, undefined), "claude");
  // An agent that can't launch here any more is passed over.
  assertEquals(initialAgentPick(ids, "cursor", "amp", "pi"), "claude");
  assertEquals(initialAgentPick([], null, undefined, "codex"), null);
});
