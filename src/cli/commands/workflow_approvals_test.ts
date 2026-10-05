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
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { CommandContext } from "../context.ts";
import { renderApprovals } from "./workflow_approvals.ts";

const RUN_ID = "8603d973-24ca-4f36-9c04-7b7c39a4a41a";
const PARENT_RUN_ID = "0a5c1e8e-7f4b-4c55-9a3e-2b1c0d9e8f7a";

function ctx(
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return {
    outputMode: "log",
    forceLog: false,
    verbosity: "normal",
    logger: getSwampLogger(["workflow", "approvals", "test"]),
    ...overrides,
  };
}

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

/** Runs `fn` and returns what it wrote to stdout through console.log. */
function stdout(fn: () => void): string[] {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => lines.push(msg);
  try {
    fn();
    return lines;
  } finally {
    console.log = originalLog;
  }
}

Deno.test("renderApprovals: prints each command unquoted on one line", () => {
  const lines = stdout(() => renderApprovals(ctx(), [pending()]));
  assertEquals(lines, [
    `  swamp workflow approve wipe-drive gate --run ${RUN_ID}`,
    `  swamp workflow reject  wipe-drive gate --run ${RUN_ID}`,
    `  After approval: swamp workflow resume wipe-drive --run ${RUN_ID}`,
  ]);
});

Deno.test("renderApprovals: prints the parent's resume command for a nested run", () => {
  const lines = stdout(() =>
    renderApprovals(ctx(), [
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
  const lines = stdout(() =>
    renderApprovals(ctx({ verbosity: "quiet" }), [
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
  const lines = stdout(() =>
    renderApprovals(ctx({ outputMode: "json" }), approvals)
  );
  assertEquals(JSON.parse(lines.join("\n")), { approvals });
});
