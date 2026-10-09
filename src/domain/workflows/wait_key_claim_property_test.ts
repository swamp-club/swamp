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
import { isWaitKey, WAIT_KEY_PATTERN } from "./signal_wait.ts";
import { cancelledOutcome } from "./signal_wait_records.ts";
import { InMemorySignalWaitStore } from "./signal_wait_store_test_helpers.ts";
import {
  claimWaitKey,
  decideKeyHolder,
  decodeWaitKeyRecord,
  encodeWaitKeyRecord,
  releaseKeyClaims,
  waitKeyAddressFromKey,
  type WaitKeyClaim,
  type WaitKeyRecord,
  waitKeyRecordKey,
  waitRefOfClaim,
} from "./wait_key_claim.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const DEADLINE = "2026-01-01T01:00:00.000Z";

const keyArb = fc.stringMatching(WAIT_KEY_PATTERN).filter(isWaitKey);
const workflowIdArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/)
  .filter((id) => id !== "." && id !== "..");
const addressArb = {
  workflowId: workflowIdArb,
  key: keyArb,
  generation: fc.integer({ min: 1, max: 1_000_000 }),
  recordedAt: fc.constant(NOW.toISOString()),
};
const claimArb: fc.Arbitrary<WaitKeyClaim> = fc.record({
  kind: fc.constant("claim" as const),
  ...addressArb,
  waitId: fc.uuid(),
  runId: fc.uuid(),
  jobName: fc.string({ minLength: 1, maxLength: 32 }),
  stepName: fc.string({ minLength: 1, maxLength: 32 }),
  deadline: fc.constant(DEADLINE),
});
const recordArb: fc.Arbitrary<WaitKeyRecord> = fc.oneof(
  claimArb,
  fc.record({ kind: fc.constant("release" as const), ...addressArb }),
);

Deno.test("wait key record: any record survives its stored form and is found only under its own address (property)", () => {
  fc.assert(
    fc.property(recordArb, (record) => {
      const bytes = encodeWaitKeyRecord(record);
      assertEquals(decodeWaitKeyRecord(bytes, record), {
        kind: "found",
        record,
      });
      assertEquals(waitKeyAddressFromKey(waitKeyRecordKey(record)), {
        workflowId: record.workflowId,
        key: record.key,
        generation: record.generation,
      });
      assertEquals(
        decodeWaitKeyRecord(bytes, {
          ...record,
          generation: record.generation + 1,
        }).kind,
        "unreadable",
      );
    }),
  );
});

Deno.test("wait key: a store key is one path below the family for every valid key, and no invalid key builds one (property)", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 80 }), (key) => {
      const at = { workflowId: "wf", key, generation: 1 };
      if (isWaitKey(key)) {
        assertEquals(waitKeyRecordKey(at).split("/").length, 4);
      } else {
        let threw = false;
        try {
          waitKeyRecordKey(at);
        } catch {
          threw = true;
        }
        assert(threw, `built a store key from ${JSON.stringify(key)}`);
      }
    }),
  );
});

Deno.test("decideKeyHolder: holds exactly for a claim with no outcome (property)", () => {
  fc.assert(
    fc.property(
      fc.option(recordArb, { nil: undefined }),
      fc.constantFrom("absent", "found", "unreadable"),
      (highest, outcomeKind) => {
        const outcome = outcomeKind === "found" && highest?.kind === "claim"
          ? {
            kind: "found" as const,
            record: cancelledOutcome(waitRefOfClaim(highest), NOW),
          }
          : outcomeKind === "unreadable"
          ? { kind: "unreadable" as const }
          : { kind: "absent" as const };
        const holding = decideKeyHolder(highest, outcome);
        assertEquals(
          holding.held,
          highest?.kind === "claim" && outcome.kind === "absent",
        );
        if (holding.held) assertEquals(holding.claim, highest);
      },
    ),
  );
});

// Claims, settlements and collections of one key in any order: at most one
// wait is ever open under the key, a claim is taken exactly when none is,
// and no generation is used twice.
const opArb = fc.oneof(
  fc.record({ op: fc.constant("claim" as const) }),
  fc.record({ op: fc.constant("settle" as const) }),
  fc.record({
    op: fc.constant("collect" as const),
    pick: fc.nat({ max: 20 }),
  }),
  fc.record({ op: fc.constant("sweep" as const) }),
);

Deno.test("wait key: over any order of claims, settlements and collections one wait holds the key at a time and no generation is reused (property)", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(opArb, { maxLength: 40 }), async (ops) => {
      const store = new InMemorySignalWaitStore();
      let open: WaitKeyClaim | undefined;
      const ended: WaitKeyClaim[] = [];
      const generations = new Set<number>();
      for (const step of ops) {
        if (step.op === "claim") {
          const result = await claimWaitKey(store, {
            workflowId: "wf",
            key: "verdict",
            waitId: crypto.randomUUID(),
            runId: crypto.randomUUID(),
            jobName: "main",
            stepName: "review",
            deadline: DEADLINE,
          }, NOW);
          assertEquals(result.kind, open ? "held" : "acquired");
          if (result.kind === "acquired") {
            assert(!generations.has(result.claim.generation));
            generations.add(result.claim.generation);
            open = result.claim;
          } else if (result.kind === "held") {
            assertEquals(result.claim, open);
          }
        } else if (step.op === "settle" && open) {
          await store.settle(cancelledOutcome(waitRefOfClaim(open), NOW));
          ended.push(open);
          open = undefined;
        } else if (step.op === "collect" && ended.length > 0) {
          // A run that ended is deleted: its claim goes, then its outcome.
          const [gone] = ended.splice(step.pick % ended.length, 1);
          await releaseKeyClaims(store, (c) => c.runId === gone.runId, NOW);
          await store.removeOutcome(gone.waitId);
        } else if (step.op === "sweep") {
          await releaseKeyClaims(store, () => false, NOW);
        }
        const highest = await store.highestKeyRecord("wf", "verdict");
        if (open) {
          assert(highest.kind === "found");
          assertEquals(highest.record, open);
        }
      }
    }),
    { numRuns: 200 },
  );
});
