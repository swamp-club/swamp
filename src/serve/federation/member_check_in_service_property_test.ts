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
import { waitFor } from "@swamp-club/swamp-testing";
import fc from "fast-check";
import type { CheckInReply, HubOutcome } from "./hub_client.ts";
import {
  AtomicMemoryStore,
  FakeHub,
  memberNode,
} from "./member_check_in_test_helpers.ts";

const outcomeArb: fc.Arbitrary<HubOutcome<CheckInReply> | "ok"> = fc
  .constantFrom(
    "ok" as const,
    { kind: "unauthorized" } as const,
    { kind: "conflict", error: "conflict" } as const,
    { kind: "rate_limited", retryAfterSeconds: 0 } as const,
    { kind: "server_error", status: 503 } as const,
    { kind: "unreachable" } as const,
  );

const phaseArb = fc.record({
  token: fc.constantFrom("fresh", "used", "none"),
  otherHub: fc.boolean(),
  outcomes: fc.array(outcomeArb, { maxLength: 4 }),
});

const SETTLED = new Set(["refused", "mismatched", "unjoined"]);

// each phase is one serve process: start, let the scripted replies play out, stop
Deno.test("MemberCheckInService property: across restarts and any check-in outcomes, a credential is stored exactly while the link is joined or mismatched", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(phaseArb, { minLength: 1, maxLength: 4 }),
      async (phases) => {
        const store = new AtomicMemoryStore();
        const hub = new FakeHub();
        hub.intervalSeconds = 0.005;
        const used = hub.mintToken();
        hub.tokens.delete(used);
        for (const phase of phases) {
          const token = phase.token === "fresh"
            ? hub.mintToken()
            : phase.token === "used"
            ? used
            : undefined;
          const node = await memberNode(store, hub, {
            ...(token !== undefined ? { token } : {}),
            hubUrl: phase.otherHub
              ? "https://other.example.com"
              : "https://hub.example.com",
          });
          hub.scriptedCheckIns.length = 0;
          for (const outcome of phase.outcomes) {
            if (outcome !== "ok") hub.scriptedCheckIns.push(outcome);
          }
          const checkInsBefore = hub.checkIns.length;
          node.service.start();
          try {
            await waitFor(async () => {
              const state = (await node.links.readLink()).state;
              const instance = await node.links.readInstance(node.instanceId);
              return (SETTLED.has(state) && instance?.result !== null) ||
                (hub.scriptedCheckIns.length === 0 &&
                  hub.checkIns.length > checkInsBefore);
            }, "the phase to settle");
          } finally {
            await node.service.stop();
          }
          const link = await node.links.readLink();
          const credential = await node.credentials.read();
          assertEquals(credential !== undefined, link.holdsCredential);
          if (credential !== undefined) {
            assertEquals(credential.memberId, link.memberId);
          }
        }
      },
    ),
    { numRuns: 30 },
  );
});
