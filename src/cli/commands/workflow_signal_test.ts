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
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import type {
  WorkflowSignalAddress,
  WorkflowSignalData,
} from "../../libswamp/workflows/signal.ts";
import { UserError } from "../../domain/errors.ts";
import type { CommandContext } from "../context.ts";
import { captureStdout, hintTestContext } from "./command_hint_test_helpers.ts";
import {
  parseIdempotencyKey,
  parseSignalAddress,
  parseSignalPayload,
  remoteSignalPayload,
  remoteSignalUserError,
  renderAcceptedSignalResult,
  renderPendingSignalResult,
  renderRemoteSignalResult,
  renderSignalResult,
  signalUserError,
} from "./workflow_signal.ts";
import { SignalRefusedUserError } from "../../domain/workflows/signal_refused_user_error.ts";
import { ServerResponseError } from "../remote_run.ts";
import { buildErrorJson } from "../../presentation/output/error_output.ts";

const RUN_ID = "8603d973-24ca-4f36-9c04-7b7c39a4a41a";
const WAIT_ID = "6f1c0a52-3f0e-4c4b-9d53-2f6a7c1e8b90";

function signalled(
  overrides: Partial<WorkflowSignalData> = {},
): WorkflowSignalData {
  return {
    waitId: WAIT_ID,
    workflowId: "0a5c1e8e-7f4b-4c55-9a3e-2b1c0d9e8f7a",
    workflowName: "release",
    runId: RUN_ID,
    jobName: "release",
    stepName: "review",
    signal: {
      id: "2b1c0d9e-7f4b-4c55-9a3e-0a5c1e8e8f7a",
      waitId: WAIT_ID,
      receivedAt: "2026-01-01T00:00:00.000Z",
      submittedBy: "tester",
    },
    awaitingResume: true,
    runRecordAvailable: true,
    resumeCommand: `swamp workflow resume release --run ${RUN_ID}`,
    ...overrides,
  };
}

Deno.test("parseSignalPayload: parses JSON and leaves judging its shape to the wait", () => {
  assertEquals(parseSignalPayload('{"verdict":"ship"}'), { verdict: "ship" });
  assertEquals(parseSignalPayload("[1]"), [1]);
  assertEquals(parseSignalPayload("null"), null);
});

Deno.test("parseSignalPayload: text that is not JSON is a user error naming the flag", () => {
  for (const raw of ["", "{verdict: ship}", "ship", "{"]) {
    assertThrows(
      () => parseSignalPayload(raw),
      UserError,
      "--payload is not valid JSON",
    );
  }
});

Deno.test("renderSignalResult: log mode prints the resume command on one line", () => {
  const lines = captureStdout(() =>
    renderSignalResult(hintTestContext(), signalled())
  );
  assertEquals(lines, [
    `swamp serve resumes the run by itself where auto-resume applies. Otherwise: swamp workflow resume release --run ${RUN_ID}`,
  ]);
});

Deno.test("renderSignalResult: log mode says so when the run still waits on something else", () => {
  const lines = captureStdout(() =>
    renderSignalResult(hintTestContext(), signalled({ awaitingResume: false }))
  );
  assertEquals(lines, [
    `The run still waits on something else. Once that settles: swamp workflow resume release --run ${RUN_ID}`,
  ]);
});

Deno.test("renderSignalResult: log mode does not claim the run still waits when this host has no copy of it", () => {
  const lines = captureStdout(() =>
    renderSignalResult(
      hintTestContext(),
      signalled({ awaitingResume: false, runRecordAvailable: false }),
    )
  );
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0], "This host has no copy of the run");
  assertStringIncludes(lines[0], "swamp workflow waits");
  assertStringIncludes(
    lines[0],
    `swamp workflow resume release --run ${RUN_ID}`,
  );
  assertEquals(lines[0].startsWith("The run still waits"), false);
});

