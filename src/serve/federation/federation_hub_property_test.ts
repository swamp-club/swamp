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
import fc from "fast-check";
import { sampleFingerprint } from "../../domain/serve/federation_test_helpers.ts";
import { InstanceId } from "../../domain/serve/instance_id.ts";
import { MemberCredential } from "../../domain/serve/member_credential.ts";
import { createTestHub } from "./federation_hub_test_helpers.ts";

const MINUTE = 60 * 1000;

type Command =
  | { kind: "join"; withOwnJoinId: boolean; replyLost: boolean }
  | { kind: "wait"; minutes: number }
  | { kind: "remove" };

const command: fc.Arbitrary<Command> = fc.oneof(
  fc.record({
    kind: fc.constant("join" as const),
    withOwnJoinId: fc.boolean(),
    replyLost: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("wait" as const),
    minutes: fc.integer({ min: 0, max: 40 }),
  }),
  fc.record({ kind: fc.constant("remove" as const) }),
);

Deno.test("FederationHub property: a token creates at most one member and only the newest credential checks in", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(command, { maxLength: 12 }),
      async (commands) => {
        const t = createTestHub();
        const { plaintext } = await t.hub.createToken("edge-1");
        const ownJoinId = crypto.randomUUID();
        const credentials: string[] = [];
        const memberIds = new Set<string>();
        let removed = false;
        for (const cmd of commands) {
          if (cmd.kind === "wait") {
            t.clock.now += cmd.minutes * MINUTE;
          } else if (cmd.kind === "remove") {
            if (memberIds.size > 0 && !removed) {
              await t.hub.removeMember("edge-1");
              removed = true;
            }
          } else {
            const outcome = await t.hub.join(
              plaintext,
              cmd.withOwnJoinId ? ownJoinId : crypto.randomUUID(),
              sampleFingerprint(),
            );
            if (outcome.kind === "joined") {
              assertEquals(removed, false);
              assertEquals(outcome.replayed, memberIds.size > 0);
              if (outcome.replayed) assertEquals(cmd.withOwnJoinId, true);
              memberIds.add(outcome.memberId);
              // a lost reply still issued this credential; the member never saw it
              credentials.push(outcome.credential);
              if (cmd.replyLost) continue;
            }
          }
          assertEquals(memberIds.size <= 1, true);
          assertEquals(
            t.members.calls.filter((c) => c.call.method === "join").length,
            memberIds.size,
          );
          for (const [i, wire] of credentials.entries()) {
            const outcome = await t.hub.checkIn(
              MemberCredential.parse(wire),
              InstanceId.create(crypto.randomUUID()),
              sampleFingerprint(),
            );
            const newest = i === credentials.length - 1;
            assertEquals(
              outcome.kind,
              newest && !removed ? "checked-in" : "unauthorized",
            );
          }
        }
      },
    ),
    { numRuns: 60 },
  );
});
