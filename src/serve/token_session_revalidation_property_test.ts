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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import type { ServerToken } from "../domain/models/access/server_token_model.ts";
import { tokenSessionVerdict } from "./token_session_revalidation_service.ts";

const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const arbInstant = fc.integer({ min: 0, max: 2 * YEAR_MS }).map((offset) =>
  new Date(BASE_MS + offset).toISOString()
);

const arbToken: fc.Arbitrary<ServerToken | null> = fc.option(
  fc.record({
    state: fc.constantFrom("active", "expired", "revoked"),
    createdAt: arbInstant,
    expiresAt: arbInstant,
  }).map((fields) => ({
    name: "tok",
    principalId: "user:alice",
    principalEmail: "alice@example.com",
    collectives: [],
    groups: [],
    vaultName: "_token-secrets",
    secretKey: "server-token-tok",
    ...fields,
  } as ServerToken)),
  { nil: null },
);

Deno.test("tokenSessionVerdict: keeps a session exactly when its own mint is active and unexpired", () => {
  fc.assert(
    fc.property(
      arbToken,
      // Draw the session's mint either from the token (same mint) or freely.
      fc.boolean(),
      arbInstant,
      arbInstant,
      (token, sameMint, otherMint, now) => {
        const sessionCreatedAt = sameMint && token
          ? token.createdAt
          : otherMint;
        const nowMs = Date.parse(now);
        const verdict = tokenSessionVerdict(token, sessionCreatedAt, nowMs);

        const shouldKeep = token !== null &&
          token.state === "active" &&
          token.createdAt === sessionCreatedAt &&
          Date.parse(token.expiresAt) > nowMs;
        assertEquals(verdict.keep, shouldKeep);
      },
    ),
  );
});

Deno.test("tokenSessionVerdict: every close uses 4003, or 4002 for expiry only", () => {
  fc.assert(
    fc.property(arbToken, arbInstant, arbInstant, (token, mint, now) => {
      const verdict = tokenSessionVerdict(token, mint, Date.parse(now));
      if (verdict.keep) return;
      assert(
        verdict.cause === "expired"
          ? verdict.code === 4002
          : verdict.code === 4003,
        `cause ${verdict.cause} closed with ${verdict.code}`,
      );
    }),
  );
});
