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

import { assert, assertEquals, assertThrows } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { parseWorkflowRunSummary } from "./workflow_run_summary.ts";

Deno.test("parseWorkflowRunSummary: projects the displayed fields", () => {
  const summary = parseWorkflowRunSummary({
    id: "run-1",
    workflowId: "wf-1",
    workflowName: "deploy",
    status: "succeeded",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    tags: { env: "prod" },
    inputs: { region: "us-east-1" },
  });

  assertEquals(summary.id, "run-1");
  assertEquals(summary.workflowId, "wf-1");
  assertEquals(summary.workflowName, "deploy");
  assertEquals(summary.status, "succeeded");
  assertEquals(summary.startedAt?.toISOString(), "2026-01-01T00:00:00.000Z");
  assertEquals(summary.completedAt?.toISOString(), "2026-01-01T00:01:00.000Z");
  assertEquals(summary.tags, { env: "prod" });
  assertEquals(summary.inputs, { region: "us-east-1" });
});

Deno.test("parseWorkflowRunSummary: defaults tags and inputs to empty objects", () => {
  const summary = parseWorkflowRunSummary({
    id: "run-1",
    workflowId: "wf-1",
    workflowName: "deploy",
    status: "running",
  });

  assertEquals(summary.tags, {});
  assertEquals(summary.inputs, {});
  assertEquals(summary.startedAt, undefined);
  assertEquals(summary.completedAt, undefined);
});

Deno.test("parseWorkflowRunSummary: never retains the heavy jobs/output subtree", () => {
  const summary = parseWorkflowRunSummary({
    id: "run-1",
    workflowId: "wf-1",
    workflowName: "deploy",
    status: "succeeded",
    startedAt: "2026-01-01T00:00:00.000Z",
    // A run carries the full job/step tree with unbounded inline step outputs.
    jobs: [
      {
        jobName: "job1",
        status: "succeeded",
        steps: [
          { stepName: "step1", status: "succeeded", output: "x".repeat(10000) },
        ],
      },
    ],
    workflowDataArtifacts: [{ some: "artifact" }],
  });

  // The projection keeps only the summary fields — the heavy subtrees are
  // stripped and never held on the returned object.
  assert(!("jobs" in summary), "summary must not carry jobs");
  assert(!("output" in summary), "summary must not carry output");
  assert(
    !("workflowDataArtifacts" in summary),
    "summary must not carry data artifacts",
  );
  assertEquals(Object.keys(summary).sort(), [
    "completedAt",
    "id",
    "inputs",
    "startedAt",
    "status",
    "tags",
    "workflowId",
    "workflowName",
  ]);
});

Deno.test("parseWorkflowRunSummary: succeeds even when the jobs subtree is malformed", () => {
  // A record whose heavy subtree would fail full WorkflowRunSchema validation
  // (jobs is not an array; step status is not a valid enum) must still yield a
  // usable summary — proving the summary path does NOT reconstruct the
  // aggregate via WorkflowRun.fromData.
  const summary = parseWorkflowRunSummary({
    id: "run-1",
    workflowId: "wf-1",
    workflowName: "deploy",
    status: "succeeded",
    startedAt: "2026-01-01T00:00:00.000Z",
    jobs: "totally-not-an-array",
  });

  assertEquals(summary.id, "run-1");
  assertEquals(summary.status, "succeeded");
});

Deno.test("parseWorkflowRunSummary: rejects records missing required identity fields", () => {
  assertThrows(() =>
    parseWorkflowRunSummary({
      workflowId: "wf-1",
      workflowName: "deploy",
      status: "succeeded",
    })
  );
});

// Regression guard for the OOM in #1173. A YAML parser returns scalar fields as
// V8 sliced strings that pin the whole source buffer; retaining thousands of
// summaries would therefore keep every run file (jobs and all) alive and blow
// the heap. This runs the real parseYaml -> parseWorkflowRunSummary path in a
// child process under a tight old-space cap: if the projection stops detaching
// its strings, the child OOMs and this test fails. Run as a subprocess so the
// heap flag is isolated from the main test runner.
Deno.test("parseWorkflowRunSummary: does not retain the parsed source buffer (OOM guard)", async () => {
  const summaryModule = import.meta.resolve("./workflow_run_summary.ts");
  const denoConfig = fromFileUrl(import.meta.resolve("../../../deno.json"));

  // 6000 runs x ~80 KB source = ~480 MB if the source buffers are retained;
  // the detached summaries need only a few MB, so a 128 MB old-space cap
  // passes when detached and OOMs when not.
  const child = `
    import { parse as parseYaml } from "@std/yaml";
    import { parseWorkflowRunSummary } from ${JSON.stringify(summaryModule)};
    const summaries = [];
    for (let i = 0; i < 6000; i++) {
      const source = [
        "id: run-" + i,
        "workflowId: wf-1",
        "workflowName: deploy",
        "status: succeeded",
        "startedAt: '2026-01-01T00:00:00.000Z'",
        "jobs: '" + "x".repeat(80000) + "'",
        "tags: {}",
      ].join("\\n") + "\\n";
      summaries.push(parseWorkflowRunSummary(parseYaml(source)));
    }
    if (summaries.length !== 6000) throw new Error("unexpected count");
    console.log("RETENTION_OK");
  `;

  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--config",
      denoConfig,
      "--v8-flags=--max-old-space-size=128",
      "-",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const process = command.spawn();
  const writer = process.stdin.getWriter();
  await writer.write(new TextEncoder().encode(child));
  await writer.close();
  const { code, stdout } = await process.output();
  const out = new TextDecoder().decode(stdout);

  assertEquals(
    code,
    0,
    "child OOMed or errored — summary projection likely retains parsed source buffers",
  );
  assert(out.includes("RETENTION_OK"), "child did not complete the loop");
});
