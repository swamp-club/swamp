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
import type { PendingApproval } from "../../libswamp/mod.ts";
import {
  captureStdout,
  hintTestContext,
} from "./approval_hint_test_helpers.ts";
import { renderApprovals } from "./workflow_approvals.ts";

const RUN_ID = "8603d973-24ca-4f36-9c04-7b7c39a4a41a";
const PARENT_RUN_ID = "0a5c1e8e-7f4b-4c55-9a3e-2b1c0d9e8f7a";

function pending(
  overrides: Partial<PendingApproval> = {},
): PendingApproval {
  return {
    workflowId: "wf-id",
    workflowName: "wipe-drive",
    runId: RUN_ID,
    stepName: "gate",
    suspendedAt: "2026-10-02T18:18:40.459Z",
    prompt: "Wipe it?",
    inputs: {},
    ...overrides,
  };
}

Deno.test("renderApprovals: prints each command unquoted on one line", () => {
  const lines = captureStdout(() =>
    renderApprovals(hintTestContext(), [pending()])
  );
  assertEquals(lines, [
    `  swamp workflow approve wipe-drive gate --run ${RUN_ID}`,
    `  swamp workflow reject  wipe-drive gate --run ${RUN_ID}`,
    `  After approval: swamp workflow resume wipe-drive --run ${RUN_ID}`,
  ]);
});

Deno.test("renderApprovals: prints the parent's resume command for a nested run", () => {
  const lines = captureStdout(() =>
    renderApprovals(hintTestContext(), [
      pending({
        parentRun: {
          workflowId: "parent-id",
          workflowName: "parent-wf",
          runId: PARENT_RUN_ID,
          stepName: "child",
        },
        parentWaiting: true,
      }),
    ])
  );
  assertEquals(
    lines.at(-1),
    `  Nested run of parent-wf: once this run finishes, swamp workflow resume parent-wf --run ${PARENT_RUN_ID}`,
  );
});

Deno.test("renderApprovals: --quiet prints no commands", () => {
  const lines = captureStdout(() =>
    renderApprovals(hintTestContext({ verbosity: "quiet" }), [
      pending({
        parentRun: {
          workflowId: "parent-id",
          workflowName: "parent-wf",
          runId: PARENT_RUN_ID,
          stepName: "child",
        },
        parentWaiting: true,
      }),
    ])
  );
  assertEquals(lines, []);
});

Deno.test("renderApprovals: JSON mode prints only the approvals list", () => {
  const approvals = [pending()];
  const lines = captureStdout(() =>
    renderApprovals(hintTestContext({ outputMode: "json" }), approvals)
  );
  assertEquals(JSON.parse(lines.join("\n")), { approvals });
});

Deno.test("renderApprovals: shell-quotes a step name with spaces or shell syntax", () => {
  const lines = captureStdout(() =>
    renderApprovals(hintTestContext(), [
      pending({ stepName: "verify build; rm -rf x" }),
    ])
  );
  assertEquals(lines, [
    `  swamp workflow approve wipe-drive 'verify build; rm -rf x' --run ${RUN_ID}`,
    `  swamp workflow reject  wipe-drive 'verify build; rm -rf x' --run ${RUN_ID}`,
    `  After approval: swamp workflow resume wipe-drive --run ${RUN_ID}`,
  ]);
});

Deno.test("renderApprovals: carries an explicit --server into every command", () => {
  const lines = captureStdout(() =>
    renderApprovals(
      hintTestContext(),
      [
        pending({
          parentRun: {
            workflowId: "parent-id",
            workflowName: "parent-wf",
            runId: PARENT_RUN_ID,
            stepName: "child",
          },
          parentWaiting: true,
        }),
      ],
      "ws://localhost:9090",
    )
  );
  assertEquals(lines, [
    `  swamp workflow approve wipe-drive gate --run ${RUN_ID} --server ws://localhost:9090`,
    `  swamp workflow reject  wipe-drive gate --run ${RUN_ID} --server ws://localhost:9090`,
    `  After approval: swamp workflow resume wipe-drive --run ${RUN_ID} --server ws://localhost:9090`,
    `  Nested run of parent-wf: once this run finishes, swamp workflow resume parent-wf --run ${PARENT_RUN_ID} --server ws://localhost:9090`,
  ]);
});
