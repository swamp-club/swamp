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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { DoctorWorkflowsReport } from "../../libswamp/mod.ts";
import { createWorkflowDoctorRenderer } from "./workflow_doctor.ts";

await initializeLogging({});

function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(
      args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
    );
  };
  return Promise.resolve(fn())
    .finally(() => {
      console.log = originalLog;
    })
    .then(() => lines.join("\n"));
}

function buildPassReport(): DoctorWorkflowsReport {
  return {
    overallStatus: "pass",
    workflows: [
      {
        file: "/repo/workflows/workflow-abc.yaml",
        name: "deploy",
        status: "pass",
      },
      {
        file: "/repo/workflows/workflow-def.yaml",
        name: "sync",
        status: "pass",
      },
    ],
    totalPassed: 2,
    totalFailed: 0,
  };
}

function buildFailReport(): DoctorWorkflowsReport {
  return {
    overallStatus: "fail",
    workflows: [
      {
        file: "/repo/workflows/workflow-abc.yaml",
        name: "deploy",
        status: "pass",
      },
      {
        file: "/repo/workflows/workflow-broken.yaml",
        name: "broken",
        status: "fail",
        error: "YAML parse error at line 42, column 15",
      },
    ],
    totalPassed: 1,
    totalFailed: 1,
  };
}

function buildEmptyReport(): DoctorWorkflowsReport {
  return {
    overallStatus: "pass",
    workflows: [],
    totalPassed: 0,
    totalFailed: 0,
  };
}

Deno.test("workflow_doctor json renderer: emits structured report on pass", async () => {
  const out = await captureStdout(async () => {
    const r = createWorkflowDoctorRenderer("json");
    const handlers = r.handlers();
    await handlers.completed({ kind: "completed", report: buildPassReport() });
  });

  const parsed = JSON.parse(out);
  assertEquals(parsed.overallStatus, "pass");
  assertEquals(parsed.workflows.length, 2);
  assertEquals(parsed.totalPassed, 2);
  assertEquals(parsed.totalFailed, 0);
});

Deno.test("workflow_doctor json renderer: emits structured report on fail", async () => {
  const out = await captureStdout(async () => {
    const r = createWorkflowDoctorRenderer("json");
    const handlers = r.handlers();
    await handlers.completed({ kind: "completed", report: buildFailReport() });
  });

  const parsed = JSON.parse(out);
  assertEquals(parsed.overallStatus, "fail");
  assertEquals(parsed.totalFailed, 1);
  assertEquals(
    parsed.workflows[1].error,
    "YAML parse error at line 42, column 15",
  );
});

Deno.test("workflow_doctor json renderer: tracks overallStatus", async () => {
  const r = createWorkflowDoctorRenderer("json");
  assertEquals(r.overallStatus, "pass");
  const handlers = r.handlers();
  await handlers.completed({ kind: "completed", report: buildFailReport() });
  assertEquals(r.overallStatus, "fail");
});

Deno.test("workflow_doctor log renderer: tracks overallStatus on fail", async () => {
  const r = createWorkflowDoctorRenderer("log");
  assertEquals(r.overallStatus, "pass");
  const handlers = r.handlers();
  await handlers.completed({ kind: "completed", report: buildFailReport() });
  assertEquals(r.overallStatus, "fail");
});

Deno.test("workflow_doctor log renderer: handles workflow-checked without throwing", async () => {
  const r = createWorkflowDoctorRenderer("log");
  const handlers = r.handlers();
  await handlers["workflow-checked"]({
    kind: "workflow-checked",
    result: { file: "/repo/wf.yaml", name: "deploy", status: "pass" },
  });
  await handlers["workflow-checked"]({
    kind: "workflow-checked",
    result: {
      file: "/repo/bad.yaml",
      name: "broken",
      status: "fail",
      error: "parse error",
    },
  });
  await handlers.completed({ kind: "completed", report: buildFailReport() });
  assertEquals(r.overallStatus, "fail");
});

Deno.test("workflow_doctor log renderer: handles empty report", async () => {
  const r = createWorkflowDoctorRenderer("log");
  const handlers = r.handlers();
  await handlers.completed({ kind: "completed", report: buildEmptyReport() });
  assertEquals(r.overallStatus, "pass");
});

Deno.test("workflow_doctor json renderer: handles empty report", async () => {
  const out = await captureStdout(async () => {
    const r = createWorkflowDoctorRenderer("json");
    const handlers = r.handlers();
    await handlers.completed({ kind: "completed", report: buildEmptyReport() });
  });

  const parsed = JSON.parse(out);
  assertEquals(parsed.overallStatus, "pass");
  assertEquals(parsed.workflows.length, 0);
});
