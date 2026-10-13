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
  mergeActiveRuns,
  trackedWorkflowRuns,
} from "./local_dashboard_server.ts";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const TTL = 90_000;

function row(
  over: Partial<{
    id: string;
    runKind: string;
    workflowName: string | null;
    startedAt: Date;
    heartbeatAt: Date;
  }> = {},
) {
  return {
    id: "run-1",
    runKind: "workflow",
    workflowName: "greet",
    startedAt: new Date(NOW - 5_000),
    heartbeatAt: new Date(NOW - 1_000),
    ...over,
  };
}

Deno.test("trackedWorkflowRuns: a running CLI workflow is an active run", () => {
  assertEquals(trackedWorkflowRuns([row()], NOW, TTL), [{
    runId: "run-1",
    kind: "workflow",
    resourceName: "greet",
    durationMs: 5_000,
    principalId: null,
  }]);
});

Deno.test("trackedWorkflowRuns: a run that stopped heartbeating is left out", () => {
  assertEquals(
    trackedWorkflowRuns(
      [row({ heartbeatAt: new Date(NOW - TTL) })],
      NOW,
      TTL,
    ),
    [],
  );
});

Deno.test("trackedWorkflowRuns: model method runs are left out", () => {
  assertEquals(
    trackedWorkflowRuns(
      [row({ runKind: "model_method", workflowName: null })],
      NOW,
      TTL,
    ),
    [],
  );
});

Deno.test("mergeActiveRuns: keeps this server's runs and adds tracked ones it doesn't have", () => {
  const own = {
    runId: "a",
    kind: "workflow",
    resourceName: "w",
    durationMs: 1,
    principalId: "me",
  };
  const trackedSame = { ...own, principalId: null };
  const trackedOther = { ...own, runId: "b", principalId: null };
  assertEquals(mergeActiveRuns([own], [trackedSame, trackedOther]), [
    own,
    trackedOther,
  ]);
  assertEquals(mergeActiveRuns([], []), []);
});
