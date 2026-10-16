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
  PendingSignalInfo,
  SignalWaitInfo,
  UnreadableWaitInfo,
  WorkflowWaitsData,
} from "../../libswamp/workflows/waits.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { InMemorySignalWaitStore } from "../../domain/workflows/signal_wait_store_test_helpers.ts";
import { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowWaitsPayload } from "../../serve/protocol.ts";
import { captureStdout, hintTestContext } from "./command_hint_test_helpers.ts";
import {
  listLocalWaits,
  listServerWaits,
  localWaitsDeps,
  renderWaits,
} from "./workflow_waits.ts";

const RUN_ID = "8603d973-24ca-4f36-9c04-7b7c39a4a41a";
const WAIT_ID = "6f1c0a52-3f0e-4c4b-9d53-2f6a7c1e8b90";

function wait(overrides: Partial<SignalWaitInfo> = {}): SignalWaitInfo {
  return {
    waitId: WAIT_ID,
    workflowId: "0a5c1e8e-7f4b-4c55-9a3e-2b1c0d9e8f7a",
    workflowName: "release",
    runId: RUN_ID,
    jobName: "release",
    stepName: "review",
    waitingSince: "2026-01-01T00:00:00.000Z",
    deadline: "2026-01-02T00:00:00.000Z",
    expired: false,
    schema: {
      type: "object",
      properties: { verdict: { type: "string", enum: ["ship", "fix"] } },
    },
    nextCommand: `swamp workflow signal ${WAIT_ID} --payload '<json>'`,
    ...overrides,
  };
}

function listed(
  waits: SignalWaitInfo[],
  unreadableWaits: UnreadableWaitInfo[] = [],
): WorkflowWaitsData {
  return { waits, unreadableWaits };
}

const UNREADABLE: UnreadableWaitInfo = {
  workflowId: "0a5c1e8e-7f4b-4c55-9a3e-2b1c0d9e8f7a",
  workflowName: "release",
  runId: RUN_ID,
  jobName: "release",
  stepName: "review",
  nextCommand: `swamp workflow resume release --run ${RUN_ID}`,
};

Deno.test("renderWaits: log mode prints the signal command for an open wait", () => {
  const lines = captureStdout(() =>
    renderWaits(hintTestContext(), listed([wait()]))
  );
  assertEquals(lines, [
    `  swamp workflow signal ${WAIT_ID} --payload '<json>'`,
  ]);
});

Deno.test("renderWaits: log mode prints the resume command for an expired wait", () => {
  const resume = `swamp workflow resume release --run ${RUN_ID}`;
  const lines = captureStdout(() =>
    renderWaits(
      hintTestContext(),
      listed([wait({ expired: true, nextCommand: resume })]),
    )
  );
  assertEquals(lines, [`  ${resume}`]);
});

Deno.test("renderWaits: log mode prints one command per wait, in the order given", () => {
  const other = "11111111-1111-4111-8111-111111111111";
  const lines = captureStdout(() =>
    renderWaits(
      hintTestContext(),
      listed([
        wait(),
        wait({
          waitId: other,
          nextCommand: `swamp workflow signal ${other} --payload '<json>'`,
        }),
      ]),
    )
  );
  assertEquals(lines, [
    `  swamp workflow signal ${WAIT_ID} --payload '<json>'`,
    `  swamp workflow signal ${other} --payload '<json>'`,
  ]);
});

Deno.test("renderWaits: quiet and an empty list print no command", () => {
  assertEquals(
    captureStdout(() =>
      renderWaits(hintTestContext({ verbosity: "quiet" }), listed([wait()]))
    ),
    [],
  );
  assertEquals(
    captureStdout(() => renderWaits(hintTestContext(), listed([]))),
    [],
  );
});

Deno.test("renderWaits: json mode prints every field of every wait", () => {
  const waits = [wait(), wait({ expired: true })];
  const lines = captureStdout(() =>
    renderWaits(hintTestContext({ outputMode: "json" }), listed(waits))
  );
  assertEquals(lines.length, 1);
  assertEquals(JSON.parse(lines[0]), { waits, unreadableWaits: [] });
});