Deno.test("renderSignalResult: quiet prints no command", () => {
  const lines = captureStdout(() =>
    renderSignalResult(hintTestContext({ verbosity: "quiet" }), signalled())
  );
  assertEquals(lines, []);
});

Deno.test("renderSignalResult: json mode prints the whole result as one document", () => {
  const data = signalled();
  const lines = captureStdout(() =>
    renderSignalResult(hintTestContext({ outputMode: "json" }), data)
  );
  assertEquals(lines.length, 1);
  assertEquals(JSON.parse(lines[0]), data);
});

Deno.test("renderSignalResult: the resume command carries the repository target, in log and JSON modes", () => {
  const target = " --repo-dir /repo";
  const resume =
    `swamp workflow resume release --run ${RUN_ID} --repo-dir /repo`;

  const log = captureStdout(() =>
    renderSignalResult(hintTestContext(), signalled(), target)
  );
  assertEquals(log, [
    `swamp serve resumes the run by itself where auto-resume applies. Otherwise: ${resume}`,
  ]);

  const json = captureStdout(() =>
    renderSignalResult(
      hintTestContext({ outputMode: "json" }),
      signalled(),
      target,
    )
  );
  assertEquals(JSON.parse(json[0]).resumeCommand, resume);
});

Deno.test("renderRemoteSignalResult: a reply with only the receipt says a resume is still needed and names no run", () => {
  const data = { waitId: WAIT_ID, signal: signalled().signal };
  const lines = captureStdout(() =>
    renderRemoteSignalResult(hintTestContext(), data, "http://swamp.test")
  );
  assertEquals(lines, [
    "If the run is suspended at this wait, the signal takes effect when it is next resumed, by someone who may resume it.",
  ]);
  assertEquals(
    captureStdout(() =>
      renderRemoteSignalResult(
        hintTestContext({ verbosity: "quiet" }),
        data,
        "http://swamp.test",
      )
    ),
    [],
  );

  const json = captureStdout(() =>
    renderRemoteSignalResult(
      hintTestContext({ outputMode: "json" }),
      data,
      "http://swamp.test",
    )
  );
  assertEquals(JSON.parse(json.join("")), data);
});

Deno.test("renderRemoteSignalResult: a full reply prints the resume command with the server", () => {
  const lines = captureStdout(() =>
    renderRemoteSignalResult(
      hintTestContext(),
      signalled(),
      "http://swamp.test",
    )
  );
  assertEquals(lines, [
    `swamp serve resumes the run by itself where auto-resume applies. Otherwise: swamp workflow resume release --run ${RUN_ID} --server http://swamp.test`,
  ]);

  const json = captureStdout(() =>
    renderRemoteSignalResult(
      hintTestContext({ outputMode: "json" }),
      signalled(),
      "http://swamp.test",
    )
  );
  assertEquals(
    JSON.parse(json.join("")).resumeCommand,
    `swamp workflow resume release --run ${RUN_ID} --server http://swamp.test`,
  );
});

Deno.test("renderRemoteSignalResult: a full reply for a keyed wait names the wait, its key and the receipt", () => {
  const data = { ...signalled(), key: "release-verdict" };
  const json = captureStdout(() =>
    renderRemoteSignalResult(
      hintTestContext({ outputMode: "json" }),
      data,
      "http://swamp.test",
    )
  );
  assertEquals(JSON.parse(json.join("")).key, "release-verdict");
});

Deno.test("parseSignalAddress: a wait ID alone, or --workflow with --key, names the wait", () => {
  assertEquals(parseSignalAddress(WAIT_ID, {}), { waitId: WAIT_ID });
  assertEquals(
    parseSignalAddress(undefined, { workflow: "release", key: "verdict" }),
    { workflow: "release", key: "verdict" },
  );
});

