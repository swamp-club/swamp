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
import type { WorkflowApproveData } from "../../libswamp/mod.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { CommandContext } from "../context.ts";
import { renderApproveResult, serveIsResuming } from "./workflow_approve.ts";

Deno.test("serveIsResuming: true only when serve reports it resumed the run", () => {
  assertEquals(serveIsResuming({ autoResumed: true }), true);
  assertEquals(serveIsResuming({ autoResumed: false }), false);
  // An older serve that predates auto-resume sends no flag.
  assertEquals(serveIsResuming({}), false);
});

const RUN_ID = "8603d973-24ca-4f36-9c04-7b7c39a4a41a";

function ctx(
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return {
    outputMode: "log",
    forceLog: false,
    verbosity: "normal",
    logger: getSwampLogger(["workflow", "approve", "test"]),
    ...overrides,
  };
}

function approval(
  overrides: Partial<WorkflowApproveData> = {},
): WorkflowApproveData {
  return {
    runId: RUN_ID,
    workflowName: "wipe-drive",
    stepName: "gate",
    approved: true,
    decidedBy: "tester",
    reason: null,
    allGatesDecided: true,
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

Deno.test("renderApproveResult: prints the resume command unquoted on one line", () => {
  const lines = stdout(() => renderApproveResult(ctx(), approval()));
  assertEquals(lines, [
    `After approval: swamp workflow resume wipe-drive --run ${RUN_ID}`,
  ]);
});

Deno.test("renderApproveResult: names the real server instead of a placeholder", () => {
  const lines = stdout(() =>
    renderApproveResult(ctx(), approval(), {
      server: "ws://localhost:9090",
      serveResuming: false,
    })
  );
  assertEquals(lines, [
    `After approval: swamp workflow resume wipe-drive --run ${RUN_ID} --server ws://localhost:9090`,
  ]);
});

Deno.test("renderApproveResult: leaves --server out when the server came from the environment", () => {
  const lines = stdout(() =>
    renderApproveResult(ctx(), approval(), { serveResuming: false })
  );
  assertEquals(lines, [
    `After approval: swamp workflow resume wipe-drive --run ${RUN_ID}`,
  ]);
});

Deno.test("renderApproveResult: prints no resume command when serve resumes the run", () => {
  const lines = stdout(() =>
    renderApproveResult(ctx(), approval(), {
      server: "ws://localhost:9090",
      serveResuming: true,
    })
  );
  assertEquals(lines, []);
});

Deno.test("renderApproveResult: prints the parent's resume command for a nested run", () => {
  const resumeCommand =
    "swamp workflow resume parent-wf --run 0a5c1e8e-7f4b-4c55-9a3e-2b1c0d9e8f7a";
  const lines = stdout(() =>
    renderApproveResult(
      ctx(),
      approval({
        awaitingParent: {
          workflowId: "parent-id",
          workflowName: "parent-wf",
          runId: "0a5c1e8e-7f4b-4c55-9a3e-2b1c0d9e8f7a",
          resumeCommand,
        },
      }),
    )
  );
  assertEquals(lines, [
    `After approval: swamp workflow resume wipe-drive --run ${RUN_ID}`,
    `Once it finishes, resume the parent run: ${resumeCommand}`,
  ]);
});

Deno.test("renderApproveResult: --quiet prints no commands", () => {
  const lines = stdout(() =>
    renderApproveResult(ctx({ verbosity: "quiet" }), approval())
  );
  assertEquals(lines, []);
});

Deno.test("renderApproveResult: JSON mode prints only the approval", () => {
  const data = approval();
  const lines = stdout(() =>
    renderApproveResult(ctx({ outputMode: "json" }), data)
  );
  assertEquals(lines.map((l) => JSON.parse(l)), [data]);
});