Deno.test("renderWaits: json mode prints an empty list as a document", () => {
  const lines = captureStdout(() =>
    renderWaits(hintTestContext({ outputMode: "json" }), listed([]))
  );
  assertEquals(JSON.parse(lines[0]), { waits: [], unreadableWaits: [] });
});

Deno.test("renderWaits: every printed command carries the repository target, in log and JSON modes", () => {
  const target = " --repo-dir /repo";
  const data = listed([wait()], [UNREADABLE]);

  const log = captureStdout(() => renderWaits(hintTestContext(), data, target));
  assertEquals(log, [
    `  swamp workflow signal ${WAIT_ID} --payload '<json>' --repo-dir /repo`,
    `  swamp workflow resume release --run ${RUN_ID} --repo-dir /repo`,
  ]);

  const json = captureStdout(() =>
    renderWaits(hintTestContext({ outputMode: "json" }), data, target)
  );
  const parsed = JSON.parse(json[0]);
  assertEquals(
    parsed.waits[0].nextCommand,
    `swamp workflow signal ${WAIT_ID} --payload '<json>' --repo-dir /repo`,
  );
  assertEquals(
    parsed.unreadableWaits[0].nextCommand,
    `swamp workflow resume release --run ${RUN_ID} --repo-dir /repo`,
  );
});

Deno.test("renderWaits: an unreadable wait is listed with its resume command, and is not an empty list", () => {
  const lines = captureStdout(() =>
    renderWaits(hintTestContext(), listed([], [UNREADABLE]))
  );
  assertEquals(lines, [`  swamp workflow resume release --run ${RUN_ID}`]);

  const json = captureStdout(() =>
    renderWaits(
      hintTestContext({ outputMode: "json" }),
      listed([], [UNREADABLE]),
    )
  );
  assertEquals(JSON.parse(json[0]), {
    waits: [],
    unreadableWaits: [UNREADABLE],
  });
});

Deno.test("renderWaits: a keyed wait shows its key in JSON and in the log lines, and an unkeyed wait shows none", () => {
  const keyed = wait({ key: "kitchen-verdict" });
  const json = captureStdout(() =>
    renderWaits(
      hintTestContext({ outputMode: "json" }),
      listed([keyed, wait()]),
    )
  );
  const printed = JSON.parse(json[0]) as { waits: SignalWaitInfo[] };
  assertEquals(printed.waits.map((w) => w.key), [
    "kitchen-verdict",
    undefined,
  ]);

  const logged: string[] = [];
  const logger = {
    info: (message: string, properties?: Record<string, unknown>) =>
      logged.push(
        message.replace(
          /\{(\w+)\}/g,
          (_match, name) => String(properties?.[name]),
        ),
      ),
    warn: () => {},
  } as unknown as ReturnType<typeof hintTestContext>["logger"];
  captureStdout(() =>
    renderWaits(hintTestContext({ logger }), listed([keyed, wait()]))
  );
  assertEquals(logged.filter((line) => line.includes("Key:")), [
    "  Key:      kitchen-verdict",
  ]);
});

const KEY_COMMAND =
  "swamp workflow signal --workflow release --key kitchen-verdict --payload '<json>'";

const PENDING: PendingSignalInfo = {
  workflowId: "0a5c1e8e-7f4b-4c55-9a3e-2b1c0d9e8f7a",
  workflowName: "release",
  key: "kitchen-verdict",
  receiptId: "3c7d2e10-5b4a-4f6e-8d9c-1a2b3c4d5e6f",
  receivedAt: "2026-01-01T00:00:00.000Z",
  heldUntil: "2026-01-01T00:01:00.000Z",
  submittedBy: "camera",
};

/** A logger that records each info and warn line with its properties filled in. */
function recordingLogger() {
  const info: string[] = [];
  const warn: string[] = [];
  const fill = (message: string, properties?: Record<string, unknown>) =>
    message.replace(/\{(\w+)\}/g, (_match, name) => String(properties?.[name]));
  const logger = {
    info: (message: string, properties?: Record<string, unknown>) =>
      info.push(fill(message, properties)),
    warn: (message: string, properties?: Record<string, unknown>) =>
      warn.push(fill(message, properties)),
  } as unknown as ReturnType<typeof hintTestContext>["logger"];
  return { info, warn, logger };
}

