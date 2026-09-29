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
  type EnrollmentToken,
  enrollmentTokenBindingVerdict,
} from "./enrollment_token_model.ts";

const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const arbInstant = fc.integer({ min: 0, max: 2 * YEAR_MS }).map((offset) =>
  new Date(BASE_MS + offset).toISOString()
);

const arbToken: fc.Arbitrary<EnrollmentToken | null> = fc.option(
  fc.record({
    state: fc.constantFrom("unused", "enrolled", "expired", "revoked"),
    createdAt: arbInstant,
    expiresAt: arbInstant,
  }).map((fields) => ({
    name: "ci-runner-3",
    vaultName: "local",
    secretKey: "worker-token-ci-runner-3",
    maxEnrollments: 1,
    bindings: [],
    ...fields,
  } as EnrollmentToken)),
  { nil: null },
);

Deno.test("enrollmentTokenBindingVerdict: keeps a worker exactly when its record exists, is not revoked, and is the bound mint", () => {
  fc.assert(
    fc.property(
      arbToken,
      // Draw the bound mint from the token (same mint), freely, or unknown.
      fc.constantFrom("same", "other", "unknown"),
      arbInstant,
      (token, mintKind, otherMint) => {
        const boundCreatedAt = mintKind === "unknown"
          ? null
          : mintKind === "same" && token
          ? token.createdAt
          : otherMint;
        const verdict = enrollmentTokenBindingVerdict(token, boundCreatedAt);

        const shouldKeep = token !== null &&
          token.state !== "revoked" &&
          (boundCreatedAt === null || token.createdAt === boundCreatedAt);
        assertEquals(verdict.keep, shouldKeep);
      },
    ),
  );
});

Deno.test("enrollmentTokenBindingVerdict: a revoked record is never kept, whatever the mint", () => {
  fc.assert(
    fc.property(
      arbToken.filter((t) => t !== null).map((t) => ({
        ...t!,
        state: "revoked" as const,
      })),
      fc.option(arbInstant, { nil: null }),
      (token, boundCreatedAt) => {
        assertEquals(
          enrollmentTokenBindingVerdict(token, boundCreatedAt),
          { keep: false, cause: "revoked" },
        );
      },
    ),
  );
});
