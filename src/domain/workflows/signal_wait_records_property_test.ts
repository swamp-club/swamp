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
import { SignalWait } from "./signal_wait.ts";
import {
  cancelledOutcome,
  decideSignal,
  decodeWaitOutcome,
  decodeWaitRegistration,
  encodeWaitRecord,
  normalizeWaitId,
  registrationOf,
  timedOutOutcome,
  type WaitOutcome,
  type WaitRegistration,
} from "./signal_wait_records.ts";
import { settledBy } from "./signal_wait_store.ts";
import { InMemorySignalWaitStore } from "./signal_wait_store_test_helpers.ts";
import { outcomeAt } from "./signal_wait_cleanup.ts";

const OPENED = new Date("2026-01-01T00:00:00.000Z");
const SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  required: ["verdict"],
  properties: { verdict: { type: "string" as const, enum: ["ship", "fix"] } },
};

const name = fc.string({ minLength: 1, maxLength: 12 });
const registrationArb: fc.Arbitrary<WaitRegistration> = fc.record({
  workflowId: name,
  workflowName: name,
  runId: fc.uuid(),
  jobName: name,
  stepName: name,
  timeout: fc.integer({ min: 1, max: 10_000_000 }),
}).map(({ timeout, ...place }) =>
  registrationOf(place, SignalWait.open(SCHEMA, timeout, OPENED), OPENED)
);

Deno.test("wait records: any registration and any outcome of it survive their stored form unchanged (property)", () => {
  fc.assert(
    fc.property(
      registrationArb,
      fc.constantFrom("ship", "fix"),
      name,
      (registration, verdict, submittedBy) => {
        assertEquals(
          decodeWaitRegistration(
            encodeWaitRecord(registration),
            registration.waitId,
          ),
          { kind: "found", record: registration },
        );
        const decision = decideSignal(
          registration,
          { verdict },
          submittedBy,
          OPENED,
        );
        assert(decision.accepted);
        const later = new Date(new Date(registration.deadline).getTime() + 1);
        for (
          const outcome of [
            decision.outcome,
            timedOutOutcome(registration, later),
            cancelledOutcome(registration, OPENED),
          ]
        ) {
          const stored = decodeWaitOutcome(
            encodeWaitRecord(outcome),
            registration.waitId,
          );
          assertEquals(stored, { kind: "found", record: outcome });
        }
      },
    ),
  );
});

Deno.test("wait records: no bytes read as a record of a wait unless they are that wait's valid record (property)", () => {
  fc.assert(
    fc.property(
      registrationArb,
      fc.oneof(
        fc.uint8Array({ maxLength: 64 }),
        fc.json().map((json) => new TextEncoder().encode(json)),
      ),
      (registration, bytes) => {
        for (
          const stored of [
            decodeWaitRegistration(bytes, registration.waitId),
            decodeWaitOutcome(bytes, registration.waitId),
          ]
        ) {
          // Never absent, and found only with the wait's own id.
          assert(stored.kind !== "absent");
          if (stored.kind === "found") {
            assertEquals(stored.record.waitId, registration.waitId);
          }
        }
      },
    ),
  );
});

Deno.test("normalizeWaitId: whatever is typed, the result is a lowercase UUID or nothing (property)", () => {
  fc.assert(
    fc.property(fc.oneof(fc.string(), fc.uuid()), (typed) => {
      const id = normalizeWaitId(typed);
      if (id !== undefined) {
        assert(/^[0-9a-f-]{36}$/.test(id));
        assertEquals(id, typed.trim().toLowerCase());
      }
    }),
  );
});

type Attempt = "signal" | "bad_signal" | "timeout" | "cancel" | "look_late";

Deno.test("signal wait: any ordering of signals, timeouts and cancels leaves one outcome, and only its writer is told it won (property)", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.constantFrom<Attempt>(
          "signal",
          "bad_signal",
          "timeout",
          "cancel",
          "look_late",
        ),
        { maxLength: 10 },
      ),
      async (attempts) => {
        const store = new InMemorySignalWaitStore();
        const registration = registrationOf(
          {
            workflowId: "wf",
            workflowName: "release",
            runId: "11111111-1111-4111-8111-111111111111",
            jobName: "main",
            stepName: "review",
          },
          SignalWait.open(SCHEMA, 60, OPENED),
          OPENED,
        );
        await store.register(registration);
        const late = new Date(new Date(registration.deadline).getTime() + 1);

        let first: WaitOutcome | undefined;
        let winners = 0;
        for (const attempt of attempts) {
          let tried: WaitOutcome | undefined;
          if (attempt === "signal" || attempt === "bad_signal") {
            const decision = decideSignal(
              registration,
              { verdict: attempt === "signal" ? "ship" : "nope" },
              "ada",
              OPENED,
            );
            // A refused payload never reaches the store.
            assertEquals(decision.accepted, attempt === "signal");
            if (decision.accepted) tried = decision.outcome;
          } else if (attempt === "timeout") {
            tried = timedOutOutcome(registration, late);
          } else if (attempt === "cancel") {
            tried = cancelledOutcome(registration, OPENED);
          } else {
            // Anyone who looks after the deadline settles an open wait.
            const seen = await outcomeAt(store, registration, late);
            assert(seen.kind === "found");
            first ??= seen.record;
            assertEquals(seen.record, first);
            continue;
          }
          if (!tried) continue;
          const stored = await store.settle(tried);
          assert(stored.kind === "found");
          first ??= stored.record;
          // Whatever was tried, what is stored is the first outcome.
          assertEquals(stored.record, first);
          if (settledBy(stored, tried)) winners++;
        }

        assertEquals(store.outcomes.size, first ? 1 : 0);
        // A signal is told it won only when its own receipt is stored.
        if (first?.kind === "accepted") assertEquals(winners, 1);
        assertEquals(await store.listOutcomes(), first ? [first] : []);
        // The registration is untouched by settling.
        assertEquals(await store.listRegistrations(), [registration]);
      },
    ),
  );
});
