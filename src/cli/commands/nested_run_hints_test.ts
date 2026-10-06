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
import {
  renderAwaitingParent,
  renderDetachedNestedRuns,
} from "./nested_run_hints.ts";
import { captureStdout, hintTestContext } from "./command_hint_test_helpers.ts";

const CHILD_RUN_ID = "8603d973-24ca-4f36-9c04-7b7c39a4a41a";
const PARENT_RUN_ID = "0a5c1e8e-7f4b-4c55-9a3e-2b1c0d9e8f7a";

const detached = {
  workflowId: "child-id",
  workflowName: "child-wf",
  runId: CHILD_RUN_ID,
  jobName: "main",
  stepName: "child",
  cancelCommand: `swamp workflow cancel child-wf --run ${CHILD_RUN_ID}`,
};

const parent = {
  workflowId: "parent-id",
  workflowName: "parent-wf",
  runId: PARENT_RUN_ID,
  resumeCommand: `swamp workflow resume parent-wf --run ${PARENT_RUN_ID}`,
};

Deno.test("renderDetachedNestedRuns: prints each cancel command unquoted on one line", () => {
  const lines = captureStdout(() =>
    renderDetachedNestedRuns(hintTestContext(), [detached])
  );
  assertEquals(lines, [
    `Cancel nested run ${CHILD_RUN_ID} with: swamp workflow cancel child-wf --run ${CHILD_RUN_ID}`,
  ]);
});

Deno.test("renderDetachedNestedRuns: --quiet prints no commands", () => {
  const lines = captureStdout(() =>
    renderDetachedNestedRuns(hintTestContext({ verbosity: "quiet" }), [
      detached,
    ])
  );
  assertEquals(lines, []);
});

Deno.test("renderAwaitingParent: prints the parent's resume command unquoted on one line", () => {
  const lines = captureStdout(() =>
    renderAwaitingParent(hintTestContext(), parent)
  );
  assertEquals(lines, [
    `Parent run ${PARENT_RUN_ID} of workflow parent-wf waits on this run. Resume it with: swamp workflow resume parent-wf --run ${PARENT_RUN_ID}`,
  ]);
});

Deno.test("renderAwaitingParent: --quiet prints nothing", () => {
  const lines = captureStdout(() =>
    renderAwaitingParent(hintTestContext({ verbosity: "quiet" }), parent)
  );
  assertEquals(lines, []);
});

Deno.test("renderDetachedNestedRuns: through serve, names the real server instead of a placeholder", () => {
  const lines = captureStdout(() =>
    renderDetachedNestedRuns(
      hintTestContext(),
      [{
        ...detached,
        cancelCommand: `${detached.cancelCommand} --server <url>`,
      }],
      { server: "ws://localhost:9090" },
    )
  );
  assertEquals(lines, [
    `Cancel nested run ${CHILD_RUN_ID} with: swamp workflow cancel child-wf --run ${CHILD_RUN_ID} --server ws://localhost:9090`,
  ]);
});

Deno.test("renderDetachedNestedRuns: JSON mode prints nothing", () => {
  const lines = captureStdout(() =>
    renderDetachedNestedRuns(hintTestContext({ outputMode: "json" }), [
      detached,
    ])
  );
  assertEquals(lines, []);
});

Deno.test("renderAwaitingParent: through serve, names the real server instead of a placeholder", () => {
  const lines = captureStdout(() =>
    renderAwaitingParent(
      hintTestContext(),
      { ...parent, resumeCommand: `${parent.resumeCommand} --server <url>` },
      { server: "ws://localhost:9090" },
    )
  );
  assertEquals(lines, [
    `Parent run ${PARENT_RUN_ID} of workflow parent-wf waits on this run. Resume it with: swamp workflow resume parent-wf --run ${PARENT_RUN_ID} --server ws://localhost:9090`,
  ]);
});

Deno.test("renderAwaitingParent: JSON mode prints nothing", () => {
  const lines = captureStdout(() =>
    renderAwaitingParent(hintTestContext({ outputMode: "json" }), parent)
  );
  assertEquals(lines, []);
});

Deno.test("renderDetachedNestedRuns: through serve, a workflow name carrying an escape sequence never reaches stdout raw (swamp-club#3027)", () => {
  const lines = captureStdout(() =>
    renderDetachedNestedRuns(
      hintTestContext(),
      [{ ...detached, workflowName: "child\u001b]0;pwned\u0007" }],
      { server: "ws://localhost:9090" },
    )
  );
  assertEquals(lines, [
    `Cancel nested run ${CHILD_RUN_ID} with: swamp workflow cancel $'child\\x1b]0;pwned\\x07' --run ${CHILD_RUN_ID} --server ws://localhost:9090`,
  ]);
  assertEquals(lines.join("\n").includes("\u001b"), false);
});

Deno.test("renderAwaitingParent: through serve, a workflow name carrying a plain ESC never reaches stdout raw", () => {
  const lines = captureStdout(() =>
    renderAwaitingParent(
      hintTestContext(),
      { ...parent, workflowName: "par\u001bent" },
      { server: "ws://localhost:9090" },
    )
  );
  assertEquals(lines.length, 1);
  assertStringIncludes(
    lines[0],
    `swamp workflow resume $'par\\x1bent' --run ${PARENT_RUN_ID}`,
  );
  assertEquals(lines[0].includes("\u001b"), false);
});
