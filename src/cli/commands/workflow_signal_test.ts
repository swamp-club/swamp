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
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import type {
  WorkflowSignalAddress,
  WorkflowSignalData,
} from "../../libswamp/workflows/signal.ts";
import { UserError } from "../../domain/errors.ts";
import type { CommandContext } from "../context.ts";
import { captureStdout, hintTestContext } from "./command_hint_test_helpers.ts";
import {
  parseSignalAddress,
  parseSignalPayload,
  remoteSignalPayload,
  remoteSignalUserError,
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
    "The signal takes effect when the run is next resumed, by someone who may resume it.",
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
    { workflow: "@acme/release", key: "verdict", payload: 7 },
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
