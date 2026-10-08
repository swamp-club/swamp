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
import { expiredApprovals, pendingApprovals } from "./approvals.ts";

const pending = { workflowName: "deploy", runId: "run-1", stepName: "gate" };
const expired = {
  workflowId: "wf-1",
  workflowName: "wipe",
  runId: "run-2",
  stepName: "gate",
  suspendedAt: "2026-10-02T18:18:40.459Z",
  timeoutSeconds: 3600,
  expiredAt: "2026-10-02T19:18:40.459Z",
};

Deno.test("pendingApprovals: reads the approvals list, not the expired one", () => {
  const payload = { data: { approvals: [pending], expired: [expired] } };
  assertEquals(pendingApprovals(payload), [pending]);
  assertEquals(expiredApprovals(payload), [expired]);
});

Deno.test("pendingApprovals: reads by key when expired is listed first", () => {
  const payload = { data: { expired: [expired], approvals: [pending] } };
  assertEquals(pendingApprovals(payload), [pending]);
  assertEquals(expiredApprovals(payload), [expired]);
});

Deno.test("pendingApprovals: no pending gates while some expired counts none", () => {
  const payload = { data: { approvals: [], expired: [expired] } };
  assertEquals(pendingApprovals(payload), []);
});

Deno.test("expiredApprovals: empty for a serve that sends no expired list", () => {
  assertEquals(expiredApprovals({ data: { approvals: [pending] } }), []);
});

Deno.test("pendingApprovals: empty before the reply arrives or for a malformed one", () => {
  for (
    const payload of [null, undefined, "x", {}, { data: null }, {
      data: { approvals: "nope", expired: 3 },
    }]
  ) {
    assertEquals(pendingApprovals(payload), []);
    assertEquals(expiredApprovals(payload), []);
  }
});