/** A server that answers `workflow.waits` with `data`, recording each request. */
function fakeServer(data: Record<string, unknown>) {
  const sent: Array<{ type: string; payload?: WorkflowWaitsPayload }> = [];
  return {
    sent,
    request: (
      request: { type: "workflow.waits"; payload?: WorkflowWaitsPayload },
    ) => {
      sent.push(request);
      return Promise.resolve({ data });
    },
  };
}

Deno.test("renderWaits: a keyed open wait prints its by-key command after the by-ID command, and quiet prints neither", () => {
  const keyed = wait({
    key: "kitchen-verdict",
    signalByKeyCommand: KEY_COMMAND,
  });
  assertEquals(
    captureStdout(() => renderWaits(hintTestContext(), listed([keyed]))),
    [
      `  swamp workflow signal ${WAIT_ID} --payload '<json>'`,
      `  ${KEY_COMMAND}`,
    ],
  );
  assertEquals(
    captureStdout(() =>
      renderWaits(hintTestContext({ verbosity: "quiet" }), listed([keyed]))
    ),
    [],
  );
});

Deno.test("renderWaits: --server is carried on the by-key command, in log and JSON modes", () => {
  const target = " --server wss://swamp.example.com";
  const data = listed([
    wait({ key: "kitchen-verdict", signalByKeyCommand: KEY_COMMAND }),
  ]);
  assertEquals(
    captureStdout(() => renderWaits(hintTestContext(), data, target)),
    [
      `  swamp workflow signal ${WAIT_ID} --payload '<json>'${target}`,
      `  ${KEY_COMMAND}${target}`,
    ],
  );
  const json = captureStdout(() =>
    renderWaits(hintTestContext({ outputMode: "json" }), data, target)
  );
  const printed = JSON.parse(json[0]) as { waits: SignalWaitInfo[] };
  assertEquals(printed.waits[0].signalByKeyCommand, `${KEY_COMMAND}${target}`);
  assertEquals(
    printed.waits[0].nextCommand,
    `swamp workflow signal ${WAIT_ID} --payload '<json>'${target}`,
  );
});

Deno.test("renderWaits: a wait without a by-key command gets none in JSON", () => {
  const json = captureStdout(() =>
    renderWaits(
      hintTestContext({ outputMode: "json" }),
      listed([wait()]),
      " --repo-dir /repo",
    )
  );
  assertEquals("signalByKeyCommand" in JSON.parse(json[0]).waits[0], false);
});

Deno.test("renderWaits: log mode lists pending signals by key, workflow, receipt, received, held until and sender", () => {
  const { info, warn, logger } = recordingLogger();
  captureStdout(() =>
    renderWaits(
      hintTestContext({ logger }),
      { ...listed([]), pending: [PENDING] },
      "",
      { pendingAsked: true },
    )
  );
  assertEquals(info, [
    "No workflows waiting for a signal",
    "Pending signals, each held for the next wait of its key:",
    `release — pending signal ${PENDING.receiptId}`,
    "  Key:        kitchen-verdict",
    "  Received:   2026-01-01T00:00:00.000Z",
    "  Held until: 2026-01-01T00:01:00.000Z",
    "  Sender:     camera",
  ]);
  assertEquals(warn, []);
});

Deno.test("renderWaits: an empty pending list says so, and no pending list says nothing unless --pending was given", () => {
  const empty = recordingLogger();
  captureStdout(() =>
    renderWaits(
      hintTestContext({ logger: empty.logger }),
      { ...listed([wait()]), pending: [] },
      "",
      { pendingAsked: true },
    )
  );
  assertEquals(empty.info.at(-1), "No pending signals");

  const unasked = recordingLogger();
  captureStdout(() =>
    renderWaits(hintTestContext({ logger: unasked.logger }), listed([wait()]))
  );
  assertEquals(unasked.info.some((line) => line.includes("ending")), false);
  assertEquals(unasked.warn, []);
});

