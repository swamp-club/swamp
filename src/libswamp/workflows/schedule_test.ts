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

import { assert, assertEquals } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  parsePauseUntil,
  type WorkflowScheduleDeps,
  workflowScheduleList,
  type WorkflowScheduleListEvent,
  workflowSchedulePause,
  type WorkflowSchedulePauseEvent,
  workflowScheduleResume,
  type WorkflowScheduleResumeEvent,
} from "./schedule.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import { Job } from "../../domain/workflows/job.ts";
import { Step } from "../../domain/workflows/step.ts";
import type {
  SchedulePause,
  SchedulePauseRepository,
} from "../../domain/workflows/schedule_pause.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";

const NOW = new Date("2026-10-16T12:00:00.000Z");

function workflow(name: string, schedule?: string): Workflow {
  const step = Step.fromData({
    name: "step1",
    task: {
      type: "model_method",
      modelIdOrName: "test",
      methodName: "execute",
    },
    dependsOn: [],
    weight: 0,
    allowFailure: false,
  });
  return Workflow.create({
    name,
    trigger: schedule ? { schedule } : undefined,
    jobs: [Job.fromData({
      name: "job1",
      steps: [step.toData()],
      dependsOn: [],
      weight: 0,
    })],
  });
}

function memoryPauses(): SchedulePauseRepository & {
  records: Map<string, SchedulePause>;
} {
  const records = new Map<string, SchedulePause>();
  return {
    records,
    get: (id) => Promise.resolve(records.get(id) ?? null),
    list: () => Promise.resolve([...records.values()]),
    save: (pause) => {
      records.set(pause.workflowId, pause);
      return Promise.resolve();
    },
    delete: (id) => {
      records.delete(id);
      return Promise.resolve();
    },
  };
}

function deps(
  workflows: Workflow[],
  overrides: Record<string, string> = {},
  extra: Partial<WorkflowScheduleDeps> = {},
) {
  const pauses = memoryPauses();
  const d: WorkflowScheduleDeps = {
    workflowRepo: {
      findAll: () => Promise.resolve(workflows),
      findById: (id: WorkflowId) =>
        Promise.resolve(workflows.find((w) => w.id === id) ?? null),
      findByName: (name: string) =>
        Promise.resolve(workflows.find((w) => w.name === name) ?? null),
    },
    overrideSchedules: () =>
      Promise.resolve(new Map(Object.entries(overrides))),
    pauses,
    now: () => NOW,
    ...extra,
  };
  return { deps: d, pauses };
}

async function pause(
  d: WorkflowScheduleDeps,
  input: Parameters<typeof workflowSchedulePause>[2],
) {
  const events = await collect<WorkflowSchedulePauseEvent>(
    workflowSchedulePause(createLibSwampContext(), d, input),
  );
  return events[events.length - 1];
}

async function resume(d: WorkflowScheduleDeps, workflowIdOrName: string) {
  const events = await collect<WorkflowScheduleResumeEvent>(
    workflowScheduleResume(createLibSwampContext(), d, { workflowIdOrName }),
  );
  return events[events.length - 1];
}

async function list(d: WorkflowScheduleDeps) {
  const events = await collect<WorkflowScheduleListEvent>(
    workflowScheduleList(createLibSwampContext(), d),
  );
  const last = events[events.length - 1];
  assert(last.kind === "completed");
  return last.data.schedules;
}

Deno.test("parsePauseUntil: a duration counts from now", () => {
  assertEquals(parsePauseUntil("2h", NOW), {
    until: "2026-10-16T14:00:00.000Z",
  });
  assertEquals(parsePauseUntil("30m", NOW), {
    until: "2026-10-16T12:30:00.000Z",
  });
  assertEquals(parsePauseUntil("1d", NOW), {
    until: "2026-10-17T12:00:00.000Z",
  });
});

Deno.test("parsePauseUntil: an ISO time is normalized to UTC", () => {
  assertEquals(parsePauseUntil("2026-10-16T15:00:00+02:00", NOW), {
    until: "2026-10-16T13:00:00.000Z",
  });
});

Deno.test("parsePauseUntil: refuses a past time, a zero duration and other text", () => {
  for (const value of ["2026-10-16T11:00:00Z", "0h", "tomorrow", "2026", "5"]) {
    assert("error" in parsePauseUntil(value, NOW), value);
  }
});

Deno.test("workflowSchedulePause: records a pause under the workflow id", async () => {
  const wf = workflow("nightly-gc", "0 3 * * *");
  const { deps: d, pauses } = deps([wf]);
  const result = await pause(d, {
    workflowIdOrName: "nightly-gc",
    reason: "stalling serve",
    until: "2h",
    pausedBy: "user:ops",
  });
  assert(result.kind === "completed");
  assertEquals(result.data, {
    workflowId: wf.id,
    workflowName: "nightly-gc",
    schedule: "0 3 * * *",
    reason: "stalling serve",
    pausedBy: "user:ops",
    pausedAt: NOW.toISOString(),
    until: "2026-10-16T14:00:00.000Z",
    replaced: false,
  });
  assertEquals(pauses.records.get(wf.id)?.reason, "stalling serve");
});

