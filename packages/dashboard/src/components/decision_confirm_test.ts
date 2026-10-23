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

import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  type DecidedGate,
  decidedGate,
  decidedLabel,
  decisionOutcome,
  decisionReason,
  gateKey,
  MAX_DECISION_REASON_LENGTH,
  pruneDecided,
  refusalMessage,
} from "./decision_confirm.ts";

const AT = "2026-10-22T12:00:00.000Z";
const gate = { runId: "run-1", stepName: "approval" };

Deno.test("pruneDecided: a decided gate stays held while a stale listing still has it", () => {
  const decided = new Map<string, DecidedGate>([
    [gateKey(gate), { decision: "approve", decidedAt: AT }],
  ]);
  const kept = pruneDecided(decided, new Set([gateKey(gate)]));
  assertStrictEquals(kept, decided);
  assertEquals(kept.has(gateKey(gate)), true);
});

Deno.test("pruneDecided: the first listing without the gate lets it go", () => {
  const other = { runId: "run-2", stepName: "approval" };
  const decided = new Map<string, DecidedGate>([
    [gateKey(gate), { decision: "approve", decidedAt: AT }],
    [gateKey(other), { decision: "reject", decidedAt: AT }],
  ]);
  const kept = pruneDecided(decided, new Set([gateKey(other)]));
  assertEquals([...kept.keys()], [gateKey(other)]);
});

Deno.test("decidedGate: names who decided from the reply, and no one when it named no one", () => {
  assertEquals(
    decidedGate("approve", { data: { decidedBy: "user:alice" } }, AT),
    { decision: "approve", decidedBy: "user:alice", decidedAt: AT },
  );
  assertEquals(decidedGate("reject", { data: {} }, AT), {
    decision: "reject",
    decidedAt: AT,
  });
  assertEquals(decidedGate("approve", null, AT), {
    decision: "approve",
    decidedAt: AT,
  });
});

Deno.test("decidedLabel: says the decision and who made it", () => {
  assertEquals(
    decidedLabel({
      decision: "approve",
      decidedBy: "user:alice",
      decidedAt: AT,
    }),
    "Approved by user:alice",
  );
  assertEquals(decidedLabel({ decision: "reject", decidedAt: AT }), "Rejected");
});

Deno.test("decisionOutcome: says what happens to the run next", () => {
  assertEquals(
    decisionOutcome("approve", {
      data: { allGatesDecided: true, autoResumed: true },
    }),
    "serve is resuming the run",
  );
  assertEquals(
    decisionOutcome("approve", {
      data: { allGatesDecided: true, autoResumed: false },
    }),
    "the run waits for Resume under Awaiting resume",
  );
  assertEquals(
    decisionOutcome("approve", { data: { allGatesDecided: false } }),
    "other gates on this run are still pending",
  );
  assertEquals(decisionOutcome("reject", { data: {} }), "the run is rejected");
});

Deno.test("refusalMessage: a gate no longer listed reads as already decided, not as a failure", () => {
  const refusal =
    'Step "approval" is not awaiting approval in the suspended run';
  assertEquals(
    refusalMessage("approve", refusal, false),
    "This gate was already decided; the run is shown where it now is",
  );
  assertEquals(
    refusalMessage("approve", "Forbidden", true),
    "Approve failed: Forbidden",
  );
  assertEquals(
    refusalMessage("reject", "Forbidden", true),
    "Reject failed: Forbidden",
  );
});

Deno.test("decisionReason: trims, caps and drops a blank reason", () => {
  assertEquals(decisionReason("  checked the ticket \n"), "checked the ticket");
  assertEquals(decisionReason("   "), undefined);
  assertEquals(
    decisionReason("x".repeat(MAX_DECISION_REASON_LENGTH + 10))?.length,
    MAX_DECISION_REASON_LENGTH,
  );
});