Deno.test("renderWaits: JSON carries pending only when the listing does", () => {
  const withPending = captureStdout(() =>
    renderWaits(
      hintTestContext({ outputMode: "json" }),
      { ...listed([]), pending: [PENDING] },
      "",
      { pendingAsked: true },
    )
  );
  assertEquals(JSON.parse(withPending[0]), {
    waits: [],
    unreadableWaits: [],
    pending: [PENDING],
  });

  const without = captureStdout(() =>
    renderWaits(hintTestContext({ outputMode: "json" }), listed([]))
  );
  assertEquals(JSON.parse(without[0]), { waits: [], unreadableWaits: [] });
});

Deno.test("listServerWaits: --pending asks the server for pending signals and passes them on", async () => {
  const server = fakeServer({
    waits: [wait({ key: "kitchen-verdict", signalByKeyCommand: KEY_COMMAND })],
    unreadableWaits: [],
    pending: [PENDING],
  });
  const data = await listServerWaits(server.request, { includePending: true });
  assertEquals(server.sent, [{
    type: "workflow.waits",
    payload: { includePending: true },
  }]);
  assertEquals(data.pending, [PENDING]);
  // The key a server lists on a wait survives to the output.
  assertEquals(data.waits[0].key, "kitchen-verdict");
  const json = captureStdout(() =>
    renderWaits(
      hintTestContext({ outputMode: "json" }),
      data,
      " --server wss://swamp.example.com",
      { pendingAsked: true },
    )
  );
  const printed = JSON.parse(json[0]);
  assertEquals(printed.waits[0].key, "kitchen-verdict");
  assertEquals(printed.pending, [PENDING]);
});

Deno.test("listServerWaits: without --pending sends no payload and passes no pending list on", async () => {
  const server = fakeServer({
    waits: [],
    unreadableWaits: [],
    pending: [PENDING],
  });
  const data = await listServerWaits(server.request);
  assertEquals(server.sent, [{ type: "workflow.waits" }]);
  assertEquals("pending" in data, false);
  const json = captureStdout(() =>
    renderWaits(hintTestContext({ outputMode: "json" }), data)
  );
  assertEquals("pending" in JSON.parse(json[0]), false);
});

Deno.test("listServerWaits: a server that predates pending-signal listing is warned of in log mode, and JSON omits pending", async () => {
  const server = fakeServer({ waits: [wait()], unreadableWaits: [] });
  const data = await listServerWaits(server.request, { includePending: true });
  assertEquals("pending" in data, false);

  const { warn, logger } = recordingLogger();
  captureStdout(() =>
    renderWaits(hintTestContext({ logger }), data, "", { pendingAsked: true })
  );
  assertEquals(warn, [
    "The server did not list pending signals; it may predate --pending. Upgrade swamp on the server to list them.",
  ]);

  const json = captureStdout(() =>
    renderWaits(hintTestContext({ outputMode: "json" }), data, "", {
      pendingAsked: true,
    })
  );
  assertEquals("pending" in JSON.parse(json[0]), false);
});

Deno.test("listLocalWaits: --pending lists a signal sent through the local CLI under the workflow the repository names for its ID", async () => {
  const workflow = Workflow.create({ name: "kitchen", jobs: [] });
  const store = new InMemorySignalWaitStore();
  const receivedAt = new Date().toISOString();
  await store.createPendingRecord({
    kind: "pending",
    workflowId: workflow.id,
    key: "verdict",
    slot: 1,
    number: 1,
    receiptId: crypto.randomUUID(),
    receivedAt,
    submittedBy: "camera",
    payload: { verdict: "ship" },
    acceptEarly: 3600,
  });
  const deps = localWaitsDeps(
    {
      workflowRunRepo: {
        findGlobalByStatus: () => Promise.resolve([]),
        findById: () => Promise.resolve(null),
      },
      signalWaits: { supported: true, store },
      workflowRepo: {
        findAll: () => Promise.resolve([workflow]),
        findAllById: (id: string) =>
          Promise.resolve(id === workflow.id ? [workflow] : []),
      },
    } as unknown as Parameters<typeof localWaitsDeps>[0],
  );

  const data = await listLocalWaits(createLibSwampContext(), deps, {
    includePending: true,
  });
  assertEquals(
    data.pending?.map((p) => [p.workflowName, p.key, p.submittedBy]),
    [["kitchen", "verdict", "camera"]],
  );

  const unasked = await listLocalWaits(createLibSwampContext(), deps);
  assertEquals("pending" in unasked, false);
});
