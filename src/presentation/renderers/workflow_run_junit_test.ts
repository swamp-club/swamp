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
import { escapeXml, JUnitWorkflowRunRenderer } from "./workflow_run_junit.ts";
import type { WorkflowRunView } from "../../libswamp/mod.ts";

Deno.test("escapeXml: escapes ampersand", () => {
  assertEquals(escapeXml("a & b"), "a &amp; b");
});

Deno.test("escapeXml: escapes angle brackets", () => {
  assertEquals(escapeXml("<tag>"), "&lt;tag&gt;");
});

Deno.test("escapeXml: escapes quotes", () => {
  assertEquals(escapeXml('say "hello"'), "say &quot;hello&quot;");
  assertEquals(escapeXml("it's"), "it&apos;s");
});

Deno.test("escapeXml: handles empty string", () => {
  assertEquals(escapeXml(""), "");
});

Deno.test("escapeXml: passes through safe strings", () => {
  assertEquals(escapeXml("hello world 123"), "hello world 123");
});

Deno.test("escapeXml: strips XML 1.0 illegal control characters", () => {
  assertEquals(escapeXml("hello\x00world"), "helloworld");
  assertEquals(escapeXml("tab\x08here"), "tabhere");
  assertEquals(escapeXml("a\x0Bb"), "ab");
});

Deno.test("escapeXml: preserves legal whitespace", () => {
  assertEquals(escapeXml("line\nbreak"), "line\nbreak");
  assertEquals(escapeXml("tab\there"), "tab\there");
  assertEquals(escapeXml("cr\rhere"), "cr\rhere");
});

function makeRunView(
  status: "succeeded" | "failed" = "succeeded",
): WorkflowRunView {
  return {
    id: "run-1",
    workflowId: "wf-1",
    workflowName: "test-workflow",
    status,
    jobs: [{
      name: "job1",
      status: "succeeded" as const,
      steps: [],
    }],
    duration: 100,
  };
}

Deno.test("JUnitWorkflowRunRenderer: eval error appears as <error> element", async () => {
  const outFile = await Deno.makeTempFile({ suffix: ".xml" });
  try {
    const renderer = new JUnitWorkflowRunRenderer({ outFile });
    const h = renderer.handlers();

    h.started({
      kind: "started",
      runId: "run-1",
      workflowName: "test-workflow",
      jobs: [{ id: "verify", stepCount: 2, dependsOn: [] }],
    });
    h.step_started({
      kind: "step_started",
      jobId: "verify",
      stepId: "assert-true",
    });
    h.assert_result({
      kind: "assert_result",
      jobId: "verify",
      stepId: "assert-true",
      passed: true,
      message: "trivially true",
      severity: "high",
      expr: "1 == 1",
    });
    h.step_started({
      kind: "step_started",
      jobId: "verify",
      stepId: "assert-error",
    });
    h.assert_result({
      kind: "assert_result",
      jobId: "verify",
      stepId: "assert-error",
      passed: false,
      message: "No such key: attributes",
      severity: "high",
      expr: 'data.latest("m", "s").attributes.x',
      error: "No such key: attributes",
    });

    await h.completed({
      kind: "completed",
      run: makeRunView("failed"),
    });

    const xml = await Deno.readTextFile(outFile);

    assertStringIncludes(xml, 'tests="2"');
    assertStringIncludes(xml, 'errors="1"');
    assertStringIncludes(xml, 'failures="0"');
    assertStringIncludes(xml, "<error message=");
    assertStringIncludes(xml, 'type="ExpressionEvaluationError"');
    assertStringIncludes(xml, 'name="assert-error"');
    assertStringIncludes(xml, 'name="assert-true"');
  } finally {
    await Deno.remove(outFile);
  }
});

Deno.test("JUnitWorkflowRunRenderer: clean failure uses <failure> element", async () => {
  const outFile = await Deno.makeTempFile({ suffix: ".xml" });
  try {
    const renderer = new JUnitWorkflowRunRenderer({ outFile });
    const h = renderer.handlers();

    h.started({
      kind: "started",
      runId: "run-1",
      workflowName: "test-workflow",
      jobs: [{ id: "verify", stepCount: 1, dependsOn: [] }],
    });
    h.step_started({
      kind: "step_started",
      jobId: "verify",
      stepId: "assert-false",
    });
    h.assert_result({
      kind: "assert_result",
      jobId: "verify",
      stepId: "assert-false",
      passed: false,
      message: "expected true",
      severity: "high",
      expr: "1 == 2",
    });

    await h.completed({
      kind: "completed",
      run: makeRunView("failed"),
    });

    const xml = await Deno.readTextFile(outFile);

    assertStringIncludes(xml, 'tests="1"');
    assertStringIncludes(xml, 'failures="1"');
    assertStringIncludes(xml, 'errors="0"');
    assertStringIncludes(xml, "<failure message=");
    assertStringIncludes(xml, 'type="AssertionFailure"');
  } finally {
    await Deno.remove(outFile);
  }
});
