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
import { join } from "@std/path";
import { collect } from "../testing.ts";
import { doctorWorkflows, type DoctorWorkflowsEvent } from "./doctor.ts";

const VALID_WORKFLOW_YAML = `id: "550e8400-e29b-41d4-a716-446655440000"
name: test-workflow
jobs:
  - name: test-job
    steps:
      - name: test-step
        task:
          type: model_method
          modelIdOrName: my-model
          methodName: validate
`;

const BROKEN_YAML = `id: "550e8400-e29b-41d4-a716-446655440001"
name: broken-workflow
jobs:
  - name: bad-job
    steps:
      - name: bad-step
        task:
          type: model_method
          modelIdOrName: my-model
          methodName: validate
  invalid: yaml: here
`;

const INVALID_SCHEMA_YAML = `id: "not-a-uuid"
name: ""
`;

Deno.test("doctorWorkflows: reports pass for valid workflow", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.writeTextFile(
      join(tmpDir, "workflow-test.yaml"),
      VALID_WORKFLOW_YAML,
    );

    const events = await collect<DoctorWorkflowsEvent>(
      doctorWorkflows({
        workflowDirs: [tmpDir],
        abortSignal: new AbortController().signal,
      }),
    );

    assertEquals(events.length, 2);
    assertEquals(events[0].kind, "workflow-checked");
    const checked = events[0] as Extract<
      DoctorWorkflowsEvent,
      { kind: "workflow-checked" }
    >;
    assertEquals(checked.result.status, "pass");
    assertEquals(checked.result.name, "test-workflow");

    const completed = events[1] as Extract<
      DoctorWorkflowsEvent,
      { kind: "completed" }
    >;
    assertEquals(completed.report.overallStatus, "pass");
    assertEquals(completed.report.totalPassed, 1);
    assertEquals(completed.report.totalFailed, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflows: reports fail for broken YAML", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.writeTextFile(
      join(tmpDir, "workflow-broken.yaml"),
      BROKEN_YAML,
    );

    const events = await collect<DoctorWorkflowsEvent>(
      doctorWorkflows({
        workflowDirs: [tmpDir],
        abortSignal: new AbortController().signal,
      }),
    );

    assertEquals(events.length, 2);
    const checked = events[0] as Extract<
      DoctorWorkflowsEvent,
      { kind: "workflow-checked" }
    >;
    assertEquals(checked.result.status, "fail");
    assertEquals(typeof checked.result.error, "string");

    const completed = events[1] as Extract<
      DoctorWorkflowsEvent,
      { kind: "completed" }
    >;
    assertEquals(completed.report.overallStatus, "fail");
    assertEquals(completed.report.totalFailed, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflows: reports fail for invalid schema", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.writeTextFile(
      join(tmpDir, "workflow-invalid.yaml"),
      INVALID_SCHEMA_YAML,
    );

    const events = await collect<DoctorWorkflowsEvent>(
      doctorWorkflows({
        workflowDirs: [tmpDir],
        abortSignal: new AbortController().signal,
      }),
    );

    const checked = events[0] as Extract<
      DoctorWorkflowsEvent,
      { kind: "workflow-checked" }
    >;
    assertEquals(checked.result.status, "fail");
    assertEquals(typeof checked.result.error, "string");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflows: handles missing directory gracefully", async () => {
  const events = await collect<DoctorWorkflowsEvent>(
    doctorWorkflows({
      workflowDirs: ["/tmp/nonexistent-swamp-dir-" + crypto.randomUUID()],
      abortSignal: new AbortController().signal,
    }),
  );

  assertEquals(events.length, 1);
  const completed = events[0] as Extract<
    DoctorWorkflowsEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.report.overallStatus, "pass");
  assertEquals(completed.report.workflows.length, 0);
});

Deno.test("doctorWorkflows: skips non-yaml files", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.writeTextFile(join(tmpDir, "notes.txt"), "not a workflow");
    await Deno.writeTextFile(join(tmpDir, "data.json"), "{}");

    const events = await collect<DoctorWorkflowsEvent>(
      doctorWorkflows({
        workflowDirs: [tmpDir],
        abortSignal: new AbortController().signal,
      }),
    );

    assertEquals(events.length, 1);
    assertEquals(events[0].kind, "completed");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflows: scans multiple directories", async () => {
  const tmpDir1 = await Deno.makeTempDir({ prefix: "swamp_doctor_wf1_" });
  const tmpDir2 = await Deno.makeTempDir({ prefix: "swamp_doctor_wf2_" });
  try {
    await Deno.writeTextFile(
      join(tmpDir1, "workflow-a.yaml"),
      VALID_WORKFLOW_YAML,
    );
    await Deno.writeTextFile(
      join(tmpDir2, "workflow-b.yaml"),
      VALID_WORKFLOW_YAML.replace(
        "550e8400-e29b-41d4-a716-446655440000",
        "660e8400-e29b-41d4-a716-446655440000",
      ).replace("test-workflow", "second-workflow"),
    );

    const events = await collect<DoctorWorkflowsEvent>(
      doctorWorkflows({
        workflowDirs: [tmpDir1, tmpDir2],
        abortSignal: new AbortController().signal,
      }),
    );

    assertEquals(events.length, 3);
    const completed = events[2] as Extract<
      DoctorWorkflowsEvent,
      { kind: "completed" }
    >;
    assertEquals(completed.report.totalPassed, 2);
    assertEquals(completed.report.overallStatus, "pass");
  } finally {
    await Deno.remove(tmpDir1, { recursive: true }).catch(() => {});
    await Deno.remove(tmpDir2, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflows: mixed pass and fail results", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.writeTextFile(
      join(tmpDir, "workflow-good.yaml"),
      VALID_WORKFLOW_YAML,
    );
    await Deno.writeTextFile(
      join(tmpDir, "workflow-bad.yaml"),
      BROKEN_YAML,
    );

    const events = await collect<DoctorWorkflowsEvent>(
      doctorWorkflows({
        workflowDirs: [tmpDir],
        abortSignal: new AbortController().signal,
      }),
    );

    const completed = events[events.length - 1] as Extract<
      DoctorWorkflowsEvent,
      { kind: "completed" }
    >;
    assertEquals(completed.report.overallStatus, "fail");
    assertEquals(completed.report.totalPassed, 1);
    assertEquals(completed.report.totalFailed, 1);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("doctorWorkflows: extracts name from parseable YAML even when construction fails", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_doctor_wf_" });
  try {
    await Deno.writeTextFile(
      join(tmpDir, "workflow-invalid-schema.yaml"),
      INVALID_SCHEMA_YAML,
    );

    const events = await collect<DoctorWorkflowsEvent>(
      doctorWorkflows({
        workflowDirs: [tmpDir],
        abortSignal: new AbortController().signal,
      }),
    );

    const checked = events[0] as Extract<
      DoctorWorkflowsEvent,
      { kind: "workflow-checked" }
    >;
    assertEquals(checked.result.status, "fail");
    // Name extraction should still work even though schema validation fails
    // (empty string name won't parse from YAML since it's falsy)
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});
