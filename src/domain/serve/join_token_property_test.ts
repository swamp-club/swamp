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
import {
  JoinToken,
  JoinTokenError,
  MAX_JOIN_TOKEN_DURATION_MS,
} from "./join_token.ts";
import { MemberName } from "./member_name.ts";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");

type Command =
  | { kind: "use"; withTrueSecret: boolean; at: number }
  | { kind: "revoke"; at: number };

const command = (durationMs: number): fc.Arbitrary<Command> =>
  fc.oneof(
    fc.record({
      kind: fc.constant("use" as const),
      withTrueSecret: fc.boolean(),
      at: fc.integer({ min: 0, max: durationMs * 2 }),
    }),
    fc.record({
      kind: fc.constant("revoke" as const),
      at: fc.integer({ min: 0, max: durationMs * 2 }),
    }),
  );

Deno.test("JoinToken property: a token admits at most one join, never after expiry or revoke", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: MAX_JOIN_TOKEN_DURATION_MS }).chain((d) =>
        fc.tuple(fc.constant(d), fc.array(command(d), { maxLength: 12 }))
      ),
      ([durationMs, commands]) => {
        const name = MemberName.create("m");
        const { token: minted, plaintext } = JoinToken.mint(
          name,
          durationMs,
          NOW,
        );
        const wrong = JoinToken.mint(name, durationMs, NOW).plaintext;
        let token = minted;
        let joins = 0;
        for (const cmd of commands) {
          const at = NOW + cmd.at;
          const before = token.stateAt(at);
          if (cmd.kind === "use") {
            const used = JoinToken.use(
              token,
              cmd.withTrueSecret ? plaintext : wrong,
              crypto.randomUUID(),
              at,
            );
            if (used.ok) {
              joins++;
              assertEquals(before, "unused");
              assertEquals(cmd.withTrueSecret, true);
              assertEquals(at < NOW + durationMs, true);
              token = used.token;
            }
          } else {
            try {
              token = token.revoke(at);
              assertEquals(before, "unused");
            } catch (error) {
              if (!(error instanceof JoinTokenError)) throw error;
              assertEquals(before !== "unused", true);
            }
          }
          assertEquals(joins <= 1, true);
          if (token.state !== "unused") {
            assertEquals(token.stateAt(at), token.state);
          }
        }
      },
    ),
  );
});

Deno.test("JoinToken property: a terminal state never changes", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 10_000 }), (later) => {
      const { token, plaintext } = JoinToken.mint(
        MemberName.create("m"),
        1000,
        NOW,
      );
      const revoked = token.revoke(NOW);
      assertEquals(
        JoinToken.use(revoked, plaintext, crypto.randomUUID(), NOW + later).ok,
        false,
      );
      assertEquals(revoked.stateAt(NOW + later), "revoked");
      assertEquals(revoked.expire(NOW + later), undefined);
    }),
  );
});
