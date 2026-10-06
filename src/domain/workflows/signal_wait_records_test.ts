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
import { SignalWait } from "./signal_wait.ts";
import {
  cancelledOutcome,
  decideSignal,
  decodeWaitOutcome,
  decodeWaitRegistration,
  encodeWaitRecord,
  isWaitExpired,
  normalizeWaitId,
  registrationOf,
  timedOutOutcome,
  WAIT_RECORD_MAX_BYTES,
  waitIdFromKey,
  waitOutcomeKey,
  type WaitRegistration,
  waitRegistrationKey,
} from "./signal_wait_records.ts";

const OPENED = new Date("2026-01-01T00:00:00.000Z");
const IN_TIME = new Date("2026-01-01T00:00:30.000Z");
const TOO_LATE = new Date("2026-01-01T00:01:00.001Z");
const SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  required: ["verdict"],
  properties: { verdict: { type: "string" as const, enum: ["ship", "fix"] } },
};
const PLACE = {
  workflowId: "wf-1",
  workflowName: "release",
  runId: "11111111-1111-4111-8111-111111111111",
  jobName: "main",
  stepName: "review",
};

function registration(): WaitRegistration {
  return registrationOf(PLACE, SignalWait.open(SCHEMA, 60, OPENED), OPENED);
}

Deno.test("normalizeWaitId: trims and lowercases a UUID and refuses anything else", () => {
  const id = "6F1C0A52-3F0E-4C4B-9D53-2F6A7C1E8B90";
  assertEquals(normalizeWaitId(`  ${id} `), id.toLowerCase());
  for (
    const raw of ["", " ", "not-a-uuid", "../x", `${id}/..`, `waits/${id}`]
  ) {
    assertEquals(normalizeWaitId(raw), undefined, raw);
  }
});

Deno.test("wait keys: each family names the wait, and no key is built from a non-UUID", () => {
  const id = "6f1c0a52-3f0e-4c4b-9d53-2f6a7c1e8b90";
  assertEquals(waitRegistrationKey(id), `waits/${id}`);
  assertEquals(waitOutcomeKey(id.toUpperCase()), `wait-outcomes/${id}`);
  assertEquals(waitIdFromKey(`waits/${id}`), id);
  assertEquals(waitIdFromKey(`wait-outcomes/${id}`), id);
  assertEquals(waitIdFromKey(`heartbeats/${id}`), undefined);
  assertEquals(waitIdFromKey("waits/readme.txt"), undefined);
  assertThrows(
    () => waitRegistrationKey("../../etc/passwd"),
    Error,
    "Not a wait id",
  );
  assertThrows(() => waitOutcomeKey(""), Error, "Not a wait id");
});

Deno.test("registrationOf: records where the wait lives and what it accepts", () => {
  const wait = SignalWait.open(SCHEMA, 60, OPENED);
  const record = registrationOf(PLACE, wait, OPENED);

  assertEquals(record, {
    kind: "signal",
    waitId: wait.id,
    ...PLACE,
    deadline: "2026-01-01T00:01:00.000Z",
    schema: SCHEMA,
    registeredAt: OPENED.toISOString(),
  });
  // The schema is a copy: the wait's own is not shared.
  assert(record.schema !== wait.schema);
});

Deno.test("wait records: a registration and each kind of outcome round-trip through their stored form", () => {
  const reg = registration();
  assertEquals(
    decodeWaitRegistration(encodeWaitRecord(reg), reg.waitId),
    { kind: "found", record: reg },
  );
  const decision = decideSignal(reg, { verdict: "ship" }, "ada", IN_TIME);
  assert(decision.accepted);
  for (
    const outcome of [
      decision.outcome,
      timedOutOutcome(reg, TOO_LATE),
      cancelledOutcome(reg, IN_TIME),
    ]
  ) {
    assertEquals(
      decodeWaitOutcome(encodeWaitRecord(outcome), reg.waitId),
      { kind: "found", record: outcome },
    );
  }
});

Deno.test("wait records: an outcome carries only the facts of its wait, not the registration's other fields", () => {
  const reg = registration();
  assertEquals(timedOutOutcome(reg, TOO_LATE), {
    kind: "timed_out",
    waitId: reg.waitId,
    workflowId: reg.workflowId,
    runId: reg.runId,
    deadline: reg.deadline,
    settledAt: TOO_LATE.toISOString(),
  });
});

