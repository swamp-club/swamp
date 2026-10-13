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

import { assertEquals, assertThrows } from "@std/assert";
import { UserError } from "../errors.ts";
import { StartTask } from "./start_task.ts";
import {
  StartSession,
  type StartSessionData,
  type StartStep,
  StartTransitionError,
} from "./start_session.ts";

const NOW = new Date("2026-10-03T10:00:00.000Z");
const LATER = new Date("2026-10-03T10:05:00.000Z");
const LAUNCH = {
  method: "macos_terminal" as const,
  command: "cd '/w' && 'claude' 'x'",
  opened: true,
};

function sessionAt(step: StartStep): StartSession {
  const session = StartSession.create(crypto.randomUUID(), "/w", NOW);
  if (step === "task") return session;
  session.saveTask(StartTask.create("list my pods"));
  if (step === "agent") return session;
  session.chooseHarness("claude");
  if (step === "trust") return session;
  session.confirmTrustAndRecordLaunch(LAUNCH, LATER);
  return session;
}

Deno.test("StartSession.create: starts at the task step with nothing chosen", () => {
  const session = StartSession.create("id-1", "/w", NOW);
  assertEquals(session.toData(), {
    id: "id-1",
    workspacePath: "/w",
    createdAt: NOW.toISOString(),
    step: "task",
  });
  assertEquals(session.task, undefined);
  assertEquals(session.harness, undefined);
});

Deno.test("StartSession.saveTask: moves task to agent", () => {
  const session = sessionAt("task");
  session.saveTask(StartTask.create("  check buckets "));
  assertEquals(session.step, "agent");
  assertEquals(session.task?.text, "check buckets");
});

Deno.test("StartSession.saveTask: from agent stays at agent with the new text", () => {
  const session = sessionAt("agent");
  session.saveTask(StartTask.create("second"));
  assertEquals(session.step, "agent");
  assertEquals(session.task?.text, "second");
});

Deno.test("StartSession.saveTask: from trust returns to agent and keeps the harness", () => {
  const session = sessionAt("trust");
  session.saveTask(StartTask.create("edited"));
  assertEquals(session.step, "agent");
  assertEquals(session.harness, "claude");
  assertEquals(session.task?.text, "edited");
});

Deno.test("StartSession.saveTask: clears a recorded trust confirmation", () => {
  const data: StartSessionData = {
    ...sessionAt("trust").toData(),
    trustConfirmedAt: NOW.toISOString(),
  };
  const session = StartSession.fromData(data);
  session.saveTask(StartTask.create("edited"));
  assertEquals(session.trustConfirmedAt, undefined);
  assertEquals("trustConfirmedAt" in session.toData(), false);
});

Deno.test("StartSession.saveTask: is refused once launched", () => {
  const session = sessionAt("launched");
  assertThrows(
    () => session.saveTask(StartTask.create("x")),
    StartTransitionError,
    `"launched"`,
  );
});

Deno.test("StartSession.chooseHarness: moves agent to trust", () => {
  const session = sessionAt("agent");
  session.chooseHarness("codex");
  assertEquals(session.step, "trust");
  assertEquals(session.harness, "codex");
});

Deno.test("StartSession.chooseHarness: is refused outside the agent step", () => {
  for (const step of ["task", "trust", "launched"] as const) {
    assertThrows(
      () => sessionAt(step).chooseHarness("claude"),
      StartTransitionError,
    );
  }
});

Deno.test("StartSession.back: moves agent to task", () => {
  const session = sessionAt("agent");
  session.back();
  assertEquals(session.step, "task");
  assertEquals(session.task?.text, "list my pods");
});

Deno.test("StartSession.back: moves trust to agent and clears trust", () => {
  const session = StartSession.fromData({
    ...sessionAt("trust").toData(),
    trustConfirmedAt: NOW.toISOString(),
  });
  session.back();
  assertEquals(session.step, "agent");
  assertEquals(session.trustConfirmedAt, undefined);
  assertEquals(session.harness, "claude");
});

Deno.test("StartSession.back: is refused at task and launched", () => {
  assertThrows(() => sessionAt("task").back(), StartTransitionError);
  assertThrows(() => sessionAt("launched").back(), StartTransitionError);
});

Deno.test("StartSession.confirmTrustAndRecordLaunch: moves trust to launched with the launch record", () => {
  const session = sessionAt("trust");
  session.confirmTrustAndRecordLaunch(LAUNCH, LATER);
  assertEquals(session.step, "launched");
  assertEquals(session.trustConfirmedAt, LATER.toISOString());
  assertEquals(session.launch, { ...LAUNCH, at: LATER.toISOString() });
});

