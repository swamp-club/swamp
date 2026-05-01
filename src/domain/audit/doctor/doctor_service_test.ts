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
import type { AiTool } from "../../repo/repo_service.ts";
import type {
  AuditDoctorReport,
  CheckResult,
  PreflightCheck,
  PreflightCheckName,
  SpawnFn,
} from "./check.ts";
import {
  auditDoctor,
  type AuditDoctorDeps,
  type AuditDoctorEvent,
  defaultCheckOrder,
} from "./doctor_service.ts";

const noopSpawn: SpawnFn = () =>
  Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });

function fakeCheck(
  name: PreflightCheckName,
  status: "pass" | "fail" | "skip",
  opts: { appliesTo?: (t: AiTool) => boolean } = {},
): PreflightCheck {
  return {
    name,
    description: "fake",
    appliesTo: opts.appliesTo ?? (() => true),
    run: () =>
      Promise.resolve(
        {
          name,
          status,
          message: `${name}:${status}`,
        } satisfies CheckResult,
      ),
  };
}

async function collect(
  stream: AsyncIterable<AuditDoctorEvent>,
): Promise<AuditDoctorEvent[]> {
  const events: AuditDoctorEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

function makeDeps(tool: AiTool, checks?: PreflightCheck[]): AuditDoctorDeps {
  return {
    repoPath: "/tmp/repo",
    auditDir: "/tmp/repo/.swamp/audit",
    tool,
    spawnSwamp: noopSpawn,
    abortSignal: new AbortController().signal,
    checks,
  };
}

Deno.test("auditDoctor: emits check-started, check-completed, completed in order", async () => {
  const events = await collect(auditDoctor(makeDeps("kiro", [
    fakeCheck("binary-on-path", "pass"),
  ])));
  assertEquals(events.length, 3);
  assertEquals(events[0].kind, "check-started");
  assertEquals(events[1].kind, "check-completed");
  assertEquals(events[2].kind, "completed");
});

Deno.test("auditDoctor: overall status is `pass` when every check passes", async () => {
  const events = await collect(auditDoctor(makeDeps("claude", [
    fakeCheck("binary-on-path", "pass"),
    fakeCheck("swamp-binary-on-path", "pass"),
  ])));
  const completed = events.at(-1) as Extract<
    AuditDoctorEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.report.overallStatus, "pass");
});

Deno.test("auditDoctor: overall status is `fail` when any check fails", async () => {
  const events = await collect(auditDoctor(makeDeps("claude", [
    fakeCheck("binary-on-path", "pass"),
    fakeCheck("swamp-binary-on-path", "fail"),
  ])));
  const completed = events.at(-1) as Extract<
    AuditDoctorEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.report.overallStatus, "fail");
});

Deno.test(
  "auditDoctor: failing checks do not short-circuit later checks",
  async () => {
    const events = await collect(auditDoctor(makeDeps("claude", [
      fakeCheck("binary-on-path", "fail"),
      fakeCheck("swamp-binary-on-path", "pass"),
      fakeCheck("agent-config-loadable", "pass"),
    ])));
    const results = events
      .filter((e) => e.kind === "check-completed")
      .map((e) =>
        (e as Extract<AuditDoctorEvent, { kind: "check-completed" }>).result
          .status
      );
    assertEquals(results, ["fail", "pass", "pass"]);
  },
);

Deno.test(
  "auditDoctor: checks that don't apply to the tool are emitted as skip",
  async () => {
    const events = await collect(auditDoctor(makeDeps("claude", [
      fakeCheck("binary-on-path", "pass", { appliesTo: () => true }),
      fakeCheck("default-agent-set", "pass", {
        appliesTo: (t) => t === "kiro",
      }),
    ])));
    const completedEvents = events.filter((e) => e.kind === "check-completed");
    assertEquals(completedEvents.length, 2);
    const defaultAgentResult = (completedEvents[1] as Extract<
      AuditDoctorEvent,
      { kind: "check-completed" }
    >).result;
    assertEquals(defaultAgentResult.status, "skip");
  },
);

Deno.test(
  "auditDoctor: short-circuits to a single skip for tools without audit hooks",
  async () => {
    for (const tool of ["codex", "copilot", "none"] as const) {
      const events = await collect(auditDoctor(makeDeps(tool)));
      assertEquals(events.length, 2);
      assertEquals(events[0].kind, "check-completed");
      const completed = events[1] as Extract<
        AuditDoctorEvent,
        { kind: "completed" }
      >;
      assertEquals(completed.report.overallStatus, "warn");
      assertEquals(completed.report.checks.length, 1);
      assertEquals(completed.report.checks[0].status, "skip");
    }
  },
);

Deno.test("auditDoctor: defaultCheckOrder is stable and covers all five names", () => {
  const order = defaultCheckOrder(() => Promise.resolve(null));
  const names = order.map((c) => c.name);
  assertEquals(names, [
    "binary-on-path",
    "swamp-binary-on-path",
    "agent-config-loadable",
    "default-agent-set",
    "recording-smoke-test",
  ]);
});

Deno.test("auditDoctor: a throwing check produces a `fail` result, not an unhandled exception", async () => {
  const throwingCheck: PreflightCheck = {
    name: "binary-on-path",
    description: "throws",
    appliesTo: () => true,
    run: () => {
      throw new Error("boom");
    },
  };
  const events = await collect(
    auditDoctor(makeDeps("claude", [throwingCheck])),
  );
  const completed = events.at(-1) as Extract<
    AuditDoctorEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.report.overallStatus, "fail");
  assertEquals(completed.report.checks[0].status, "fail");
});

Deno.test("auditDoctor: report carries the tool", async () => {
  const events = await collect(auditDoctor(makeDeps("cursor", [
    fakeCheck("binary-on-path", "pass"),
  ])));
  const completed = events.at(-1) as Extract<
    AuditDoctorEvent,
    { kind: "completed" }
  >;
  const report: AuditDoctorReport = completed.report;
  assertEquals(report.tool, "cursor");
});

Deno.test("auditDoctor: aborts mid-run when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const events = await collect(auditDoctor({
    ...makeDeps("claude", [
      fakeCheck("binary-on-path", "pass"),
      fakeCheck("swamp-binary-on-path", "pass"),
    ]),
    abortSignal: controller.signal,
  }));
  // Only the completed event fires — no check-started because the signal was
  // aborted before the loop body ran.
  const completed = events.at(-1) as Extract<
    AuditDoctorEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.report.checks.length, 0);
});