Deno.test("parseSignalAddress: no address, both forms, or half of the key form is a user error saying what to give", () => {
  const refused: Array<
    [string | undefined, { workflow?: string; key?: string }, string]
  > = [
    [undefined, {}, "give its wait ID, or --workflow with --key"],
    [WAIT_ID, { workflow: "release", key: "verdict" }, "not both"],
    [WAIT_ID, { key: "verdict" }, "not both"],
    [WAIT_ID, { workflow: "release" }, "not both"],
    [undefined, { workflow: "release" }, "Give --workflow and --key together"],
    [undefined, { key: "verdict" }, "Give --workflow and --key together"],
  ];
  for (const [waitId, options, message] of refused) {
    assertThrows(
      () => parseSignalAddress(waitId, options),
      UserError,
      message,
    );
  }
});

Deno.test("renderSignalResult: log mode names the wait, its key and the receipt when the wait holds a key", () => {
  const result = signalled({ key: "release-verdict" });
  const logged: string[] = [];
  const logger = {
    info: (strings: TemplateStringsArray, ...values: unknown[]) => {
      logged.push(String.raw({ raw: strings }, ...values));
    },
  } as unknown as CommandContext["logger"];
  captureStdout(() => renderSignalResult(hintTestContext({ logger }), result));
  assertEquals(logged, [
    `Signalled step review in workflow release: wait ${WAIT_ID} holding key release-verdict, signal ${result.signal.id}`,
  ]);
});

Deno.test("renderSignalResult: json mode carries the key beside the wait ID and the receipt", () => {
  const result = signalled({ key: "release-verdict" });
  const lines = captureStdout(() =>
    renderSignalResult(hintTestContext({ outputMode: "json" }), result)
  );
  const printed = JSON.parse(lines[0]);
  assertEquals(printed.key, "release-verdict");
  assertEquals(printed.waitId, WAIT_ID);
  assertEquals(printed.signal, result.signal);
});

Deno.test("remoteSignalPayload: a wait ID is sent lower-cased, and a workflow and key as given", () => {
  assertEquals(
    remoteSignalPayload({ waitId: WAIT_ID.toUpperCase() }, { verdict: "ship" }),
    { waitId: WAIT_ID, payload: { verdict: "ship" } },
  );
  assertEquals(
    remoteSignalPayload({ workflow: "@acme/release", key: "verdict" }, 7),
    // A key address says this client reads a pending reply and an accepted
    // one.
    {
      workflow: "@acme/release",
      key: "verdict",
      payload: 7,
      acceptsPending: true,
      acceptsReceipt: true,
    },
  );
});

Deno.test("remoteSignalPayload: an address the server would call malformed is not found, and nothing is sent", () => {
  const refused: WorkflowSignalAddress[] = [
    { waitId: "not-a-uuid" },
    { workflow: "release", key: "Not A Key" },
    { workflow: "release", key: "" },
    { workflow: "release", key: "k".repeat(65) },
    { workflow: "", key: "verdict" },
    { workflow: "w".repeat(257), key: "verdict" },
  ];
  for (const address of refused) {
    const error = assertThrows(
      () => remoteSignalPayload(address, {}),
      UserError,
      "Signal wait not found",
    );
    assertEquals(error.code, "not_found");
  }
});

Deno.test("remoteSignalPayload: the not-found message quotes the address, hides control characters and says how to signal a long name", () => {
  const typed = assertThrows(
    () =>
      remoteSignalPayload({ workflow: "rel\u001bease", key: "Not A Key" }, {}),
    UserError,
  );
  assertStringIncludes(
    typed.message,
    'Signal wait not found: key "Not A Key" of workflow "rel?ease". No step can declare that key: a key is 1 to 64 lowercase',
  );
  // A well-formed address that is only too long gets no hint about keys.
  assertEquals(
    assertThrows(
      () => remoteSignalPayload({ workflow: "", key: "verdict" }, {}),
      UserError,
    ).message,
    'Signal wait not found: key "verdict" of workflow ""',
  );
  assertThrows(
    () =>
      remoteSignalPayload({ workflow: "w".repeat(257), key: "verdict" }, {}),
    UserError,
    "is signalled by its ID",
  );
});

