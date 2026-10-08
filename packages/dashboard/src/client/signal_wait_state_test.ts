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
import { signalWaitRows } from "./signal_wait_state.ts";

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