Deno.test("wait records: absent reads absent, and anything that is not the wait's own valid record reads unreadable", () => {
  const reg = registration();
  const other = registration();
  const encode = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));

  assertEquals(decodeWaitRegistration(null, reg.waitId), { kind: "absent" });
  assertEquals(decodeWaitOutcome(null, reg.waitId), { kind: "absent" });

  const unreadable = [
    new Uint8Array(),
    new TextEncoder().encode("{not json"),
    encode(null),
    encode([]),
    encode({ ...reg, kind: "until" }),
    encode({ ...reg, deadline: "tomorrow" }),
    encode({ ...reg, schema: "any" }),
    // A valid record stored under another wait's key.
    encodeWaitRecord(other),
    new Uint8Array(WAIT_RECORD_MAX_BYTES + 1).fill(32),
  ];
  for (const bytes of unreadable) {
    assertEquals(decodeWaitRegistration(bytes, reg.waitId), {
      kind: "unreadable",
    });
  }

  const timedOut = timedOutOutcome(reg, TOO_LATE);
  for (
    const bytes of [
      encode({ ...timedOut, kind: "expired" }),
      encode({ ...timedOut, kind: "accepted" }),
      encode({ ...timedOut, kind: "accepted", payload: [], receipt: {} }),
      encodeWaitRecord(timedOutOutcome(other, TOO_LATE)),
      encodeWaitRecord(reg),
    ]
  ) {
    assertEquals(decodeWaitOutcome(bytes, reg.waitId), { kind: "unreadable" });
  }
});

Deno.test("isWaitExpired: only past the deadline, not at it", () => {
  const reg = registration();
  assertEquals(isWaitExpired(reg, new Date(reg.deadline)), false);
  assertEquals(isWaitExpired(reg, TOO_LATE), true);
});

Deno.test("decideSignal: an unexpired wait accepts a payload its schema allows, with a receipt swamp writes", () => {
  const reg = registration();

  const decision = decideSignal(reg, { verdict: "ship" }, "ada", IN_TIME);

  assert(decision.accepted);
  assertEquals(decision.outcome.kind, "accepted");
  assertEquals(decision.outcome.payload, { verdict: "ship" });
  assertEquals(decision.outcome.waitId, reg.waitId);
  assertEquals(decision.outcome.runId, reg.runId);
  assertEquals(decision.outcome.deadline, reg.deadline);
  assertEquals(decision.outcome.settledAt, IN_TIME.toISOString());
  assertEquals(decision.outcome.receipt.waitId, reg.waitId);
  assertEquals(decision.outcome.receipt.submittedBy, "ada");
  assertEquals(decision.outcome.receipt.receivedAt, IN_TIME.toISOString());
  assert(decision.outcome.receipt.id !== reg.waitId);
  // Each decision is its own signal.
  const again = decideSignal(reg, { verdict: "ship" }, "ada", IN_TIME);
  assert(again.accepted);
  assert(again.outcome.receipt.id !== decision.outcome.receipt.id);
});

Deno.test("decideSignal: refuses what the wait refuses, whatever else the payload holds", () => {
  const reg = registration();
  const refused: unknown[] = [
    { verdict: "maybe" },
    {},
    { verdict: "ship", note: "extra" },
    { verdict: "ship", __proto__: null, constructor: 1 },
    ["ship"],
    "ship",
    null,
    { verdict: "ship", pad: "x".repeat(17 * 1024) },
  ];
  for (const payload of refused) {
    const decision = decideSignal(reg, payload, "ada", IN_TIME);
    assert(!decision.accepted, JSON.stringify(payload)?.slice(0, 60));
    assertEquals(decision.refusal.kind, "invalid_payload");
  }
});

Deno.test("decideSignal: a wait past its deadline refuses before the payload is looked at", () => {
  const reg = registration();

  for (const payload of [{ verdict: "ship" }, { verdict: "maybe" }]) {
    const decision = decideSignal(reg, payload, "ada", TOO_LATE);
    assert(!decision.accepted);
    assertEquals(decision.refusal, {
      kind: "expired",
      deadline: new Date(reg.deadline),
    });
  }
});