const LAST_WAIT = {
  waitId: WAIT_ID,
  settledAs: "accepted",
  settledAt: "2026-01-01T00:00:30.000Z",
};

Deno.test("signalUserError: a refusal keeps its kind and the key's last wait for JSON output", () => {
  const error = signalUserError({
    code: "validation_failed",
    message: "No open wait holds that key.",
    details: { refusal: "no_open_wait", lastWait: LAST_WAIT },
  });
  assertEquals(error instanceof SignalRefusedUserError, true);
  assertEquals(buildErrorJson(error), {
    error: "No open wait holds that key.",
    code: "validation_failed",
    refusal: "no_open_wait",
    lastWait: LAST_WAIT,
  });
});

Deno.test("signalUserError: an already_pending refusal keeps until when the earlier signal is held, and its receipt, for JSON output", () => {
  const receipt = {
    id: "7a1f6f0c-2d5e-4a51-9d0b-1f6f8f0f3a22",
    receivedAt: "2026-01-01T00:00:00.000Z",
    submittedBy: "tester",
  };
  const heldUntil = "2026-01-01T00:00:10.000Z";
  // As the use case reports it: beside the refusal.
  const local = signalUserError({
    code: "validation_failed",
    message: "A signal is already pending.",
    details: { refusal: "already_pending", receipt, heldUntil },
  });
  assertEquals(buildErrorJson(local), {
    error: "A signal is already pending.",
    code: "validation_failed",
    refusal: "already_pending",
    pending: { heldUntil, receipt },
  });
  // As a server reports it to a caller who may only signal: under
  // `pending`, with no receipt and a message that names no time.
  const remote = remoteSignalUserError(
    new ServerResponseError({
      code: "workflow_signal_refused",
      message: "A signal is already pending for that key.",
      details: { refusal: "already_pending", pending: { heldUntil } },
    }),
  );
  assert(remote instanceof SignalRefusedUserError);
  assertEquals(buildErrorJson(remote), {
    error:
      `Server reported workflow_signal_refused: A signal is already pending for that key. The earlier signal is held until ${heldUntil}.`,
    code: "workflow_signal_refused",
    refusal: "already_pending",
    pending: { heldUntil },
  });
  // The receipt of another refusal is not read as a pending signal's.
  const settled = signalUserError({
    code: "validation_failed",
    message: "already settled",
    details: { refusal: "already_settled", receipt, heldUntil },
  });
  assertEquals("pending" in buildErrorJson(settled), false);
});

Deno.test("signalUserError: an error that is no refusal stays a plain user error", () => {
  const error = signalUserError({ code: "io_error", message: "disk" });
  assertEquals(error instanceof SignalRefusedUserError, false);
  assertEquals(buildErrorJson(error), { error: "disk", code: "io_error" });
});

Deno.test("remoteSignalUserError: a server's refusal keeps its kind and the key's last wait", () => {
  const error = remoteSignalUserError(
    new ServerResponseError({
      code: "workflow_signal_refused",
      message: "No open wait holds that key.",
      details: { refusal: "no_open_wait", lastWait: LAST_WAIT },
    }),
  );
  assertEquals(buildErrorJson(error as Error), {
    error:
      "Server reported workflow_signal_refused: No open wait holds that key.",
    code: "workflow_signal_refused",
    refusal: "no_open_wait",
    lastWait: LAST_WAIT,
  });
});

