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
import {
  ENROLLMENT_TOKEN_MODEL_TYPE,
  enrollmentTokenModel,
  EnrollmentTokenSchema,
} from "./enrollment_token_model.ts";
import { createInMemoryWorkerContext } from "./worker_test_helpers.ts";

const LIFETIME_MS = 60_000;

/** moves the stored token back in time, as if that much time had passed */
function advance(
  store: Map<string, Record<string, unknown>>,
  ms: number,
): void {
  const token = EnrollmentTokenSchema.parse(store.get("token-main"));
  const shift = (iso: string) => new Date(Date.parse(iso) - ms).toISOString();
  store.set("token-main", {
    ...token,
    createdAt: shift(token.createdAt),
    expiresAt: shift(token.expiresAt),
    ...(token.predecessor
      ? {
        predecessor: {
          ...token.predecessor,
          createdAt: shift(token.predecessor.createdAt),
          expiresAt: shift(token.predecessor.expiresAt),
        },
      }
      : {}),
  });
}

Deno.test("enrollmentTokenModel.rotate: a schedule one lifetime apart never lets the token lapse, however its runs jitter", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 5_000, max: LIFETIME_MS - 1_000 }),
      fc.array(fc.double({ min: 0, max: 0.9, noNaN: true }), {
        minLength: 2,
        maxLength: 12,
      }),
      async (leadMs, jitterFractions) => {
        const harness = createInMemoryWorkerContext(
          ENROLLMENT_TOKEN_MODEL_TYPE,
          "ci-runner-3",
        );
        await enrollmentTokenModel.methods.mint.execute(
          { durationMs: LIFETIME_MS, vaultName: "local", maxEnrollments: 1 },
          harness.context,
        );
        // each run is late by up to 90% of the first run's lead; the ticks
        // themselves are one lifetime apart
        const jitters = jitterFractions.map((f) => Math.floor(f * leadMs));
        let previousJitter = 0;
        for (const [k, jitter] of jitters.entries()) {
          const step = k === 0
            ? LIFETIME_MS - leadMs + jitter
            : LIFETIME_MS + jitter - previousJitter;
          previousJitter = jitter;
          advance(harness.store, step);
          const before = EnrollmentTokenSchema.parse(
            harness.store.get("token-main"),
          );
          assert(
            Date.parse(before.expiresAt) > Date.now(),
            `run ${k} found the token expired`,
          );

          await enrollmentTokenModel.methods.rotate.execute(
            {},
            harness.context,
          );

          const after = EnrollmentTokenSchema.parse(
            harness.store.get("token-main"),
          );
          assertEquals(after.lifetimeMs, LIFETIME_MS);
          assertEquals(
            Date.parse(after.expiresAt) - Date.parse(before.expiresAt),
            LIFETIME_MS,
          );
        }
      },
    ),
    { numRuns: 50 },
  );
});