Deno.test("workflowSchedulePause: pausing by id and by name writes the same record", async () => {
  const wf = workflow("nightly-gc", "0 3 * * *");
  const { deps: d, pauses } = deps([wf]);
  await pause(d, { workflowIdOrName: wf.id, pausedBy: "user:a" });
  const again = await pause(d, {
    workflowIdOrName: "nightly-gc",
    pausedBy: "user:b",
  });
  assert(again.kind === "completed");
  assertEquals(again.data.replaced, true);
  assertEquals([...pauses.records.keys()], [wf.id]);
  assertEquals(pauses.records.get(wf.id)?.pausedBy, "user:b");
});

Deno.test("workflowSchedulePause: a workflow scheduled only by a serve.yaml override can be paused", async () => {
  const wf = workflow("report");
  const { deps: d } = deps([wf], { report: "0 8 * * 1-5" });
  const result = await pause(d, {
    workflowIdOrName: "report",
    pausedBy: "user:ops",
  });
  assert(result.kind === "completed");
  assertEquals(result.data.schedule, "0 8 * * 1-5");
});

Deno.test("workflowSchedulePause: refuses an unknown workflow, an unscheduled one and a bad reason or until", async () => {
  const { deps: d, pauses } = deps([workflow("manual-only")]);
  const unknown = await pause(d, { workflowIdOrName: "nope", pausedBy: "u" });
  assert(unknown.kind === "error");
  assertEquals(unknown.error.code, "not_found");

  const unscheduled = await pause(d, {
    workflowIdOrName: "manual-only",
    pausedBy: "u",
  });
  assert(unscheduled.kind === "error");
  assertEquals(unscheduled.error.code, "validation_failed");

  const badReason = await pause(d, {
    workflowIdOrName: "manual-only",
    reason: "two\nlines",
    pausedBy: "u",
  });
  assert(badReason.kind === "error");

  const badUntil = await pause(d, {
    workflowIdOrName: "manual-only",
    until: "yesterday",
    pausedBy: "u",
  });
  assert(badUntil.kind === "error");
  assertEquals(pauses.records.size, 0);
});

Deno.test("workflowScheduleResume: removes a pause and reports it was paused", async () => {
  const wf = workflow("nightly-gc", "0 3 * * *");
  const { deps: d, pauses } = deps([wf]);
  await pause(d, { workflowIdOrName: "nightly-gc", pausedBy: "u" });
  const result = await resume(d, "nightly-gc");
  assert(result.kind === "completed");
  assertEquals(result.data, {
    workflowId: wf.id,
    workflowName: "nightly-gc",
    wasPaused: true,
  });
  assertEquals(pauses.records.size, 0);
});

Deno.test("workflowScheduleResume: resuming a schedule that is not paused changes nothing", async () => {
  const { deps: d } = deps([workflow("nightly-gc", "0 3 * * *")]);
  const result = await resume(d, "nightly-gc");
  assert(result.kind === "completed");
  assertEquals(result.data.wasPaused, false);
});

Deno.test("workflowScheduleResume: an orphaned pause is removed by its workflow id", async () => {
  const { deps: d, pauses } = deps([]);
  const id = crypto.randomUUID();
  pauses.records.set(id, {
    workflowId: id,
    workflowName: "deleted-wf",
    pausedBy: "u",
    pausedAt: NOW.toISOString(),
  });
  const result = await resume(d, id);
  assert(result.kind === "completed");
  assertEquals(result.data.workflowName, "deleted-wf");
  assertEquals(pauses.records.size, 0);

  const missing = await resume(d, "no-such-workflow");
  assert(missing.kind === "error");
  assertEquals(missing.error.code, "not_found");
});

Deno.test("workflowScheduleList: shows each schedule with its pause state, source and next fire", async () => {
  const gc = workflow("nightly-gc", "0 3 * * *");
  const report = workflow("report");
  const manual = workflow("manual-only");
  const { deps: d } = deps([gc, report, manual], { report: "0 8 * * *" });
  await pause(d, {
    workflowIdOrName: "nightly-gc",
    reason: "incident",
    pausedBy: "user:ops",
  });

  const schedules = await list(d);
  assertEquals(schedules.map((s) => s.workflowName), ["nightly-gc", "report"]);
  assertEquals(schedules[0].paused, true);
  assertEquals(schedules[0].reason, "incident");
  assertEquals(schedules[0].source, "definition");
  // Croner fires in local time, as serve's scheduler does.
  const next = Date.parse(schedules[0].nextRun ?? "");
  assert(next > NOW.getTime() && next <= NOW.getTime() + 24 * 3600_000);
  assertEquals(schedules[1].paused, false);
  assertEquals(schedules[1].source, "override");
  assertEquals(schedules[1].orphaned, false);
});

