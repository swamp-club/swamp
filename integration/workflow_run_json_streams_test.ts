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

/**
 * In --json mode, `withConsoleGuard` owns the global console while any model
 * method runs. These tests hold a guard open on a promise gate — so it is known
 * to be active, with no sleeps or step scheduling — and fire the JSON
 * workflow-run renderer's handlers inside it. They pin that swamp's own output
 * never passes through the guard: side-lines reach stderr exactly once, stdout
 * receives only the run document, and nothing lands in the method's logs
 * (swamp-club#2547).
 */

import { assertEquals } from "@std/assert";
import {
  setConsoleGuardStderrWriter,
  withConsoleGuard,
} from "../src/domain/models/console_guard.ts";
import type { WorkflowRunView } from "../src/libswamp/workflows/workflow_run_view.ts";
import { createWorkflowRunRenderer } from "../src/presentation/renderers/workflow_run.ts";

function cancelledRun(): WorkflowRunView {
  return {
    id: crypto.randomUUID(),
    workflowId: "wf-1",
    workflowName: "guard-repro",
    status: "cancelled",
    jobs: [{
      name: "main",
      status: "running",
      steps: [
        { name: "deploy", status: "running" },
        {
          name: "cleanup",
          status: "skipped",
          skipReason: { kind: "guarded", expression: "true" },
        },
      ],
    }],
  };
}

Deno.test("JSON workflow run: renderer output inside an active console guard is never captured", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const captured: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (msg: string) => stdout.push(msg);
  console.error = (msg: string) => stderr.push(msg);
  setConsoleGuardStderrWriter((line) => captured.push(line));

  const methodLogs: string[] = [];
  const gate = Promise.withResolvers<void>();
  const guardActive = Promise.withResolvers<void>();

  try {
    const method = withConsoleGuard(
      async () => {
        guardActive.resolve();
        await gate.promise;
      },
      methodLogs,
      { jsonMode: true },
    );
    await guardActive.promise;

    const handlers = createWorkflowRunRenderer("json", {
      workflowName: "guard-repro",
    }).handlers();
    handlers.superseded_runs({
      kind: "superseded_runs",
      cancelledRunIds: ["run-0"],
    });
    handlers.step_skipped({
      kind: "step_skipped",
      jobId: "main",
      stepId: "cleanup",
      reason: "guarded",
      guardExpression: "true",
      guardResult: true,
    });
    handlers.method_event({
      kind: "method_event",
      jobId: "main",
      stepId: "deploy",
      modelName: "deploy-shell",
      methodName: "execute",
      event: { type: "vault_single_quote_warning", message: "use quotes" },
    });
    // A cancel that lands while a method which ignored the abort still runs.
    const run = cancelledRun();
    handlers.cancelled({ kind: "cancelled", run });

    gate.resolve();
    await method;

    assertEquals(methodLogs, []);
    assertEquals(captured, []);
    assertEquals(stderr.map((line) => JSON.parse(line)), [
      { event: "superseded_runs", cancelledRunIds: ["run-0"] },
      {
        step: "cleanup",
        job: "main",
        status: "skipped",
        reason: "guarded",
        guardExpression: "true",
        guardResult: true,
      },
      {
        warning: "vault_single_quote",
        modelName: "deploy-shell",
        message: "use quotes",
      },
    ]);
    assertEquals(stdout.length, 1);
    assertEquals(JSON.parse(stdout[0]), run);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    setConsoleGuardStderrWriter(undefined);
  }
});

for (const releaseOrder of [["a", "b"], ["b", "a"]] as const) {
  Deno.test(`JSON workflow run: extension output under two guards reaches stderr once (release ${releaseOrder.join(" then ")})`, async () => {
    const captured: string[] = [];
    setConsoleGuardStderrWriter((line) => captured.push(line));
    const logs = { a: [] as string[], b: [] as string[] };
    const gates = {
      a: Promise.withResolvers<void>(),
      b: Promise.withResolvers<void>(),
    };
    const active = {
      a: Promise.withResolvers<void>(),
      b: Promise.withResolvers<void>(),
    };

    try {
      const guards = (["a", "b"] as const).map((id) =>
        withConsoleGuard(
          async () => {
            active[id].resolve();
            await gates[id].promise;
          },
          logs[id],
          { jsonMode: true },
        )
      );
      await Promise.all([active.a.promise, active.b.promise]);

      console.log("extension line");

      for (const id of releaseOrder) gates[id].resolve();
      await Promise.all(guards);

      assertEquals(captured, ["extension line"]);
      assertEquals(logs.a, ["extension line"]);
      assertEquals(logs.b, ["extension line"]);
    } finally {
      setConsoleGuardStderrWriter(undefined);
    }
  });
}