Deno.test("StartSession.confirmTrustAndRecordLaunch: from launched records a fresh launch", () => {
  const session = sessionAt("launched");
  const again = new Date("2026-10-03T11:00:00.000Z");
  session.confirmTrustAndRecordLaunch(
    { method: "copy_command", command: "c", opened: false },
    again,
  );
  assertEquals(session.step, "launched");
  assertEquals(session.launch?.method, "copy_command");
  assertEquals(session.launch?.at, again.toISOString());
  assertEquals(session.trustConfirmedAt, again.toISOString());
});

Deno.test("StartSession.confirmTrustAndRecordLaunch: is refused at task and agent", () => {
  for (const step of ["task", "agent"] as const) {
    assertThrows(
      () => sessionAt(step).confirmTrustAndRecordLaunch(LAUNCH, LATER),
      StartTransitionError,
    );
  }
});

Deno.test("StartSession.fromData: rejects steps that break the session's invariants", () => {
  const base = { id: "x", workspacePath: "/w", createdAt: NOW.toISOString() };
  const launch = { ...LAUNCH, at: LATER.toISOString() };
  const bad: Array<[StartSessionData, string]> = [
    [{ ...base, step: "agent" }, "no task"],
    [{ ...base, step: "trust", harness: "claude" }, "no task"],
    [{ ...base, step: "launched", harness: "claude", launch }, "no task"],
    [{ ...base, step: "trust", task: "t" }, "no agent"],
    [{ ...base, step: "launched", task: "t", launch }, "no agent"],
    [
      { ...base, step: "launched", task: "t", harness: "claude" },
      "no launch record",
    ],
  ];
  for (const [data, message] of bad) {
    assertThrows(() => StartSession.fromData(data), UserError, message);
  }
  // The same steps with what they need are accepted.
  StartSession.fromData({ ...base, step: "task" });
  StartSession.fromData({ ...base, step: "agent", task: "t" });
  StartSession.fromData({
    ...base,
    step: "trust",
    task: "t",
    harness: "claude",
  });
  StartSession.fromData({
    ...base,
    step: "launched",
    task: "t",
    harness: "claude",
    launch,
  });
});

Deno.test("StartSession.assertCanLaunch: passes at trust and launched only", () => {
  sessionAt("trust").assertCanLaunch();
  sessionAt("launched").assertCanLaunch();
  assertThrows(() => sessionAt("task").assertCanLaunch(), StartTransitionError);
  assertThrows(
    () => sessionAt("agent").assertCanLaunch(),
    StartTransitionError,
  );
});

Deno.test("StartSession.fromData: round-trips toData", () => {
  const data = sessionAt("launched").toData();
  assertEquals(StartSession.fromData(data).toData(), data);
});

Deno.test("StartSession.fromData: rejects a stored task that is empty", () => {
  assertThrows(() =>
    StartSession.fromData({
      id: "x",
      workspacePath: "/w",
      createdAt: NOW.toISOString(),
      step: "agent",
      task: "   ",
    })
  );
});

Deno.test("StartSession.toData: returns a copy the caller cannot use to mutate the session", () => {
  const session = sessionAt("agent");
  const data = session.toData() as { step: string };
  data.step = "launched";
  assertEquals(session.step, "agent");
});

Deno.test("StartTransitionError: names the command and the step", () => {
  const error = new StartTransitionError("go back", "task");
  assertEquals(error.name, "StartTransitionError");
  assertEquals(
    error.message,
    `Can't go back at the "task" step. Reload the page.`,
  );
});

Deno.test("StartSession.assignBriefFile: a task keeps the first brief path it gets", () => {
  const session = sessionAt("agent");
  assertEquals(session.briefFile, undefined);
  session.assignBriefFile("tasks/2026-10-03-list-my-pods.md");
  session.assignBriefFile("tasks/2026-10-03-other.md");
  assertEquals(session.briefFile, "tasks/2026-10-03-list-my-pods.md");
  assertEquals(
    StartSession.fromData(session.toData()).briefFile,
    "tasks/2026-10-03-list-my-pods.md",
  );
});

Deno.test("StartSession.assignBriefFile: refuses a path outside tasks/", () => {
  for (const bad of ["TASK.md", "tasks/../x.md", "tasks/a b.md"]) {
    assertThrows(() => sessionAt("agent").assignBriefFile(bad), UserError);
    assertThrows(
      () =>
        StartSession.fromData({
          ...sessionAt("agent").toData(),
          briefFile: bad,
        } as StartSessionData),
      UserError,
    );
  }
});