Deno.test("workflowScheduleList: a lapsed pause reads as not paused", async () => {
  const wf = workflow("nightly-gc", "0 3 * * *");
  const { deps: d, pauses } = deps([wf]);
  pauses.records.set(wf.id, {
    workflowId: wf.id,
    workflowName: wf.name,
    pausedBy: "u",
    pausedAt: "2026-10-16T10:00:00.000Z",
    until: "2026-10-16T11:00:00.000Z",
  });
  const [entry] = await list(d);
  assertEquals(entry.paused, false);
  assertEquals(entry.until, undefined);
});

Deno.test("workflowScheduleList: an active pause matching no schedule is listed as orphaned", async () => {
  const { deps: d, pauses } = deps([]);
  const id = crypto.randomUUID();
  pauses.records.set(id, {
    workflowId: id,
    workflowName: "deleted-wf",
    pausedBy: "u",
    pausedAt: NOW.toISOString(),
  });
  const [entry] = await list(d);
  assertEquals(entry.orphaned, true);
  assertEquals(entry.paused, true);
  assertEquals(entry.schedule, null);
});

Deno.test("workflowScheduleList: uses the running scheduler's schedules when given", async () => {
  const wf = workflow("nightly-gc", "0 3 * * *");
  const nextRun = new Date("2026-10-16T13:00:00.000Z");
  const { deps: d } = deps([wf], {}, {
    liveSchedules: () => [{
      workflowId: wf.id,
      workflowName: wf.name,
      cronExpression: "0 * * * *",
      nextRun,
    }],
  });
  const [entry] = await list(d);
  assertEquals(entry.schedule, "0 * * * *");
  assertEquals(entry.nextRun, nextRun.toISOString());
});

Deno.test("parsePauseUntil: a time past year 9999 is an error, never a throw", () => {
  for (const value of ["99999999y", "9999-12-31T23:59-05:00"]) {
    const result = parsePauseUntil(value, NOW);
    assert("error" in result, value);
    assertEquals(result.error, `--until ${value} is too far in the future.`);
  }
  assertEquals(parsePauseUntil("9999-12-31T23:59:59Z", NOW), {
    until: "9999-12-31T23:59:59.000Z",
  });
});

Deno.test("parsePauseUntil: a time without Z or an offset is refused, naming the time zone", () => {
  const result = parsePauseUntil("2026-10-17T09:00", NOW);
  assert("error" in result);
  assertEquals(
    result.error,
    "--until 2026-10-17T09:00 has no time zone: add Z or an offset such as +02:00, or give a duration such as 2h.",
  );
  assertEquals(parsePauseUntil("2026-10-17T09:00+02:00", NOW), {
    until: "2026-10-17T07:00:00.000Z",
  });
  assertEquals(parsePauseUntil("2026-10-17t09:00z", NOW), {
    until: "2026-10-17T09:00:00.000Z",
  });
});

Deno.test("workflowSchedulePause: an --until past year 9999 is a validation error and saves nothing", async () => {
  const { deps: d, pauses } = deps([workflow("nightly-gc", "0 3 * * *")]);
  const result = await pause(d, {
    workflowIdOrName: "nightly-gc",
    until: "99999999y",
    pausedBy: "u",
  });
  assert(result.kind === "error");
  assertEquals(result.error.code, "validation_failed");
  assertEquals(pauses.records.size, 0);
});

/** Deps whose pause reads reject, as a record the process cannot read does. */
function unreadableDeps(workflows: Workflow[]) {
  const made = deps(workflows);
  made.pauses.get = () => Promise.reject(new Error("permission denied"));
  return made;
}

Deno.test("workflowSchedulePause: replaces a pause that cannot be read", async () => {
  const wf = workflow("nightly-gc", "0 3 * * *");
  const { deps: d, pauses } = unreadableDeps([wf]);
  const result = await pause(d, {
    workflowIdOrName: "nightly-gc",
    pausedBy: "u",
  });
  assert(result.kind === "completed");
  assertEquals(result.data.replaced, true);
  assertEquals(pauses.records.get(wf.id)?.pausedBy, "u");
});

Deno.test("workflowScheduleResume: removes a pause that cannot be read, by workflow and by orphan id", async () => {
  const wf = workflow("nightly-gc", "0 3 * * *");
  const { deps: d, pauses } = unreadableDeps([wf]);
  const orphan = crypto.randomUUID();
  for (const id of [wf.id, orphan]) {
    pauses.records.set(id, {
      workflowId: id,
      workflowName: "x",
      pausedBy: "u",
      pausedAt: NOW.toISOString(),
    });
  }

  const byName = await resume(d, "nightly-gc");
  assert(byName.kind === "completed");
  assertEquals(byName.data.wasPaused, true);

  const byOrphanId = await resume(d, orphan);
  assert(byOrphanId.kind === "completed");
  assertEquals(byOrphanId.data, {
    workflowId: orphan,
    workflowName: orphan,
    wasPaused: true,
  });
  assertEquals(pauses.records.size, 0);
});
