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
import type {
  ExpiredApproval,
  PendingApproval,
} from "../../libswamp/workflows/approvals.ts";
import { captureStdout, hintTestContext } from "./command_hint_test_helpers.ts";
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

function expired(
  overrides: Partial<ExpiredApproval> = {},
): ExpiredApproval {
  return {
    workflowId: "wf-id",
    workflowName: "wipe-drive",
    runId: RUN_ID,
    stepName: "gate",
    suspendedAt: "2026-10-02T18:18:40.459Z",
    timeoutSeconds: 3600,
    expiredAt: "2026-10-02T19:18:40.459Z",
    serveStarted: false,
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

Deno.test("renderApprovals: JSON mode prints the approvals and expired lists", () => {
  const approvals = [pending()];
  const gates = [expired()];
  const lines = captureStdout(() =>
    renderApprovals(hintTestContext({ outputMode: "json" }), approvals, gates)
  );
  assertEquals(JSON.parse(lines.join("\n")), { approvals, expired: gates });
});

Deno.test("renderApprovals: JSON mode prints an empty expired list when none expired", () => {
  const lines = captureStdout(() =>
    renderApprovals(hintTestContext({ outputMode: "json" }), [])
  );
  assertEquals(JSON.parse(lines.join("\n")), { approvals: [], expired: [] });
});

Deno.test("renderApprovals: prints the local cancel command for an expired gate", () => {
  const lines = captureStdout(() =>
    renderApprovals(hintTestContext(), [], [expired()])
  );
  assertEquals(lines, [`  swamp workflow cancel wipe-drive --run ${RUN_ID}`]);
});

Deno.test("renderApprovals: an expired gate on a run serve started gets the --server cancel form", () => {
  const lines = captureStdout(() =>
    renderApprovals(hintTestContext(), [], [expired({ serveStarted: true })])
  );
  assertEquals(lines, [
    `  swamp workflow cancel --run ${RUN_ID} --server <url>`,
  ]);
});

Deno.test("renderApprovals: carries an explicit --server into an expired gate's cancel command", () => {
  const lines = captureStdout(() =>
    renderApprovals(
      hintTestContext(),
      [],
      [expired()],
      "ws://localhost:9090",
    )
  );
  assertEquals(lines, [
    `  swamp workflow cancel --run ${RUN_ID} --server ws://localhost:9090`,
  ]);
});

Deno.test("renderApprovals: an expired gate on a nested run names the parent's cancel command", () => {
  const lines = captureStdout(() =>
    renderApprovals(hintTestContext(), [], [
      expired({
        parentRun: {
          workflowId: "parent-id",
          workflowName: "parent-wf",
          runId: PARENT_RUN_ID,
          stepName: "child",
          serveStarted: true,
        },
        parentWaiting: true,
      }),
    ])
  );
  assertEquals(lines, [
    `  swamp workflow cancel wipe-drive --run ${RUN_ID}`,
    `  Nested run of parent-wf: the parent stays suspended after this cancel; cancel it with swamp workflow cancel --run ${PARENT_RUN_ID} --server <url>`,
  ]);
});

Deno.test("renderApprovals: an expired gate whose parent no longer waits prints no parent command", () => {
  const lines = captureStdout(() =>
    renderApprovals(hintTestContext(), [], [
      expired({
        parentRun: {
          workflowId: "parent-id",
          workflowName: "parent-wf",
          runId: PARENT_RUN_ID,
          stepName: "child",
          serveStarted: false,
        },
        parentWaiting: false,
      }),
    ])
  );
  assertEquals(lines, [`  swamp workflow cancel wipe-drive --run ${RUN_ID}`]);
});

Deno.test("renderApprovals: --quiet prints no cancel command for an expired gate", () => {
  const lines = captureStdout(() =>
    renderApprovals(hintTestContext({ verbosity: "quiet" }), [], [expired()])
  );
  assertEquals(lines, []);
});

Deno.test("renderApprovals: an expired gate's workflow name never reaches stdout raw", () => {
  const lines = captureStdout(() =>
    renderApprovals(hintTestContext(), [], [
      expired({ workflowName: "wipe drive\u001b]0;pwned\u0007" }),
    ])
  );
  assertEquals(lines, [
    `  swamp workflow cancel $'wipe drive\\x1b]0;pwned\\x07' --run ${RUN_ID}`,
  ]);
  assertEquals(lines.join("\n").includes("\u001b"), false);
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
      [],
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

Deno.test("renderApprovals: a step name carrying an escape sequence never reaches stdout raw (swamp-club#3027)", () => {
  const lines = captureStdout(() =>
    renderApprovals(hintTestContext(), [
      pending({ stepName: "gate\u001b]0;pwned\u0007" }),
    ])
  );
  assertEquals(lines, [
    `  swamp workflow approve wipe-drive $'gate\\x1b]0;pwned\\x07' --run ${RUN_ID}`,
    `  swamp workflow reject  wipe-drive $'gate\\x1b]0;pwned\\x07' --run ${RUN_ID}`,
    `  After approval: swamp workflow resume wipe-drive --run ${RUN_ID}`,
  ]);
  assertEquals(lines.join("\n").includes("\u001b"), false);
});

Deno.test("renderApprovals: a plain ESC in a step name is escaped too", () => {
  const lines = captureStdout(() =>
    renderApprovals(hintTestContext(), [pending({ stepName: "g\u001bate" })])
  );
  assertEquals(
    lines[0],
    `  swamp workflow approve wipe-drive $'g\\x1bate' --run ${RUN_ID}`,
  );
  assertEquals(lines.join("\n").includes("\u001b"), false);
});

const PARENT = {
  workflowId: "parent-id",
  workflowName: "parent-wf",
  runId: PARENT_RUN_ID,
  stepName: "child",
};
const ALL_COMMANDS = [
  `  swamp workflow approve wipe-drive gate --run ${RUN_ID}`,
  `  swamp workflow reject  wipe-drive gate --run ${RUN_ID}`,
  `  After approval: swamp workflow resume wipe-drive --run ${RUN_ID}`,
];

Deno.test("renderApprovals: a nested run whose parent ended gets only its cancel command", () => {
  const lines = captureStdout(() =>
    renderApprovals(hintTestContext(), [
      pending({ parentRun: PARENT, parentWaiting: false, parentEnded: true }),
    ])
  );
  assertEquals(lines, [`  swamp workflow cancel wipe-drive --run ${RUN_ID}`]);
});

Deno.test("renderApprovals: a nested run whose parent ended and that serve started gets the --server cancel form", () => {
  const lines = captureStdout(() =>
    renderApprovals(hintTestContext(), [
      pending({
        parentRun: PARENT,
        parentWaiting: false,
        parentEnded: true,
        serveStarted: true,
      }),
    ])
  );
  assertEquals(lines, [
    `  swamp workflow cancel --run ${RUN_ID} --server <url>`,
  ]);
});

Deno.test("renderApprovals: a nested run whose parent record is gone gets only its cancel command", () => {
  const lines = captureStdout(() =>
    renderApprovals(hintTestContext(), [
      pending({ parentRun: PARENT, parentWaiting: false, parentMissing: true }),
    ])
  );
  assertEquals(lines, [`  swamp workflow cancel wipe-drive --run ${RUN_ID}`]);
});

Deno.test("renderApprovals: through a server, a parent record it does not hold keeps every command, since the server fetches it", () => {
  const server = "http://127.0.0.1:9090";
  const lines = captureStdout(() =>
    renderApprovals(
      hintTestContext(),
      [pending({
        parentRun: PARENT,
        parentWaiting: false,
        parentMissing: true,
      })],
      [],
      server,
    )
  );
  assertEquals(lines, ALL_COMMANDS.map((line) => `${line} --server ${server}`));
});

Deno.test("renderApprovals: --quiet prints no cancel command for a nested run whose parent ended", () => {
  const lines = captureStdout(() =>
    renderApprovals(hintTestContext({ verbosity: "quiet" }), [
      pending({ parentRun: PARENT, parentWaiting: false, parentEnded: true }),
    ])
  );
  assertEquals(lines, []);
});
