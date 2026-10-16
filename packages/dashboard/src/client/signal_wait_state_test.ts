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
import {
  heldAt,
  pendingSignalRows,
  signalWaitRows,
} from "./signal_wait_state.ts";

const place = {
  workflowId: "wf-1",
  workflowName: "deploy",
  runId: "run-1",
  jobName: "main",
  stepName: "await-verdict",
  deadline: "2026-10-09T00:00:00.000Z",
};

Deno.test("signalWaitRows: lists nothing for a refused or missing reply", () => {
  assertEquals(signalWaitRows(null), []);
  assertEquals(signalWaitRows(undefined), []);
  assertEquals(signalWaitRows({}), []);
  assertEquals(signalWaitRows({ data: null }), []);
  assertEquals(signalWaitRows({ data: { waits: "nope" } }), []);
});

Deno.test("signalWaitRows: an open wait carries its schema and the signal command", () => {
  const rows = signalWaitRows({
    data: {
      waits: [{
        ...place,
        waitId: "w-open",
        expired: false,
        schema: { properties: {} },
        nextCommand: "swamp workflow signal w-open --payload '<json>'",
      }],
      unreadableWaits: [],
    },
  });
  assertEquals(rows, [{
    waitId: "w-open",
    state: "open",
    workflowName: "deploy",
    runId: "run-1",
    stepName: "await-verdict",
    deadline: place.deadline,
    schema: { properties: {} },
    awaitingResume: false,
    command: "swamp workflow signal w-open --payload '<json>'",
  }]);
});

Deno.test("signalWaitRows: an expired wait drops its schema", () => {
  const [row] = signalWaitRows({
    data: {
      waits: [{
        ...place,
        waitId: "w-old",
        expired: true,
        schema: { properties: {} },
        nextCommand: "swamp workflow resume deploy --run run-1",
      }],
    },
  });
  assertEquals(row.state, "expired");
  assertEquals("schema" in row, false);
});

Deno.test("signalWaitRows: a signalled wait carries its receipt and whether the run can resume", () => {
  const signal = {
    id: "sig-1",
    waitId: "w-done",
    receivedAt: "2026-10-08T12:00:00.000Z",
    submittedBy: "user:ada",
  };
  const rows = signalWaitRows({
    data: {
      waits: [],
      signalled: [
        { ...place, waitId: "w-done", signal, awaitingResume: true },
        { ...place, waitId: "w-held", signal: { ...signal, id: "sig-2" } },
      ],
    },
  });
  assertEquals(rows.map((r) => [r.waitId, r.state, r.awaitingResume]), [
    ["w-done", "signalled", true],
    ["w-held", "signalled", false],
  ]);
  assertEquals(rows[0].receipt, {
    id: "sig-1",
    submittedBy: "user:ada",
    receivedAt: "2026-10-08T12:00:00.000Z",
  });
});

Deno.test("signalWaitRows: orders open waits, then signalled, then expired", () => {
  const rows = signalWaitRows({
    data: {
      waits: [
        { ...place, waitId: "expired", expired: true },
        { ...place, waitId: "open" },
      ],
      signalled: [{ ...place, waitId: "signalled", signal: { id: "s" } }],
    },
  });
  assertEquals(rows.map((r) => r.waitId), ["open", "signalled", "expired"]);
});

Deno.test("signalWaitRows: leaves out an entry missing what a row needs", () => {
  const rows = signalWaitRows({
    data: {
      waits: [{ ...place }, null, "x", { ...place, waitId: "ok" }],
      signalled: [{ ...place, waitId: "no-receipt" }],
    },
  });
  assertEquals(rows.map((r) => r.waitId), ["ok"]);
});

Deno.test("signalWaitRows: a keyed open wait carries its key and the by-key command", () => {
  const [row] = signalWaitRows({
    data: {
      waits: [{
        ...place,
        waitId: "w-key",
        key: "order-42",
        nextCommand: "swamp workflow signal w-key --payload '<json>'",
        signalByKeyCommand:
          "swamp workflow signal --workflow deploy --key order-42 --payload '<json>'",
      }],
    },
  });
  assertEquals(row.key, "order-42");
  assertEquals(
    row.signalByKeyCommand,
    "swamp workflow signal --workflow deploy --key order-42 --payload '<json>'",
  );
  assertEquals(row.command, "swamp workflow signal w-key --payload '<json>'");
});

Deno.test("signalWaitRows: a wait from a serve without keys has neither key field", () => {
  const [row] = signalWaitRows({
    data: { waits: [{ ...place, waitId: "w-old", nextCommand: "x" }] },
  });
  assertEquals("key" in row, false);
  assertEquals("signalByKeyCommand" in row, false);
});

const held = {
  workflowId: "wf-1",
  workflowName: "deploy",
  key: "order-42",
  receiptId: "sig-1",
  receivedAt: "2026-10-08T12:00:00.000Z",
  heldUntil: "2026-10-08T13:00:00.000Z",
  submittedBy: "user:ada",
};

Deno.test("pendingSignalRows: lists nothing for a reply without pending signals", () => {
  assertEquals(pendingSignalRows(null), []);
  assertEquals(pendingSignalRows({}), []);
  assertEquals(pendingSignalRows({ data: null }), []);
  assertEquals(pendingSignalRows({ data: { waits: [] } }), []);
  assertEquals(pendingSignalRows({ data: { pending: "nope" } }), []);
  assertEquals(pendingSignalRows({ data: { waits: [], pending: [] } }), []);
});

Deno.test("pendingSignalRows: carries every field and sorts by heldUntil", () => {
  const rows = pendingSignalRows({
    data: {
      pending: [
        { ...held, receiptId: "late", heldUntil: "2026-10-08T15:00:00.000Z" },
        held,
        { ...held, receiptId: "mid", heldUntil: "2026-10-08T14:00:00Z" },
      ],
    },
  });
  assertEquals(rows.map((r) => r.receiptId), ["sig-1", "mid", "late"]);
  assertEquals(rows[0], held);
});

Deno.test("pendingSignalRows: leaves out an entry missing what a row needs", () => {
  const rows = pendingSignalRows({
    data: {
      pending: [
        null,
        { ...held, key: "" },
        { ...held, receiptId: undefined },
        { ...held, heldUntil: "not a time" },
        { ...held, receiptId: "ok" },
      ],
    },
  });
  assertEquals(rows.map((r) => r.receiptId), ["ok"]);
});

Deno.test("pendingSignalRows: with now, leaves out a signal held until before now and keeps one held until now, as serve does", () => {
  const now = Date.parse("2026-10-08T13:00:00.000Z");
  const rows = pendingSignalRows(
    {
      data: {
        pending: [
          { ...held, receiptId: "lapsed", heldUntil: "2026-10-08T12:59:00Z" },
          held,
          { ...held, receiptId: "live", heldUntil: "2026-10-08T13:00:01Z" },
        ],
      },
    },
    now,
  );
  assertEquals(rows.map((r) => r.receiptId), [held.receiptId, "live"]);
});

Deno.test("heldAt: keeps every row without now and the live ones in order with it", () => {
  const rows = [
    held,
    { ...held, receiptId: "b", heldUntil: "2026-10-08T14:00:00.000Z" },
  ];
  assertEquals(heldAt(rows), rows);
  assertEquals(
    heldAt(rows, Date.parse("2026-10-08T13:30:00.000Z")).map((r) =>
      r.receiptId
    ),
    ["b"],
  );
});