Deno.test("remoteSignalUserError: a last wait that is not in the form of one is dropped, and other errors pass through", () => {
  const malformed = remoteSignalUserError(
    new ServerResponseError({
      code: "workflow_signal_refused",
      message: "refused",
      details: { refusal: "no_open_wait", lastWait: { settledAs: "won" } },
    }),
  );
  assertEquals(buildErrorJson(malformed as Error), {
    error: "Server reported workflow_signal_refused: refused",
    code: "workflow_signal_refused",
    refusal: "no_open_wait",
  });

  const notFound = new ServerResponseError({
    code: "not_found",
    message: "Signal wait not found",
  });
  assertEquals(remoteSignalUserError(notFound), notFound);
  const other = new Error("socket closed");
  assertEquals(remoteSignalUserError(other), other);
});

const HELD = {
  pending: true as const,
  key: "kitchen-verdict",
  workflowId: "0a5c1e8e-7f4b-4c55-9a3e-2b1c0d9e8f7a",
  workflowName: "kitchen",
  signal: {
    id: "2b1c0d9e-7f4b-4c55-9a3e-0a5c1e8e8f7a",
    receivedAt: "2026-01-01T00:00:00.000Z",
    submittedBy: "tester",
  },
  heldUntil: "2026-01-01T00:00:10.000Z",
};

Deno.test("renderPendingSignalResult: log mode says the signal is held, not delivered, and names no run", () => {
  const lines = captureStdout(() =>
    renderPendingSignalResult(hintTestContext(), HELD)
  );
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0], "No wait holds the key yet");
  assertEquals(lines[0].includes("resume"), false);
  assertEquals(
    captureStdout(() =>
      renderPendingSignalResult(hintTestContext({ verbosity: "quiet" }), HELD)
    ),
    [],
  );
});

Deno.test("renderPendingSignalResult: a held signal says when the key's last wait was settled by a signal, so a retry is recognised", () => {
  const lastWait = {
    waitId: "b0f6f0c2-5d0e-4a51-9d0b-1f6f8f0f3a11",
    settledAs: "accepted" as const,
    settledAt: "2025-12-31T23:59:58.000Z",
    receipt: {
      id: "7a1f6f0c-2d5e-4a51-9d0b-1f6f8f0f3a22",
      receivedAt: "2025-12-31T23:59:50.000Z",
      submittedBy: "tester",
    },
  };
  const lines = captureStdout(() =>
    renderPendingSignalResult(hintTestContext(), { ...HELD, lastWait })
  );
  assertEquals(lines.length, 2);
  assertStringIncludes(lines[1], lastWait.receipt.id);
  assertStringIncludes(lines[1], lastWait.settledAt);
  assertStringIncludes(lines[1], "held for the next run");
  // A caller who may only signal is told when, not by which signal.
  const { receipt: _receipt, ...withoutReceipt } = lastWait;
  const generic = captureStdout(() =>
    renderPendingSignalResult(hintTestContext(), {
      ...HELD,
      lastWait: withoutReceipt,
    })
  );
  assertStringIncludes(generic[1], "settled by a signal at");
  // A wait that timed out says nothing of an earlier signal landing.
  const expired = captureStdout(() =>
    renderPendingSignalResult(hintTestContext(), {
      ...HELD,
      lastWait: { ...withoutReceipt, settledAs: "timed_out" },
    })
  );
  assertEquals(expired.length, 1);
});

Deno.test("renderPendingSignalResult: json mode prints the receipt and until when the signal is held", () => {
  const lines = captureStdout(() =>
    renderPendingSignalResult(hintTestContext({ outputMode: "json" }), HELD)
  );
  assertEquals(lines.length, 1);
  assertEquals(JSON.parse(lines[0]), HELD);
  // A server's reply to a caller who may only signal names no workflow; the
  // document still says the signal is pending.
  const { signal, heldUntil } = HELD;
  const remote = captureStdout(() =>
    renderPendingSignalResult(hintTestContext({ outputMode: "json" }), {
      signal,
      heldUntil,
    })
  );
  assertEquals(JSON.parse(remote[0]), { signal, heldUntil, pending: true });
});

