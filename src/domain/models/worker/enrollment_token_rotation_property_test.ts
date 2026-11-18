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
  rotationCarryOverCapMs,
} from "./enrollment_token_model.ts";
import {
  advanceTokenClock,
  createInMemoryWorkerContext,
} from "./worker_test_helpers.ts";

const LIFETIME_MS = 60_000;

async function mint() {
  const harness = createInMemoryWorkerContext(
    ENROLLMENT_TOKEN_MODEL_TYPE,
    "ci-runner-3",
  );
  await enrollmentTokenModel.methods.mint.execute(
    { durationMs: LIFETIME_MS, vaultName: "local", maxEnrollments: 1 },
    harness.context,
  );
  return harness;
}

Deno.test("enrollmentTokenModel.rotate: a schedule one lifetime apart never lets the token lapse while runs are late by less than the carried-over margin", async () => {
  const capMs = rotationCarryOverCapMs(LIFETIME_MS);
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 5_000, max: LIFETIME_MS - 1_000 }),
      fc.array(fc.double({ min: 0, max: 0.9, noNaN: true }), {
        minLength: 2,
        maxLength: 12,
      }),
      async (leadMs, jitterFractions) => {
        const harness = await mint();
        const marginMs = Math.min(leadMs, capMs);
        const jitters = jitterFractions.map((f) => Math.floor(f * marginMs));
        let previousJitter = 0;
        for (const [k, jitter] of jitters.entries()) {
          advanceTokenClock(
            harness.store,
            k === 0
              ? LIFETIME_MS - leadMs + jitter
              : LIFETIME_MS + jitter - previousJitter,
          );
          previousJitter = jitter;
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
        }
      },
    ),
    { numRuns: 50 },
  );
});

Deno.test("enrollmentTokenModel.rotate: however often it runs, a default rotation never leaves more than the lifetime plus the cap", async () => {
  const capMs = rotationCarryOverCapMs(LIFETIME_MS);
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 0, max: LIFETIME_MS - 1 }), {
        minLength: 1,
        maxLength: 20,
      }),
      async (intervals) => {
        const harness = await mint();
        for (const interval of intervals) {
          advanceTokenClock(harness.store, interval);
          await enrollmentTokenModel.methods.rotate.execute(
            {},
            harness.context,
          );
          const after = EnrollmentTokenSchema.parse(
            harness.store.get("token-main"),
          );
          assert(
            Date.parse(after.expiresAt) - Date.parse(after.createdAt) <=
              LIFETIME_MS + capMs,
          );
        }
      },
    ),
    { numRuns: 50 },
  );
});