Deno.test("renderAcceptedSignalResult: log mode says the signal was accepted and not whether a step was waiting", () => {
  const { signal } = HELD;
  const lines = captureStdout(() =>
    renderAcceptedSignalResult(hintTestContext(), { signal })
  );
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0], "does not tell this token");
  assertEquals(lines[0].includes("resume"), false);
  const duplicate = captureStdout(() =>
    renderAcceptedSignalResult(hintTestContext(), { signal, duplicate: true })
  );
  assertEquals(duplicate.length, 1);
  assertStringIncludes(duplicate[0], signal.receivedAt);
  assertEquals(
    captureStdout(() =>
      renderAcceptedSignalResult(hintTestContext({ verbosity: "quiet" }), {
        signal,
      })
    ),
    [],
  );
});

Deno.test("renderAcceptedSignalResult: json mode prints the receipt and that it was accepted", () => {
  const { signal } = HELD;
  const lines = captureStdout(() =>
    renderAcceptedSignalResult(hintTestContext({ outputMode: "json" }), {
      signal,
    })
  );
  assertEquals(lines.length, 1);
  assertEquals(JSON.parse(lines[0]), { signal, accepted: true });
});

Deno.test("renderSignalResult: a signal a wait took suggests a resume only when its run can be resumed", () => {
  const resume = `swamp workflow resume release --run ${RUN_ID}`;
  const lines = (overrides: Partial<WorkflowSignalData>) =>
    captureStdout(() =>
      renderSignalResult(
        hintTestContext(),
        signalled({ taken: true, ...overrides }),
      )
    );
  assertEquals(lines({ awaitingResume: false }), [
    "The step took the signal, and its run has nothing to resume: it went on without waiting, or it still waits on something else.",
  ]);
  // Another reader gave the signal to a wait whose run is suspended.
  assertEquals(lines({ awaitingResume: true }), [
    `The step's wait took the signal while its run was suspended. swamp serve resumes the run by itself where auto-resume applies. Otherwise: ${resume}`,
  ]);
  assertEquals(
    lines({ awaitingResume: false, runRecordAvailable: false }),
    [
      `The step's wait took the signal. This host has no copy of the run, so it cannot tell whether the run went on by itself. Check with "swamp workflow waits", and if the run is suspended resume it where it is: ${resume}`,
    ],
  );
  // JSON carries both facts, for a caller that decides by itself.
  const json = captureStdout(() =>
    renderSignalResult(
      hintTestContext({ outputMode: "json" }),
      signalled({ taken: true, awaitingResume: true }),
    )
  );
  assertEquals(JSON.parse(json[0]).taken, true);
  assertEquals(JSON.parse(json[0]).awaitingResume, true);
});

Deno.test("parseIdempotencyKey: passes a key in the form of one, and none; refuses any other", () => {
  assertEquals(parseIdempotencyKey(undefined), undefined);
  assertEquals(parseIdempotencyKey("order-1"), "order-1");
  for (const raw of ["", "has space", "a/b", "k".repeat(129)]) {
    assertThrows(
      () => parseIdempotencyKey(raw),
      UserError,
      "--idempotency-key must be",
    );
  }
});

Deno.test("remoteSignalPayload: an idempotency key is sent with either address, and left out when none was given", () => {
  assertEquals(
    remoteSignalPayload({ waitId: WAIT_ID }, {}, "order-1"),
    { waitId: WAIT_ID, payload: {}, idempotencyKey: "order-1" },
  );
  assertEquals(
    remoteSignalPayload({ workflow: "release", key: "verdict" }, {}, "order-1"),
    {
      workflow: "release",
      key: "verdict",
      payload: {},
      acceptsPending: true,
      acceptsReceipt: true,
      idempotencyKey: "order-1",
    },
  );
  assertEquals(
    "idempotencyKey" in remoteSignalPayload({ waitId: WAIT_ID }, {}),
    false,
  );
});
